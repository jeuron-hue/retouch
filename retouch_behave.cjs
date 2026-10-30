#!/usr/bin/env node
// retouch_behave.cjs: behavioural tests in real Chromium (Playwright).
//
// Canvas, image decoding and service workers only behave properly in a real
// browser, so this suite serves the repo on localhost and drives the app.
// Every fixture is synthetic and built here (gradients, flat colours, files
// with planted EXIF/XMP/IPTC/GPS), so results can be checked as numbers.
// Video tests build their clips in the page with WebCodecs (coloured frames and a
// tone) and read the exports back with the MP4 reader in retouch_checks.cjs.
// Tests that need a real person (phase 3 onwards) read reference/test-images/
// and skip cleanly when it is absent. The background tests swap the model for a
// stand-in that marks pixels of a known colour, so the rest of the pipeline can be
// checked as numbers; one test runs the real model, offline.
//
// Run:            node retouch_behave.cjs
// Core only:      RETOUCH_ONLY=core node retouch_behave.cjs   (used by retouch_mutate.sh)
// Other page:     RETOUCH_HTML=/path/to/mutant.html node retouch_behave.cjs
// Filter by name: RETOUCH_GREP=crop node retouch_behave.cjs

'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { findImageMetadata, imageFormat, parseMp4, findVideoMetadata } = require('./retouch_checks.cjs');

const ROOT = __dirname;
const PAGE_FILE = process.env.RETOUCH_HTML ? path.resolve(process.env.RETOUCH_HTML) : path.join(ROOT, 'retouch.html');
const ONLY_CORE = process.env.RETOUCH_ONLY === 'core';
const GREP = process.env.RETOUCH_GREP ? new RegExp(process.env.RETOUCH_GREP, 'i') : null;
const REFERENCE = path.join(ROOT, 'reference', 'test-images');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  const { execSync } = require('child_process');
  const globalRoot = execSync('npm root -g').toString().trim();
  return require(path.join(globalRoot, 'playwright'));
}

/* ---------- Synthetic fixtures ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// px(x, y) -> [r, g, b, a]. Or opts.flat = [r, g, b] for a fast single-colour image.
function makePng(w, h, px, extraChunks = [], opts = {}) {
  const alpha = !opts.flat;
  const bpp = alpha ? 4 : 3;
  const stride = w * bpp + 1;
  const raw = Buffer.alloc(stride * h);
  if (opts.flat) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < w; x++) { row[1 + x * 3] = opts.flat[0]; row[2 + x * 3] = opts.flat[1]; row[3 + x * 3] = opts.flat[2]; }
    for (let y = 0; y < h; y++) row.copy(raw, y * stride);
  } else {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = px(x, y), o = y * stride + 1 + x * 4;
      raw[o] = p[0]; raw[o + 1] = p[1]; raw[o + 2] = p[2]; raw[o + 3] = p[3] === undefined ? 255 : p[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr), ...extraChunks,
    pngChunk('IDAT', zlib.deflateSync(raw, { level: opts.flat ? 1 : 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// The gradient fixture: pixel (x, y) is (x, y, 77). Odd sizes on purpose.
const GW = 241, GH = 181;
const gradient = () => makePng(GW, GH, (x, y) => [x, y, 77, 255]);

// A big-endian TIFF block with Orientation and a GPS directory.
function tiffBlock({ orientation = 1, gps = true } = {}) {
  const entries0 = [[0x0112, 3, 1, orientation << 16]];
  if (gps) entries0.push([0x8825, 4, 1, 0]);
  const ifd0Size = 2 + entries0.length * 12 + 4;
  const gpsOffset = 8 + ifd0Size;
  if (gps) entries0[1][3] = gpsOffset;
  const gpsEntries = [[0x0000, 1, 4, 0x02020000], [0x0001, 2, 2, 0x4E000000]]; // version 2.2, LatitudeRef N
  const size = 8 + ifd0Size + (gps ? 2 + gpsEntries.length * 12 + 4 : 0);
  const b = Buffer.alloc(size);
  b.write('MM', 0, 'latin1'); b.writeUInt16BE(42, 2); b.writeUInt32BE(8, 4);
  const writeIfd = (at, list) => {
    b.writeUInt16BE(list.length, at);
    list.forEach(([tag, type, count, value], i) => {
      const e = at + 2 + i * 12;
      b.writeUInt16BE(tag, e); b.writeUInt16BE(type, e + 2); b.writeUInt32BE(count, e + 4); b.writeUInt32BE(value >>> 0, e + 8);
    });
    b.writeUInt32BE(0, at + 2 + list.length * 12);
  };
  writeIfd(8, entries0);
  if (gps) writeIfd(gpsOffset, gpsEntries);
  return b;
}

const XMP_PACKET = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="1,17.0N"/></rdf:RDF></x:xmpmeta>';

function jpegSeg(marker, payload) {
  const h = Buffer.alloc(4); h[0] = 0xFF; h[1] = marker; h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
}

// Plant EXIF (with GPS), XMP, IPTC and a comment in a JPEG straight after SOI.
function plantJpegMetadata(jpeg, { orientation = 1 } = {}) {
  const exif = jpegSeg(0xE1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiffBlock({ orientation })]));
  const xmp = jpegSeg(0xE1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(XMP_PACKET)]));
  const caption = Buffer.from('Test caption, Singapore');
  const iptcRec = Buffer.concat([Buffer.from([0x1C, 0x02, 0x78, 0x00, caption.length]), caption]);
  const res = Buffer.alloc(4); res.writeUInt32BE(iptcRec.length);
  const iptc = jpegSeg(0xED, Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), Buffer.from('8BIM\x04\x04\0\0', 'latin1'), res, iptcRec]));
  const com = jpegSeg(0xFE, Buffer.from('private comment'));
  // Ultra HDR: an MPF index in APP2, and a second JPEG (the gain map, with its own EXIF) after EOI.
  const mpf = jpegSeg(0xE2, Buffer.concat([Buffer.from('MPF\0', 'latin1'), Buffer.alloc(16, 1)]));
  const gainMap = Buffer.concat([Buffer.from([0xFF, 0xD8]), exif, Buffer.from([0xFF, 0xD9])]);
  return Buffer.concat([jpeg.subarray(0, 2), exif, xmp, iptc, com, mpf, jpeg.subarray(2), gainMap]);
}

function plantPngMetadata(png) {
  const extra = [
    pngChunk('tEXt', Buffer.from('Comment\0private comment', 'latin1')),
    pngChunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), Buffer.from(XMP_PACKET)])),
    pngChunk('eXIf', tiffBlock()),
    pngChunk('tIME', Buffer.from([0x07, 0xEA, 10, 9, 12, 0, 0])),
  ];
  // Insert after IHDR (8 byte signature + 25 byte IHDR chunk).
  return Buffer.concat([png.subarray(0, 33), ...extra, png.subarray(33)]);
}

function riffChunk(type, data) {
  const h = Buffer.alloc(8); h.write(type, 0, 'latin1'); h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function plantWebpMetadata(webp, w, h) {
  // Chrome may already write the extended (VP8X) layout; reuse its header if so.
  const chunks = [];
  for (let i = 12; i + 8 <= webp.length;) {
    const len = webp.readUInt32LE(i + 4);
    chunks.push({ type: webp.toString('latin1', i, i + 4), data: webp.subarray(i + 8, i + 8 + len) });
    i += 8 + len + (len & 1);
  }
  let vp8x = chunks.find((c) => c.type === 'VP8X');
  if (!vp8x) {
    const d = Buffer.alloc(10);
    d.writeUIntLE(w - 1, 4, 3); d.writeUIntLE(h - 1, 7, 3);
    vp8x = { type: 'VP8X', data: d };
    chunks.unshift(vp8x);
  }
  vp8x.data = Buffer.from(vp8x.data);
  vp8x.data[0] |= 0x08 | 0x04;
  chunks.push({ type: 'EXIF', data: tiffBlock() }, { type: 'XMP ', data: Buffer.from(XMP_PACKET) });
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks.map((c) => riffChunk(c.type, c.data))]);
  const head = Buffer.alloc(8); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/* ---------- Static server ---------- */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream' };
const server = { swVariant: null };
function startServer() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      const file = p === '/retouch.html' ? PAGE_FILE : path.join(ROOT, p);
      if (!file.startsWith(ROOT) && file !== PAGE_FILE) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      let body = fs.readFileSync(file);
      if (p === '/sw.js' && server.swVariant) body = Buffer.from(body.toString().replace(/const CACHE_VERSION = '[^']+'/, "const CACHE_VERSION = '" + server.swVariant + "'"));
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

/* ---------- Harness ---------- */

const tests = [];
const test = (name, fn, opts = {}) => tests.push({ name, fn, ...opts });
class Skip extends Error {}
const skip = (why) => { throw new Skip(why); };
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, tol, msg) { assert(Math.abs(a - b) <= tol, msg + ': got ' + a + ', want ' + b + ' +/- ' + tol); }
function samePx(got, want, tol, msg) {
  for (let i = 0; i < want.length; i++) {
    if (Math.abs(got[i] - want[i]) > tol) throw new Error(msg + ': got [' + got.slice(0, 4) + '], want [' + want + ']');
  }
}

let browser, BASE;
const foreignRequests = [];

async function newApp({ sw = false, init = null, viewport = { width: 412, height: 915 } } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: sw ? 'allow' : 'block', acceptDownloads: true });
  ctx.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol === 'blob:' || u.protocol === 'data:') return;
    if (u.origin !== BASE && u.hostname !== 'csp-probe.example') foreignRequests.push(r.url());
  });
  for (const f of [].concat(init || [])) await ctx.addInitScript(f);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  // MediaPipe prints one INFO line through console.error when it starts; that is not a fault.
  page.on('console', (m) => { if (m.type() === 'error' && !/^INFO: Created TensorFlow Lite XNNPACK delegate/.test(m.text())) page.errors.push('console: ' + m.text()); });
  await page.goto(BASE + '/retouch.html');
  await page.waitForFunction(() => window.retouch && window.retouch.app);
  return { ctx, page };
}

// Load bytes through the real file picker and wait until the app has them.
async function load(page, buffer, name = 'fixture.png', mimeType = 'image/png') {
  await page.evaluate(() => { window.__before = window.retouch.app.edits; });
  await page.setInputFiles('#file', { name, mimeType, buffer });
  await page.waitForFunction(() => window.retouch.app.edits && window.retouch.app.edits !== window.__before && window.retouch.app.busyCount === 0);
}
const dims = (page) => page.evaluate(() => { const c = retouch.app.edits.current; return [c.width, c.height]; });
const px = (page, x, y, which = 'current') => page.evaluate(([x, y, which]) => retouch.readPixels(retouch.app.edits[which], x, y, 1, 1), [x, y, which]);
const idle = (page) => page.waitForFunction(() => window.retouch.app.busyCount === 0);
async function applyTool(page, tool) {
  await page.click('.sheet-panel[data-tool="' + tool + '"] [data-apply]');
  await page.waitForFunction(() => !window.retouch.app.tool && window.retouch.app.busyCount === 0);
}
const commitCrop = (page, p) => page.evaluate((p) => retouch.commit('Crop', (src) => retouch.core.renderCrop(src, p)), p);
// Rect for a whole-pixel crop box, in the centred frame the app uses.
const boxRect = (L, T, W, H, w0, h0) => ({ cx: L + W / 2 - w0 / 2, cy: T + H / 2 - h0 / 2, w: W, h: H });
const P0 = { quarter: 0, flipH: false, flipV: false, theta: 0 };

// Independent check that a crop rectangle sits inside the rotated base image.
function rectInside(r, w0, h0, theta, slack = 1e-6) {
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const x = r.cx + sx * r.w / 2, y = r.cy + sy * r.h / 2;
    const u = Math.cos(theta) * x + Math.sin(theta) * y, v = -Math.sin(theta) * x + Math.cos(theta) * y;
    if (Math.abs(u) > w0 / 2 + slack || Math.abs(v) > h0 / 2 + slack) return false;
  }
  return true;
}

/* ============================================================
   Tests
   ============================================================ */

test('working-size ceiling and fit maths', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(() => ({
    max: retouch.MAX_WORKING_PIXELS,
    big: retouch.core.fitWithin(8160, 6144, retouch.MAX_WORKING_PIXELS),
    pixel: retouch.core.fitWithin(4080, 3072, retouch.MAX_WORKING_PIXELS),
    square: retouch.core.fitWithin(5000, 5000, retouch.MAX_WORKING_PIXELS),
    odd: retouch.core.fitWithin(9001, 3001, retouch.MAX_WORKING_PIXELS),
  }));
  assert(r.max === 4080 * 3072, 'ceiling should be 4080 x 3072, is ' + r.max);
  assert(r.big.w === 4080 && r.big.h === 3072 && r.big.scaled, '50 MP should fit to 4080 x 3072, got ' + JSON.stringify(r.big));
  assert(r.pixel.w === 4080 && r.pixel.h === 3072 && !r.pixel.scaled, 'a 12.5 MP photo must not be scaled');
  for (const [k, v] of [['square', r.square], ['odd', r.odd]]) {
    assert(v.w * v.h <= r.max, k + ' over the ceiling');
    assert(v.w * v.h > r.max * 0.995, k + ' scaled further than needed');
  }
  near(r.odd.w / r.odd.h, 9001 / 3001, 0.002, 'ratio kept');
  await ctx.close();
}, { core: true });

test('open PNG: full size, pixels intact, no notice', async () => {
  const { ctx, page } = await newApp();
  await load(page, gradient());
  const d = await dims(page);
  assert(d[0] === GW && d[1] === GH, 'dims ' + d);
  samePx(await px(page, 0, 0), [0, 0, 77, 255], 0, 'top-left');
  samePx(await px(page, 240, 180), [240, 180, 77, 255], 0, 'bottom-right');
  assert(!(await page.$('.notice[data-id="downscale"]')), 'no downscale notice expected');
  assert(!(await page.isVisible('#empty')), 'empty state should hide');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
}, { core: true });

test('EXIF orientation is applied on load, then dropped', async () => {
  const { ctx, page } = await newApp();
  // 40 x 20: left half red, right half blue. Orientation 6 means "rotate 90 clockwise to view".
  const jpeg = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 40; c.height = 20;
    const x = c.getContext('2d'); x.fillStyle = '#FF0000'; x.fillRect(0, 0, 20, 20); x.fillStyle = '#0000FF'; x.fillRect(20, 0, 20, 20);
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }));
  await load(page, plantJpegMetadata(jpeg, { orientation: 6 }), 'rotated.jpg', 'image/jpeg');
  const d = await dims(page);
  assert(d[0] === 20 && d[1] === 40, 'expected 20 x 40 after orientation, got ' + d);
  samePx(await px(page, 10, 5), [255, 0, 0], 40, 'top should be red (was left)');
  samePx(await px(page, 10, 34), [0, 0, 255], 40, 'bottom should be blue (was right)');
  await ctx.close();
}, { core: true });

test('50 MP photo is scaled to the ceiling with a visible notice', async () => {
  const { ctx, page } = await newApp();
  await load(page, makePng(8160, 6144, null, [], { flat: [200, 120, 40] }), 'PXL_50MP.png');
  const d = await dims(page);
  assert(d[0] === 4080 && d[1] === 3072, 'expected 4080 x 3072, got ' + d);
  samePx(await px(page, 2000, 1500), [200, 120, 40, 255], 2, 'colour kept');
  const n = await page.textContent('.notice[data-id="downscale"]');
  assert(n && n.includes('8160 × 6144') && n.includes('4080 × 3072'), 'notice text: ' + n);
  assert(await page.isVisible('.notice[data-id="downscale"]'), 'notice must be visible');
  await ctx.close();
}, { core: true });

test('undecodable file (HEIC) gets a plain message and changes nothing', async () => {
  const { ctx, page } = await newApp();
  await load(page, gradient());
  const garbage = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(2000, 7)]);
  await page.setInputFiles('#file', { name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: garbage });
  await page.waitForSelector('.notice.fail[data-id="open"]');
  const t = await page.textContent('.notice.fail[data-id="open"]');
  assert(/HEIC photo could not be opened/.test(t), 'message: ' + t);
  const d = await dims(page);
  assert(d[0] === GW && d[1] === GH, 'previous photo should stay open');
  await page.setInputFiles('#file', { name: 'DSC0001.DNG', mimeType: 'image/x-adobe-dng', buffer: garbage });
  await page.waitForFunction(() => /RAW files are not supported/.test(document.querySelector('.notice[data-id="open"]')?.textContent || ''));
  await ctx.close();
});

test('crop geometry: max rect, validity, clamping (independent check)', async () => {
  const { ctx, page } = await newApp();
  const cases = [];
  for (const [w0, h0] of [[241, 181], [181, 241], [4080, 3072]]) {
    for (const deg of [0, 3, -10, 27.5, 45]) {
      for (const R of [null, 1, 0.8, 1.91, 9 / 16]) cases.push({ w0, h0, theta: deg * Math.PI / 180, R });
    }
  }
  const out = await page.evaluate((cases) => cases.map((c) => {
    const m = retouch.core.cropMaxRect(c.w0, c.h0, c.theta, c.R, 0);
    const big = { ...m, w: m.w * 1.003, h: m.h * 1.003 };
    return { m, bigValid: retouch.core.cropIsValid(big, c.w0, c.h0, c.theta), valid: retouch.core.cropIsValid(m, c.w0, c.h0, c.theta) };
  }), cases);
  out.forEach((o, i) => {
    const c = cases[i];
    const tag = JSON.stringify(c);
    assert(rectInside(o.m, c.w0, c.h0, c.theta, 1e-6), 'max rect sticks out: ' + tag);
    assert(!rectInside({ ...o.m, w: o.m.w * 1.003, h: o.m.h * 1.003 }, c.w0, c.h0, c.theta), 'max rect is not maximal: ' + tag);
    assert(o.valid && !o.bigValid, 'cropIsValid disagrees with the independent check: ' + tag);
    near(o.m.w / o.m.h, c.R || c.w0 / c.h0, 1e-9, 'ratio ' + tag);
  });
  // Free ratio at 0 degrees is the whole image.
  const full = await page.evaluate(() => retouch.core.cropMaxRect(241, 181, 0, null));
  assert(full.w === 241 && full.h === 181 && full.cx === 0 && full.cy === 0, 'full rect ' + JSON.stringify(full));
  // Clamping moves a stray rect just inside, by the least amount.
  const cl = await page.evaluate(() => {
    const r0 = retouch.core.cropClampCenter({ cx: 100, cy: -90, w: 100, h: 60 }, 241, 181, 0);
    const th = 12 * Math.PI / 180;
    const r1 = retouch.core.cropClampCenter({ cx: 300, cy: 10, w: 80, h: 50 }, 241, 181, th);
    const inside = { cx: 5, cy: -4, w: 50, h: 40 };
    return { r0, r1, same: retouch.core.cropClampCenter(inside, 241, 181, th), th,
      fit: retouch.core.cropFitRect({ cx: 30, cy: 0, w: 241, h: 181 }, 241, 181, th, 2),
      validNeg: retouch.core.cropIsValid({ cx: 0, cy: 0, w: 242, h: 10 }, 241, 181, 0),
      validEdge: retouch.core.cropIsValid({ cx: 0.5, cy: 0, w: 240, h: 181 }, 241, 181, 0) };
  });
  near(cl.r0.cx, 70.5, 1e-9, 'clamp x'); near(cl.r0.cy, -60.5, 1e-9, 'clamp y');
  assert(rectInside(cl.r1, 241, 181, cl.th), 'clamped rotated rect still outside');
  assert(!rectInside({ ...cl.r1, cx: cl.r1.cx + 0.5 }, 241, 181, cl.th), 'rotated clamp moved further than needed');
  assert(cl.same.cx === 5 && cl.same.cy === -4, 'a valid rect must not move');
  assert(rectInside(cl.fit, 241 - 4, 181 - 4, cl.th), 'fit rect ignores the margin');
  near(cl.fit.w / cl.fit.h, 241 / 181, 1e-9, 'fit keeps ratio');
  assert(!rectInside({ ...cl.fit, w: cl.fit.w * 1.01, h: cl.fit.h * 1.01 }, 241 - 4, 181 - 4, cl.th) ||
         !rectInside({ ...cl.fit, w: cl.fit.w * 1.01, h: cl.fit.h * 1.01, cx: 0, cy: 0 }, 241 - 4, 181 - 4, cl.th), 'fit rect shrank more than needed');
  const snaps = await page.evaluate(() => [
    retouch.core.cropSnap({ cx: 100, cy: 0, w: 100, h: 50 }, 241, 181),
    retouch.core.cropSnap({ cx: -100, cy: -80, w: 100, h: 50 }, 241, 181),
    retouch.core.cropSnap({ cx: 0, cy: 0, w: 300, h: 50 }, 241, 181)]);
  assert(JSON.stringify(snaps) === JSON.stringify([{ L: 141, T: 66, W: 100, H: 50 }, { L: 0, T: 0, W: 100, H: 50 }, { L: 0, T: 66, W: 241, H: 50 }]), 'cropSnap ' + JSON.stringify(snaps));
  assert(!cl.validNeg, 'too wide must be invalid');
  assert(cl.validEdge, 'touching the edge is valid');
  await ctx.close();
}, { core: true });

test('crop at 0 degrees copies exact pixels', async () => {
  const { ctx, page } = await newApp();
  await load(page, gradient());
  await commitCrop(page, { ...P0, rect: boxRect(13, 7, 100, 50, GW, GH) });
  let d = await dims(page);
  assert(d[0] === 100 && d[1] === 50, 'dims ' + d);
  samePx(await px(page, 0, 0), [13, 7, 77, 255], 0, 'crop top-left');
  samePx(await px(page, 99, 49), [112, 56, 77, 255], 0, 'crop bottom-right');
  // Odd crop at the far corner.
  await page.evaluate(() => retouch.undo());
  await commitCrop(page, { ...P0, rect: boxRect(140, 100, 101, 81, GW, GH) });
  d = await dims(page);
  assert(d[0] === 101 && d[1] === 81, 'dims ' + d);
  samePx(await px(page, 0, 0), [140, 100, 77, 255], 0, 'corner crop top-left');
  samePx(await px(page, 100, 80), [240, 180, 77, 255], 0, 'corner crop bottom-right');
  await ctx.close();
}, { core: true });

test('rotate 90 and flips map pixels exactly', async () => {
  const { ctx, page } = await newApp();
  await load(page, gradient());
  const full = (q) => (q % 2 ? boxRect(0, 0, GH, GW, GH, GW) : boxRect(0, 0, GW, GH, GW, GH));
  const cases = [
    { p: { ...P0, quarter: 1 }, dims: [GH, GW], at: [[0, 0, 0, 180], [180, 0, 0, 0], [0, 240, 240, 180], [7, 3, 3, 173]] },
    { p: { ...P0, quarter: 2 }, dims: [GW, GH], at: [[0, 0, 240, 180], [240, 180, 0, 0], [10, 5, 230, 175]] },
    { p: { ...P0, quarter: 3 }, dims: [GH, GW], at: [[0, 0, 240, 0], [180, 240, 0, 180], [4, 9, 231, 4]] },
    { p: { ...P0, flipH: true }, dims: [GW, GH], at: [[0, 0, 240, 0], [240, 5, 0, 5], [17, 30, 223, 30]] },
    { p: { ...P0, flipV: true }, dims: [GW, GH], at: [[0, 0, 0, 180], [6, 180, 6, 0], [17, 30, 17, 150]] },
    { p: { ...P0, quarter: 1, flipH: true }, dims: [GH, GW], at: [[5, 9, 9, 5], [0, 0, 0, 0], [180, 240, 240, 180]] },
  ];
  for (const c of cases) {
    await commitCrop(page, { ...c.p, rect: full(c.p.quarter) });
    const d = await dims(page);
    assert(d[0] === c.dims[0] && d[1] === c.dims[1], JSON.stringify(c.p) + ' dims ' + d);
    for (const [x, y, sx, sy] of c.at) samePx(await px(page, x, y), [sx, sy, 77, 255], 0, JSON.stringify(c.p) + ' at ' + x + ',' + y);
    await page.evaluate(() => retouch.undo());
  }
  await ctx.close();
}, { core: true });

test('crop presets from the sheet give the right ratio at full size', async () => {
  const { ctx, page } = await newApp();
  await load(page, gradient());
  const want = { '1:1': [181, 181], '4:5': [145, 181], '1.91:1': [241, 126], '9:16': [102, 181], '3:4': [136, 181] };
  for (const [id, wd] of Object.entries(want)) {
    await page.click('[data-open-tool="crop"]');
    await page.click('#crop-ratios [data-ratio="' + id + '"]');
    assert((await page.getAttribute('#crop-ratios [data-ratio="' + id + '"]', 'aria-pressed')) === 'true', id + ' chip not pressed');
    await applyTool(page, 'crop');
    const d = await dims(page);
    assert(d[0] === wd[0] && d[1] === wd[1], id + ': got ' + d + ', want ' + wd);
    // Centred: the middle pixel of the crop is the middle of the photo.
    samePx(await px(page, Math.floor(d[0] / 2), Math.floor(d[1] / 2)), [120, 90, 77, 255], 1, id + ' centred');
    await page.click('#btn-undo');
  }
  // Free and Original with no change apply nothing.
  const before = await page.evaluate(() => [retouch.app.edits.stack.length, retouch.app.edits.index]);
  for (const id of ['free', 'original']) {
    await page.click('[data-open-tool="crop"]');
    await page.click('#crop-ratios [data-ratio="' + id + '"]');
    await applyTool(page, 'crop');
  }
  const after = await page.evaluate(() => [retouch.app.edits.stack.length, retouch.app.edits.index]);
  assert(after[0] === before[0] && after[1] === before[1], 'no-op crops must not add history: ' + before + ' -> ' + after);
  await ctx.close();
}, { core: true });

test('crop sheet: rotate button, straighten slider, flip', async () => {
  const { ctx, page } = await newApp();
  await load(page, gradient());
  await page.click('[data-open-tool="crop"]');
  await page.click('#crop-rotate');
  await applyTool(page, 'crop');
  let d = await dims(page);
  assert(d[0] === GH && d[1] === GW, 'rotate dims ' + d);
  samePx(await px(page, 0, 0), [0, 180, 77, 255], 0, 'rotate maps bottom-left to top-left');
  await page.click('#btn-undo');

  await page.click('[data-open-tool="crop"]');
  await page.fill('#crop-straighten', '10');
  await page.dispatchEvent('#crop-straighten', 'input');
  assert((await page.textContent('#crop-angle')) === '+10.0°', 'angle readout');
  await applyTool(page, 'crop');
  d = await dims(page);
  assert(d[0] < GW && d[1] < GH && d[0] > 120, 'straightened dims ' + d);
  near(d[0] / d[1], GW / GH, 0.02, 'free straighten keeps the photo ratio');
  const transparent = await page.evaluate(() => retouch.core.hasTransparency(retouch.app.edits.current));
  assert(!transparent, 'straightened crop has transparent pixels at the edges');
  // The centre stays the centre.
  samePx(await px(page, Math.floor(d[0] / 2), Math.floor(d[1] / 2)), [120, 90, 77, 255], 2, 'centre after straighten');
  // A point 50 px right of centre came from the photo rotated back by 10 degrees.
  const th = 10 * Math.PI / 180;
  const sx = GW / 2 + 50 * Math.cos(th), sy = GH / 2 - 50 * Math.sin(th);
  samePx(await px(page, Math.floor(d[0] / 2 + 50), Math.floor(d[1] / 2)), [sx, sy, 77, 255], 2.5, 'straighten turns the right way');
  await page.click('#btn-undo');

  await page.click('[data-open-tool="crop"]');
  await page.click('#crop-flip-h');
  await applyTool(page, 'crop');
  samePx(await px(page, 0, 0), [240, 0, 77, 255], 0, 'flip H');
  await ctx.close();
}, { core: true });

test('crop handles: drag a corner and the box inward', async () => {
  const { ctx, page } = await newApp();
  await load(page, gradient());
  await page.click('[data-open-tool="crop"]');
  const geo = await page.evaluate(() => {
    const t = retouch.tools.crop, L = t.layout(), r = t.rect(), b = document.querySelector('#view').getBoundingClientRect();
    return { x: b.left + L.cx + (r.cx - r.w / 2) * L.k, y: b.top + L.cy + (r.cy - r.h / 2) * L.k, k: L.k };
  });
  await page.mouse.move(geo.x + 2, geo.y + 2);
  await page.mouse.down();
  await page.mouse.move(geo.x + 40 * geo.k, geo.y + 30 * geo.k, { steps: 5 });
  await page.mouse.up();
  // Dragging outward past the photo must stop at the edge.
  const out = await page.evaluate(() => { const r = retouch.tools.crop.rect(); return [r.cx - r.w / 2, r.cy - r.h / 2]; });
  near(out[0], 40 - GW / 2, 1.5, 'left edge moved'); near(out[1], 30 - GH / 2, 1.5, 'top edge moved');
  await applyTool(page, 'crop');
  const d = await dims(page);
  near(d[0], GW - 40, 1, 'width after drag'); near(d[1], GH - 30, 1, 'height after drag');
  samePx(await px(page, d[0] - 1, d[1] - 1), [240, 180, 77, 255], 0, 'opposite corner must stay put');

  await page.click('[data-open-tool="crop"]');
  const g2 = await page.evaluate(() => {
    const t = retouch.tools.crop, L = t.layout(), r = t.rect(), b = document.querySelector('#view').getBoundingClientRect();
    return { x: b.left + L.cx + (r.cx - r.w / 2) * L.k, y: b.top + L.cy + (r.cy - r.h / 2) * L.k };
  });
  await page.mouse.move(g2.x + 2, g2.y + 2);
  await page.mouse.down();
  await page.mouse.move(g2.x - 300, g2.y - 300, { steps: 5 });
  await page.mouse.up();
  const r2 = await page.evaluate(() => { const t = retouch.tools.crop, b = t.base(); return { r: t.rect(), b }; });
  assert(rectInside(r2.r, r2.b.w, r2.b.h, 0), 'drag outward left the photo');
  near(r2.r.w, r2.b.w, 0.01, 'outward drag reaches the full width');
  await ctx.close();
});

test('resize: long edge and Instagram 1080 wide', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(() => [
    retouch.core.resizeDims(4080, 3072, 'long', 1080), retouch.core.resizeDims(3072, 4080, 'long', 1080),
    retouch.core.resizeDims(3072, 4080, 'width', 1080), retouch.core.resizeDims(241, 181, 'long', 100),
    retouch.core.maxLongEdge(4080, 3072, retouch.MAX_WORKING_PIXELS), retouch.core.maxLongEdge(1000, 1000, 1000000)]);
  assert(r[0].w === 1080 && r[0].h === 813, 'landscape long edge ' + JSON.stringify(r[0]));
  assert(r[1].w === 813 && r[1].h === 1080, 'portrait long edge ' + JSON.stringify(r[1]));
  assert(r[2].w === 1080 && r[2].h === 1434, 'Instagram width ' + JSON.stringify(r[2]));
  assert(r[3].w === 100 && r[3].h === 75, 'small ' + JSON.stringify(r[3]));
  assert(r[4] === 4080, 'max long edge at the ceiling ' + r[4]);
  assert(r[5] === 1000, 'max long edge square ' + r[5]);

  // Portrait two-colour image: top red, bottom blue.
  const png = makePng(300, 400, (x, y) => (y < 200 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  await load(page, png);
  await page.click('[data-open-tool="resize"]');
  await page.click('#resize-ig');
  assert((await page.textContent('#resize-to')) === '1080 × 1440', 'readout ' + await page.textContent('#resize-to'));
  await applyTool(page, 'resize');
  let d = await dims(page);
  assert(d[0] === 1080 && d[1] === 1440, 'Instagram dims ' + d);
  samePx(await px(page, 540, 300), [255, 0, 0, 255], 2, 'top stays red');
  samePx(await px(page, 540, 1200), [0, 0, 255, 255], 2, 'bottom stays blue');
  await page.click('[data-open-tool="resize"]');
  await page.fill('#resize-long', '200');
  await page.dispatchEvent('#resize-long', 'change');
  await applyTool(page, 'resize');
  d = await dims(page);
  assert(d[0] === 150 && d[1] === 200, 'long edge 200 gives ' + d);
  samePx(await px(page, 75, 20), [255, 0, 0, 255], 2, 'downscaled top red');
  await ctx.close();
}, { core: true });

test('add canvas: padding sizes and offsets', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(() => {
    const c = retouch.core;
    return [c.padDims(241, 181, 0.8, 0), c.padDims(241, 181, 1.91, 0), c.padDims(241, 181, 1, 0), c.padDims(241, 181, null, 10),
      c.padDims(241, 181, 241 / 181, 24), c.padOffset(241, 301, 241, 181, 0.5, 0.5), c.padOffset(346, 181, 241, 181, 0.5, 0.5),
      c.padOffset(241, 301, 241, 181, 0, 1), c.padOffset(241, 301, 241, 181, -3, 7),
      c.padOffset(346, 181, 241, 181, -2, 0.5), c.padOffset(346, 181, 241, 181, 5, 0)];
  });
  const want = [{ W: 241, H: 301 }, { W: 346, H: 181 }, { W: 241, H: 241 }, { W: 261, H: 201 }, { W: 305, H: 229 },
    { x: 0, y: 60 }, { x: 53, y: 0 }, { x: 0, y: 120 }, { x: 0, y: 120 }, { x: 0, y: 0 }, { x: 105, y: 0 }];
  r.forEach((v, i) => assert(JSON.stringify(v) === JSON.stringify(want[i]), 'case ' + i + ': got ' + JSON.stringify(v) + ', want ' + JSON.stringify(want[i])));
  // Frames bigger than the ceiling are scaled to fit; smaller ones are left alone.
  const sc = await page.evaluate(() => {
    const M = retouch.MAX_WORKING_PIXELS, c = retouch.core;
    return [[4080, 7253], [4080, 4080], [5100, 4080], [241, 301]].map(([W, H]) => {
      const k = c.padScale(W, H, M); return { k, w: Math.round(W * k), h: Math.round(H * k), M };
    });
  });
  for (const v of sc.slice(0, 3)) {
    assert(v.w * v.h <= v.M && v.w * v.h > v.M * 0.999, 'padScale should land just under the ceiling: ' + JSON.stringify(v));
  }
  assert(sc[3].k === 1, 'small frames must not scale');
  near(sc[0].w / sc[0].h, 4080 / 7253, 0.001, 'padScale keeps the ratio');
  await ctx.close();
}, { core: true });

test('add canvas: solid colour, position, transparent, blur', async () => {
  const { ctx, page } = await newApp();
  await load(page, gradient());
  // 4:5 white, centred.
  await page.click('[data-open-tool="pad"]');
  await page.click('#pad-ratios [data-ratio="4:5"]');
  await page.click('[data-fill="colour"]');
  await page.click('[data-colour="#FFFFFF"]');
  assert((await page.textContent('#pad-out')) === 'Result 241 × 301 px', 'readout ' + await page.textContent('#pad-out'));
  await applyTool(page, 'pad');
  let d = await dims(page);
  assert(d[0] === 241 && d[1] === 301, '4:5 dims ' + d);
  samePx(await px(page, 0, 0), [255, 255, 255, 255], 0, 'pad colour top');
  samePx(await px(page, 120, 59), [255, 255, 255, 255], 0, 'pad colour just above photo');
  samePx(await px(page, 0, 60), [0, 0, 77, 255], 0, 'photo starts at row 60');
  samePx(await px(page, 240, 240), [240, 180, 77, 255], 0, 'photo ends at row 240');
  samePx(await px(page, 120, 241), [255, 255, 255, 255], 0, 'pad colour below');
  await page.click('#btn-undo');

  // Drag the photo to the top of the frame, black fill.
  await page.click('[data-open-tool="pad"]');
  await page.click('[data-colour="#000000"]');
  const box = await page.locator('#view').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 5, { steps: 6 });
  await page.mouse.up();
  await applyTool(page, 'pad');
  samePx(await px(page, 0, 0), [0, 0, 77, 255], 0, 'photo dragged to the top');
  samePx(await px(page, 0, 300), [0, 0, 0, 255], 0, 'black fill below');
  await page.click('#btn-undo');

  // 1.91:1 transparent.
  await page.click('[data-open-tool="pad"]');
  await page.click('#pad-centre');
  await page.click('#pad-ratios [data-ratio="1.91:1"]');
  await page.click('[data-fill="transparent"]');
  await applyTool(page, 'pad');
  d = await dims(page);
  assert(d[0] === 346 && d[1] === 181, '1.91 dims ' + d);
  samePx(await px(page, 0, 0), [0, 0, 0, 0], 0, 'transparent pad');
  samePx(await px(page, 53, 0), [0, 0, 77, 255], 0, 'photo at x 53');
  await page.click('#btn-export');
  await page.waitForFunction(() => !document.querySelector('#export-download').disabled);
  assert((await page.getAttribute('[data-format="png"]', 'aria-pressed')) === 'true', 'transparent must export as PNG');
  assert(await page.isDisabled('[data-format="jpeg"]') && await page.isDisabled('[data-format="webp"]'), 'JPEG and WebP must be disabled');
  assert(await page.isVisible('#export-alpha-note'), 'transparency note');
  await page.click('.sheet-panel[data-tool="export"] [data-cancel]');
  await page.click('#btn-undo');

  // 1:1 blur.
  await page.click('[data-open-tool="pad"]');
  await page.click('#pad-ratios [data-ratio="1:1"]');
  await page.click('[data-fill="blur"]');
  await applyTool(page, 'pad');
  d = await dims(page);
  assert(d[0] === 241 && d[1] === 241, '1:1 dims ' + d);
  const a = await px(page, 5, 5), b = await px(page, 235, 25);
  assert(a[3] === 255 && b[3] === 255, 'blur fill must be opaque');
  assert(Math.abs(a[0] - b[0]) > 40, 'blur fill should follow the photo (left dark, right bright): ' + a + ' vs ' + b);
  samePx(await px(page, 0, 30), [0, 0, 77, 255], 0, 'photo over the blur');
  await page.click('#btn-undo');

  // Blur must soften: a sharp 6 px checkerboard should come out nearly flat in the padding.
  await load(page, makePng(GW, GH, (x, y) => ((Math.floor(x / 6) + Math.floor(y / 6)) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255])));
  await page.click('[data-open-tool="pad"]');
  await page.click('#pad-ratios [data-ratio="1:1"]');
  await page.click('[data-fill="blur"]');
  await applyTool(page, 'pad');
  const row = await page.evaluate(() => retouch.readPixels(retouch.app.edits.current, 0, 10, 241, 1));
  let maxStep = 0;
  for (let i = 4; i < row.length; i += 4) maxStep = Math.max(maxStep, Math.abs(row[i] - row[i - 4]));
  assert(maxStep < 24, 'blur fill still has sharp edges (largest step ' + maxStep + ')');
  await load(page, gradient());

  // Original ratio with a 10 % margin.
  await page.click('[data-open-tool="pad"]');
  await page.click('#pad-ratios [data-ratio="original"]');
  await page.click('[data-fill="colour"]');
  await page.fill('#pad-margin', '10');
  await page.dispatchEvent('#pad-margin', 'input');
  await applyTool(page, 'pad');
  d = await dims(page);
  assert(d[0] === 305 && d[1] === 229, 'margin dims ' + d);
  await ctx.close();
}, { core: true });

test('undo, redo, original untouched, history cap', async () => {
  const { ctx, page } = await newApp();
  await load(page, gradient());
  await page.evaluate(async () => {
    for (let i = 0; i < retouch.HISTORY_DEPTH + 3; i++) {
      await retouch.commit('Resize', (src) => retouch.core.renderResize(src, 200 + i, 150));
    }
  });
  const s = await page.evaluate(() => ({ len: retouch.app.edits.stack.length, idx: retouch.app.edits.index, depth: retouch.HISTORY_DEPTH,
    o: [retouch.app.edits.original.width, retouch.app.edits.original.height] }));
  assert(s.len === s.depth + 1 && s.idx === s.depth, 'stack ' + JSON.stringify(s));
  assert(s.o[0] === GW && s.o[1] === GH, 'original kept');
  samePx(await px(page, 240, 180, 'original'), [240, 180, 77, 255], 0, 'original pixels untouched');
  let d = await dims(page);
  assert(d[0] === 200 + s.depth + 2, 'latest step on top, got ' + d);
  for (let i = 0; i < s.depth; i++) await page.click('#btn-undo');
  d = await dims(page);
  assert(d[0] === GW && d[1] === GH, 'undo all the way reaches the original, got ' + d);
  assert(await page.isDisabled('#btn-undo'), 'undo disabled at the original');
  await page.click('#btn-redo');
  d = await dims(page);
  assert(d[0] === 203, 'oldest kept step is the 4th edit, got ' + d);
  // A new edit after undo drops the redo tail.
  await page.click('#btn-undo');
  await page.evaluate(() => retouch.commit('Crop', (src) => retouch.core.renderCrop(src, { quarter: 1, flipH: false, flipV: false, theta: 0, rect: { cx: 0, cy: 0, w: src.height, h: src.width } })));
  assert(await page.isDisabled('#btn-redo'), 'redo cleared after a new edit');
  assert((await page.evaluate(() => retouch.app.edits.stack.length)) === 2, 'stack after branch');
  await ctx.close();
}, { core: true });

test('metadata strip: planted EXIF, GPS, XMP, IPTC, text chunks all removed', async () => {
  const { ctx, page } = await newApp();
  const enc = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 48;
    const x = c.getContext('2d'); x.fillStyle = '#3a7'; x.fillRect(0, 0, 64, 48); x.fillStyle = '#c33'; x.fillRect(10, 10, 20, 20);
    const get = async (t) => Array.from(new Uint8Array(await (await new Promise((r) => c.toBlob(r, t, 0.9))).arrayBuffer()));
    return { jpeg: await get('image/jpeg'), webp: await get('image/webp') };
  });
  const files = {
    jpeg: plantJpegMetadata(Buffer.from(enc.jpeg)),
    png: plantPngMetadata(makePng(64, 48, (x, y) => [x * 4, y * 5, 30, 255])),
    webp: plantWebpMetadata(Buffer.from(enc.webp), 64, 48),
  };
  for (const [k, buf] of Object.entries(files)) {
    assert(findImageMetadata(buf).length > 0, k + ' fixture should carry metadata');
    const r = await page.evaluate(async ([arr, k]) => {
      const b = new Uint8Array(arr);
      const before = retouch.core.meta.find(b);
      const s = retouch.core.meta.strip(b);
      const after = retouch.core.meta.find(s);
      const bmp = await createImageBitmap(new Blob([s], { type: 'image/' + k }));
      return { before, after, out: Array.from(s), w: bmp.width, h: bmp.height };
    }, [Array.from(buf), k]);
    const expect = { jpeg: ['EXIF', 'GPS', 'XMP', 'IPTC', 'comment', 'APP2'], png: ['tEXt', 'iTXt', 'eXIf', 'tIME'], webp: ['EXIF', 'XMP', 'VP8X metadata flag'] }[k];
    for (const e of expect) assert(r.before.includes(e), k + ': app parser missed ' + e + ' (found ' + r.before + ')');
    assert(r.after.length === 0, k + ': app parser still sees ' + r.after);
    const left = findImageMetadata(Buffer.from(r.out));
    assert(left.length === 0, k + ': independent parser still finds ' + left);
    assert(r.w === 64 && r.h === 48, k + ': stripped file no longer decodes at 64 x 48 (' + r.w + ' x ' + r.h + ')');
    assert(r.out.length < buf.length, k + ': nothing was removed');
    const o = Buffer.from(r.out);
    if (k === 'jpeg') {
      assert(o[o.length - 2] === 0xFF && o[o.length - 1] === 0xD9, 'jpeg: must end with its EOI marker');
      // Chrome's own encode carries no metadata, so stripping the planted copy must give it back byte for byte.
      assert(o.equals(Buffer.from(enc.jpeg)), 'jpeg: stripped file differs from the clean encode (' + o.length + ' vs ' + enc.jpeg.length + ' bytes)');
    }
    if (k === 'webp') assert(o.readUInt32LE(4) === o.length - 8, 'webp: RIFF size ' + o.readUInt32LE(4) + ' for ' + o.length + ' bytes');
    if (k === 'png') assert(o.subarray(o.length - 8, o.length - 4).toString('latin1') === 'IEND', 'png: must end with IEND');
  }
  await ctx.close();
}, { core: true });

test('export JPEG, PNG and WebP: bytes carry no metadata, one-line confirmation', async () => {
  const { ctx, page } = await newApp();
  const jpeg = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 240;
    const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 320, 240); g.addColorStop(0, '#d44'); g.addColorStop(1, '#46d');
    x.fillStyle = g; x.fillRect(0, 0, 320, 240);
    return Array.from(new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer()));
  }));
  await load(page, plantJpegMetadata(jpeg), 'PXL_20261009.jpg', 'image/jpeg');
  await page.click('#btn-export');
  for (const fmt of ['jpeg', 'png', 'webp']) {
    await page.click('[data-format="' + fmt + '"]');
    await page.waitForFunction(() => !document.querySelector('#export-download').disabled);
    assert(/Pass/.test(await page.textContent('#export-meta')), 'metadata row should say Pass');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-download')]);
    const bytes = fs.readFileSync(await dl.path());
    assert(imageFormat(bytes) === fmt, fmt + ': exported ' + imageFormat(bytes));
    const left = findImageMetadata(bytes);
    assert(left.length === 0, fmt + ': exported file carries ' + left.join(', '));
    assert(dl.suggestedFilename().endsWith({ jpeg: '.jpg', png: '.png', webp: '.webp' }[fmt]), 'file name ' + dl.suggestedFilename());
    const back = await page.evaluate(async ([arr, fmt]) => { const b = await createImageBitmap(new Blob([new Uint8Array(arr)], { type: 'image/' + fmt })); return [b.width, b.height]; }, [Array.from(bytes), fmt]);
    assert(back[0] === 320 && back[1] === 240, fmt + ' decodes as ' + back);
    const note = await page.textContent('.notice[data-id="export"]');
    assert(/Pass/.test(note) && /Metadata stripped/.test(note) && note.includes('320 × 240'), 'confirmation: ' + note);
  }
  await ctx.close();
}, { core: true });

test('share sends the stripped file', async () => {
  const init = () => {
    window.__shared = null;
    navigator.canShare = () => true;
    navigator.share = async (d) => {
      const f = d.files[0];
      window.__shared = { n: d.files.length, name: f.name, type: f.type, bytes: Array.from(new Uint8Array(await f.arrayBuffer())) };
    };
  };
  const { ctx, page } = await newApp({ init });
  const jpeg = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 50; c.height = 40; c.getContext('2d').fillRect(0, 0, 50, 40);
    return Array.from(new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg'))).arrayBuffer()));
  }));
  await load(page, plantJpegMetadata(jpeg), 'a.jpg', 'image/jpeg');
  await page.click('#btn-export');
  await page.click('[data-format="jpeg"]');
  await page.waitForFunction(() => !document.querySelector('#export-share').disabled);
  await page.click('#export-share');
  await page.waitForFunction(() => window.__shared);
  const s = await page.evaluate(() => window.__shared);
  assert(s.n === 1 && s.type === 'image/jpeg' && /^retouch-\d{6}-\d{4}\.jpg$/.test(s.name), 'shared ' + JSON.stringify({ ...s, bytes: s.bytes.length }));
  const left = findImageMetadata(Buffer.from(s.bytes));
  assert(left.length === 0, 'shared file carries ' + left);
  await page.waitForSelector('.notice[data-id="export"]');
  await ctx.close();
});

test('before / after hold on the main view and on every tool', async () => {
  const { ctx, page } = await newApp();
  await load(page, gradient());
  await commitCrop(page, { ...P0, rect: boxRect(0, 0, 100, 100, GW, GH) });
  const hold = async (sel) => {
    const b = await page.locator(sel).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => window.retouch.app.showing === 'before');
    await page.mouse.up();
    await page.waitForFunction(() => window.retouch.app.showing === 'after');
  };
  await hold('#hold-main');
  await page.evaluate(BG_INIT);
  await page.evaluate(() => { window.__fakeSeg([0, 0, 77], 300); window.__fakeSkin([0, 0, 77], 300); });
  for (const t of ['crop', 'resize', 'pad', 'text', 'bg', 'skin', 'spot']) {
    await page.click('[data-open-tool="' + t + '"]');
    await hold('.sheet-panel[data-tool="' + t + '"] [data-hold]');
    await idle(page);
    await page.click('.sheet-panel[data-tool="' + t + '"] [data-cancel]');
  }
  await page.click('#btn-export');
  await hold('.sheet-panel[data-tool="export"] [data-hold]');
  // The video check edits nothing, so it alone has no before to hold.
  const panels = await page.$$eval('.sheet-panel', (ps) => ps.map((p) => [p.dataset.tool, !!p.querySelector('[data-hold]') || (p.dataset.tool === 'vcheck' && p.hasAttribute('data-no-hold'))]));
  assert(panels.every(([, h]) => h), 'every tool needs a hold button: ' + JSON.stringify(panels));
  await ctx.close();
});

test('edit counter reads 0 edit, 1 edit, 2 edits; the empty screen has no counter', async () => {
  const { ctx, page } = await newApp();
  const emptyText = await page.textContent('#empty');
  assert(!/\d+\s+edits?\b/i.test(emptyText) && !/RT-|Google Photos/.test(emptyText), 'empty screen: ' + emptyText.replace(/\s+/g, ' '));
  await load(page, gradient());
  const top = () => page.textContent('#top-code');
  assert(/^0 edit ▸ /.test(await top()), 'after open: ' + await top());
  await page.click('[data-open-tool="resize"]');
  await page.click('[data-long="1080"]');
  await applyTool(page, 'resize');
  assert(/^1 edit ▸ /.test(await top()), 'after one edit: ' + await top());
  await page.click('[data-open-tool="resize"]');
  assert(/^1 edit ▸ Resize$/.test(await page.textContent('#strip-code')), 'strip: ' + await page.textContent('#strip-code'));
  await page.click('[data-long="1600"]');
  await applyTool(page, 'resize');
  assert(/^2 edits ▸ /.test(await top()), 'after two edits: ' + await top());
  await page.click('#btn-undo');
  assert(/^1 edit ▸ /.test(await top()), 'after undo: ' + await top());
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('pinch to zoom and drag to pan', async () => {
  const { ctx, page } = await newApp();
  await load(page, gradient());
  const s0 = await page.evaluate(() => retouch.view.scale);
  await page.evaluate(() => {
    const c = document.querySelector('#view'), r = c.getBoundingClientRect();
    const ev = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerType: 'touch', isPrimary: id === 1 }));
    ev('pointerdown', 1, 180, 300); ev('pointerdown', 2, 220, 300);
    for (let i = 1; i <= 10; i++) { ev('pointermove', 1, 180 - i * 8, 300); ev('pointermove', 2, 220 + i * 8, 300); }
    ev('pointerup', 1, 100, 300); ev('pointerup', 2, 300, 300);
  });
  const s1 = await page.evaluate(() => retouch.view.scale);
  near(s1 / s0, 5, 0.05, 'pinch spread from 40 to 200 px should zoom 5x');
  const t0 = await page.evaluate(() => [retouch.view.tx, retouch.view.ty]);
  const box = await page.locator('#view').boundingBox();
  await page.mouse.move(box.x + 200, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 260, { steps: 4 });
  await page.mouse.up();
  const t1 = await page.evaluate(() => [retouch.view.tx, retouch.view.ty]);
  near(t1[0] - t0[0], -50, 0.5, 'pan x'); near(t1[1] - t0[1], -40, 0.5, 'pan y');
  await ctx.close();
});

test('phone layout: tap targets at least 44 px, no sideways scroll', async () => {
  const { ctx, page } = await newApp();
  const checkVisible = async (where) => {
    const small = await page.$$eval('button, input, select, a', (els) => els.filter((e) => {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || e.closest('[hidden]') || getComputedStyle(e).visibility === 'hidden') return false;
      return r.width < 43.5 || r.height < 43.5;
    }).map((e) => (e.id || e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)));
    assert(!small.length, where + ': small targets ' + small.join(', '));
    const sw = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert(sw[0] <= sw[1], where + ': page scrolls sideways ' + sw);
  };
  await checkVisible('empty state');
  await load(page, gradient());
  await checkVisible('editing');
  await page.evaluate(BG_INIT);
  await page.evaluate(() => { window.__fakeSeg([0, 0, 77], 300); window.__fakeSkin([0, 0, 77], 300); });
  for (const t of ['crop', 'resize', 'pad', 'text', 'bg', 'bg-brush', 'skin', 'skin-brush', 'spot']) {
    if (t === 'bg-brush') { await page.click('[data-open-tool="bg"]'); await idle(page); await page.click('[data-bgmode="erase"]'); }
    else if (t === 'skin-brush') { await page.click('[data-open-tool="skin"]'); await idle(page); await page.click('[data-skinmode="erase"]'); }
    else await page.click('[data-open-tool="' + t + '"]');
    if (t === 'bg' || t === 'skin') await idle(page);
    await checkVisible(t + ' sheet');
    const stage = await page.locator('#stage').boundingBox();
    assert(stage.height > 400, t + ': photo area only ' + stage.height + ' px tall');
    await page.click('.sheet-panel[data-tool="' + t.replace('-brush', '') + '"] [data-cancel]');
  }
  await page.click('#btn-export');
  await checkVisible('export sheet');
  await ctx.close();
});

test('CSP blocks any call to another origin', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(async () => {
    const seen = [];
    document.addEventListener('securitypolicyviolation', (e) => seen.push(e.violatedDirective));
    let fetchBlocked = false;
    try { await fetch('https://csp-probe.example/upload', { method: 'POST', body: 'x' }); } catch (e) { fetchBlocked = true; }
    const img = new Image(); img.src = 'https://csp-probe.example/pixel.png';
    let wsBlocked = false;
    try { new WebSocket('wss://csp-probe.example/'); } catch (e) { wsBlocked = true; }
    navigator.sendBeacon && (() => { try { navigator.sendBeacon('https://csp-probe.example/b', 'x'); } catch (e) { /* blocked */ } })();
    await new Promise((res) => setTimeout(res, 300));
    return { fetchBlocked, wsBlocked, seen };
  });
  assert(r.fetchBlocked, 'fetch to another origin was not blocked');
  assert(r.seen.filter((d) => d.startsWith('connect-src')).length >= 2, 'connect-src violations ' + r.seen);
  assert(r.seen.some((d) => d.startsWith('img-src')), 'img-src violation expected ' + r.seen);
  await ctx.close();
});

test('service worker: offline start, fonts cached', async () => {
  const { ctx, page } = await newApp({ sw: true });
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.retouch && window.retouch.APP_VERSION);
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() => Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => f.family + ' ' + f.weight));
  assert(fonts.some((f) => /Barlow Semi Condensed/.test(f)) && fonts.some((f) => /IBM Plex Mono/.test(f)), 'fonts offline: ' + fonts);
  await load(page, gradient());
  const d = await dims(page);
  assert(d[0] === GW, 'editing works offline');
  await ctx.setOffline(false);
  await ctx.close();
});

test('service worker: share target opens the shared photo', async () => {
  const { ctx, page } = await newApp({ sw: true });
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
  const png = gradient();
  await page.evaluate((arr) => {
    const f = new File([new Uint8Array(arr)], 'PXL_shared.png', { type: 'image/png' });
    const form = document.createElement('form');
    form.method = 'POST'; form.action = 'share-target'; form.enctype = 'multipart/form-data';
    const input = document.createElement('input'); input.type = 'file'; input.name = 'image';
    const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files;
    form.append(input); document.body.append(form); form.submit();
  }, Array.from(png));
  await page.waitForURL(/retouch\.html$/);
  await page.waitForFunction(() => window.retouch && window.retouch.app.edits && window.retouch.app.busyCount === 0, null, { timeout: 15000 });
  const d = await dims(page);
  assert(d[0] === GW && d[1] === GH, 'shared photo dims ' + d);
  samePx(await px(page, 7, 9), [7, 9, 77, 255], 0, 'shared pixels');
  const left = await page.evaluate(async () => (await (await caches.open('retouch-share')).keys()).length);
  assert(left === 0, 'shared file should be removed from the cache after use');
  await ctx.close();
});

test('service worker: new version shows "Update available" and reloads into it', async () => {
  const { ctx, page } = await newApp({ sw: true });
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
  const v = await page.evaluate(() => retouch.APP_VERSION);
  server.swVariant = v + '-next';
  try {
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.waitForSelector('.notice[data-id="update"]', { timeout: 15000 });
    const t = await page.textContent('.notice[data-id="update"]');
    assert(/Update available/.test(t), 'prompt text ' + t);
    await Promise.all([page.waitForNavigation(), page.click('.notice[data-id="update"] .btn-primary')]);
    await page.waitForFunction(() => window.retouch);
    const keys = await page.evaluate(async () => caches.keys());
    assert(keys.includes('retouch-v' + v + '-next') && !keys.includes('retouch-v' + v), 'caches after update: ' + keys);
  } finally { server.swVariant = null; }
  await ctx.close();
});

/* ---------- Phase 2: text ---------- */

// In-page helpers: find the pixels of one colour and summarise where they are.
const TEXT_INIT = () => {
  window.__stats = (data, w, rgb, tol, box = null) => {
    let n = 0, sx = 0, sy = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const h = data.length / 4 / w;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (box && (x < box[0] || x >= box[2] || y < box[1] || y >= box[3])) continue;
      const i = (y * w + x) * 4;
      if (Math.abs(data[i] - rgb[0]) > tol || Math.abs(data[i + 1] - rgb[1]) > tol || Math.abs(data[i + 2] - rgb[2]) > tol) continue;
      n++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { n, cx: sx / n, cy: sy / n, minX, minY, maxX, maxY, bw: maxX - minX + 1, bh: maxY - minY + 1 };
  };
  window.__pixels = async (bytes) => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
    return { w: c.width, h: c.height, data: x.getImageData(0, 0, c.width, c.height).data };
  };
  // Export the current step as PNG through the app's own export function.
  window.__exportStats = async (rgb, tol = 40, box = null) => {
    const r = await retouch.encodeImage(retouch.app.edits.current, 'png', 1, 'x', retouch.app.edits.texts);
    const p = await window.__pixels(r.bytes);
    return window.__stats(p.data, p.w, rgb, tol, box);
  };
};
const MAGENTA = [255, 0, 255];

// Open the Text sheet and set up the selected box (adding one with add: true).
async function textBox(page, o = {}) {
  if (!(await page.evaluate(() => retouch.app.tool === retouch.tools.text))) await page.click('[data-open-tool="text"]');
  if (o.add) await page.click('#text-add');
  await page.fill('#text-input', o.text || 'HHHH');
  await page.evaluate(() => document.activeElement.blur());
  await page.click('[data-text-tab="font"]');
  await page.click('#text-fonts [data-font="' + (o.font || 'sans') + '"]');
  await page.fill('#text-size', String(o.size || 40));
  await page.dispatchEvent('#text-size', 'input');
  await page.click('[data-text-tab="colour"]');
  await page.click('[data-target="fill"]');
  await page.fill('#text-colour', o.colour || '#ff00ff');
  await page.click('[data-text-tab="style"]');
  await page.fill('#text-outline', String(o.outline || 0));
  await page.dispatchEvent('#text-outline', 'input');
  if (o.outlineColour) { await page.click('[data-text-tab="colour"]'); await page.click('[data-target="outline"]'); await page.fill('#text-colour', o.outlineColour); await page.click('[data-target="fill"]'); await page.click('[data-text-tab="style"]'); }
  await page.click('[data-shadow="' + (o.shadow || 'none') + '"]');
  await page.click('[data-align="' + (o.align || 'center') + '"]');
  await page.click('[data-text-tab="font"]');
  if (o.apply !== false) await applyTool(page, 'text');
}
const texts = (page) => page.evaluate(() => retouch.app.edits.texts);
// Where an image point is on the screen, in page coordinates.
const onScreen = (page, x, y) => page.evaluate(([x, y]) => {
  const r = document.querySelector('#view').getBoundingClientRect(), v = retouch.view;
  return { x: r.left + v.tx + x * v.scale, y: r.top + v.ty + y * v.scale, s: v.scale };
}, [x, y]);
// Two-finger gesture on the stage, in page coordinates: [a0, b0] to [a1, b1].
const pinch = (page, a0, b0, a1, b1, steps = 8) => page.evaluate(([a0, b0, a1, b1, steps]) => {
  const c = document.querySelector('#view');
  const ev = (type, id, p) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: p.x, clientY: p.y, bubbles: true, pointerType: 'touch', isPrimary: id === 11 }));
  const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  ev('pointerdown', 11, a0); ev('pointerdown', 12, b0);
  for (let i = 1; i <= steps; i++) { ev('pointermove', 11, lerp(a0, a1, i / steps)); ev('pointermove', 12, lerp(b0, b1, i / steps)); }
  ev('pointerup', 11, a1); ev('pointerup', 12, b1);
}, [a0, b0, a1, b1, steps]);

test('text: a box in a known colour lands where it was placed in the export', async () => {
  const { ctx, page } = await newApp({ init: TEXT_INIT });
  await load(page, makePng(400, 300, null, [], { flat: [40, 40, 40] }));
  await textBox(page, { text: 'HHHH', size: 40 });
  const t = await texts(page);
  assert(t.length === 1, 'one box expected, got ' + t.length);
  const b = t[0];
  assert(b.text === 'HHHH' && b.colour === '#FF00FF' && b.size === 40 && b.font === 'sans' && b.shadow === 'none', 'box ' + JSON.stringify(b));
  assert(b.x === 200 && b.y === 150 && b.rotation === 0, 'new box should sit at the centre: ' + JSON.stringify(b));
  // The pixels are still the photo's own: text is not baked into the step.
  samePx(await px(page, 200, 150), [40, 40, 40, 255], 0, 'step bitmap must not contain the text');
  const m = await page.evaluate(() => retouch.core.textMeasure(retouch.app.edits.texts[0]));
  // Export through the sheet as PNG and look at the real file.
  await page.click('#btn-export');
  await page.click('[data-format="png"]');
  await page.waitForFunction(() => !document.querySelector('#export-download').disabled);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-download')]);
  const bytes = fs.readFileSync(await dl.path());
  const s = await page.evaluate(async (arr) => { const p = await window.__pixels(arr); return window.__stats(p.data, p.w, [255, 0, 255], 40); }, Array.from(bytes));
  assert(s.n > 300, 'too few text pixels in the export: ' + s.n);
  near(s.cx, 200, 1.5, 'text centre x'); near(s.cy, 150, 6, 'text centre y');
  assert(s.bw <= m.w && s.bw > m.w - 12, 'text width ' + s.bw + ' should be just inside its measured width ' + m.w);
  assert(s.bh < m.h && s.bh > 40 * 0.5, 'text height ' + s.bh + ' for a 40 px font');
  const bg = await page.evaluate(async (arr) => { const p = await window.__pixels(arr); return Array.from(p.data.slice(0, 4)); }, Array.from(bytes));
  samePx(bg, [40, 40, 40, 255], 0, 'background away from the text');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
}, { core: true });

test('text: drag, pinch and the handle change the stored transform and the exported pixels', async () => {
  const { ctx, page } = await newApp({ init: TEXT_INIT });
  await load(page, makePng(400, 300, null, [], { flat: [40, 40, 40] }));
  await textBox(page, { text: 'HHHHHH', size: 30 });
  const s0 = await page.evaluate(() => window.__exportStats([255, 0, 255]));

  // Drag with one finger (mouse): the box and its pixels move by the same amount.
  await page.click('[data-open-tool="text"]');
  const c0 = await onScreen(page, 200, 150);
  await page.mouse.move(c0.x, c0.y);
  await page.mouse.down();
  await page.mouse.move(c0.x + 60, c0.y - 30, { steps: 6 });
  await page.mouse.up();
  await applyTool(page, 'text');
  let b = (await texts(page))[0];
  near(b.x, 200 + 60 / c0.s, 0.01, 'dragged x'); near(b.y, 150 - 30 / c0.s, 0.01, 'dragged y');
  assert(b.size === 30 && b.rotation === 0, 'a drag must not scale or turn: ' + JSON.stringify(b));
  const s1 = await page.evaluate(() => window.__exportStats([255, 0, 255]));
  near(s1.cx - s0.cx, b.x - 200, 1, 'exported text moved in x'); near(s1.cy - s0.cy, b.y - 150, 1, 'exported text moved in y');
  near(s1.bw, s0.bw, 1, 'width unchanged by a drag');

  // Pinch: fingers 80 px apart across the box, turned a quarter and spread to 120 px.
  await page.click('[data-open-tool="text"]');
  const c1 = await onScreen(page, b.x, b.y);
  await pinch(page, { x: c1.x - 40, y: c1.y }, { x: c1.x + 40, y: c1.y }, { x: c1.x, y: c1.y - 60 }, { x: c1.x, y: c1.y + 60 });
  await applyTool(page, 'text');
  const b2 = (await texts(page))[0];
  near(b2.size, 45, 0.01, 'pinch scale'); near(b2.rotation, Math.PI / 2, 1e-6, 'pinch turn');
  near(b2.x, b.x, 0.01, 'pinch about the centre keeps x'); near(b2.y, b.y, 0.01, 'pinch about the centre keeps y');
  const s2 = await page.evaluate(() => window.__exportStats([255, 0, 255]));
  near(s2.bw, s1.bh * 1.5, 4, 'turned text: new width is 1.5 x the old height');
  near(s2.bh, s1.bw * 1.5, 4, 'turned text: new height is 1.5 x the old width');
  near(s2.cx, b.x - 1.5 * (s1.cy - b.y), 4, 'turned text centre x'); near(s2.cy, b.y, 4, 'turned text centre y');

  // Pinch off-centre: the box follows the fingers (a translation of 50 px with them).
  await page.click('[data-open-tool="text"]');
  const c2 = await onScreen(page, b2.x, b2.y);
  await pinch(page, { x: c2.x - 30, y: c2.y - 10 }, { x: c2.x + 30, y: c2.y - 10 }, { x: c2.x + 20, y: c2.y - 10 }, { x: c2.x + 80, y: c2.y - 10 });
  await applyTool(page, 'text');
  const b3 = (await texts(page))[0];
  near(b3.x - b2.x, 50 / c2.s, 0.01, 'two-finger drag moves x'); near(b3.y, b2.y, 0.01, 'two-finger drag keeps y');
  near(b3.size, b2.size, 1e-6, 'two-finger drag keeps size'); near(b3.rotation, b2.rotation, 1e-9, 'two-finger drag keeps the turn');

  // The round handle: drag it halfway towards the centre and a quarter turn back.
  await page.click('[data-open-tool="text"]');
  const h = await page.evaluate(() => { const t = retouch.tools.text; return t.handlePoint(t.box()); });
  const hs = await onScreen(page, h.x, h.y), cs = await onScreen(page, b3.x, b3.y);
  const vx = hs.x - cs.x, vy = hs.y - cs.y;
  await page.mouse.move(hs.x, hs.y);
  await page.mouse.down();
  await page.mouse.move(cs.x + vy * 0.5, cs.y - vx * 0.5, { steps: 6 });     // the handle vector turned -90 degrees and halved
  await page.mouse.up();
  await applyTool(page, 'text');
  const b4 = (await texts(page))[0];
  near(b4.size, b3.size * 0.5, 0.05, 'handle halves the size'); near(b4.rotation, 0, 1e-3, 'handle turns it back level');
  near(b4.x, b3.x, 0.01, 'handle keeps the centre');
  const s4 = await page.evaluate(() => window.__exportStats([255, 0, 255]));
  near(s4.bw, s0.bw * 0.75, 3, 'exported width after the handle (30 px x 1.5 x 0.5)');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
}, { core: true });

test('text: still editable after undo, redo and reopening the tool', async () => {
  const { ctx, page } = await newApp({ init: TEXT_INIT });
  await load(page, gradient());
  await page.evaluate(() => { window.__bmp0 = retouch.app.edits.current; });
  await textBox(page, { text: 'One' });
  await textBox(page, { text: 'Two', add: true });
  let t = await texts(page);
  assert(t.length === 2 && t[0].text === 'One' && t[1].text === 'Two', 'two boxes: ' + JSON.stringify(t.map((b) => b.text)));
  assert(t[1].id !== t[0].id, 'boxes need their own ids');
  // Text steps reuse the bitmap: no new pixels.
  const same = await page.evaluate(() => retouch.app.edits.stack.every((e) => e.bmp === retouch.app.edits.stack[0].bmp));
  assert(same, 'a text step must not copy the image');
  await page.click('#btn-undo');
  t = await texts(page);
  assert(t.length === 1 && t[0].text === 'One', 'undo removes the second box: ' + JSON.stringify(t));
  await page.click('[data-open-tool="text"]');
  assert((await page.inputValue('#text-input')) === 'One', 'reopened tool shows the box text');
  await page.fill('#text-input', 'Uno');
  await applyTool(page, 'text');
  assert(await page.isDisabled('#btn-redo'), 'editing after undo drops the redo tail');
  assert((await texts(page))[0].text === 'Uno', 'edited after undo');
  await page.click('#btn-undo');
  assert((await texts(page))[0].text === 'One', 'undo the edit');
  await page.click('#btn-redo');
  assert((await texts(page))[0].text === 'Uno', 'redo the edit');
  // Cancel throws away changes made in the sheet.
  await page.click('[data-open-tool="text"]');
  await page.fill('#text-input', 'Discard me');
  await page.click('.sheet-panel[data-tool="text"] [data-cancel]');
  assert((await texts(page))[0].text === 'Uno', 'cancel keeps the old text');
  // Delete, apply, then undo brings it back, still editable.
  await page.click('[data-open-tool="text"]');
  await page.click('#text-delete');
  await applyTool(page, 'text');
  assert((await texts(page)).length === 0, 'deleted');
  await page.click('#btn-undo');
  await page.click('[data-open-tool="text"]');
  assert((await page.inputValue('#text-input')) === 'Uno', 'deleted box restored by undo and editable');
  await page.click('.sheet-panel[data-tool="text"] [data-cancel]');
  // Undo all the way: the original has no text, and its bitmap is untouched.
  for (let i = 0; i < 6; i++) if (!(await page.isDisabled('#btn-undo'))) await page.click('#btn-undo');
  assert((await texts(page)).length === 0, 'the original carries no text');
  assert(await page.evaluate(() => retouch.app.edits.current === window.__bmp0 && window.__bmp0.width === 241), 'back on the original bitmap');
  samePx(await px(page, 120, 90), [120, 90, 77, 255], 0, 'original pixels intact');
  await ctx.close();
}, { core: true });

test('text: history keeps a bitmap alive while any step still uses it', async () => {
  const { ctx, page } = await newApp();
  await load(page, gradient());
  const r = await page.evaluate(async () => {
    const R = retouch, e = () => R.app.edits;
    await R.commit('Resize', (src) => R.core.renderResize(src, 100, 75));
    const A = e().current;
    R.commitTexts('Text', [{ id: 1, text: 'a', font: 'sans', size: 10, colour: '#FFFFFF', align: 'center', outline: 0, outlineColour: '#000000', shadow: 'none', x: 50, y: 30, rotation: 0 }]);
    R.undo();
    // A new pixel step drops the redo tail, whose text step shares bitmap A.
    await R.commit('Resize', (src) => R.core.renderResize(src, 90, 60));
    R.undo();
    const aliveAfterBranch = e().current === A && A.width === 100;
    // Text step on A, then enough pixel steps to push A's own step off the bottom.
    R.commitTexts('Text', [{ id: 1, text: 'b', font: 'sans', size: 10, colour: '#FFFFFF', align: 'center', outline: 0, outlineColour: '#000000', shadow: 'none', x: 50, y: 30, rotation: 0 }]);
    for (let i = 0; i < R.HISTORY_DEPTH - 1; i++) await R.commit('Resize', (src) => R.core.renderResize(src, 80 + i, 60));
    const labels1 = e().stack.map((s) => s.label);
    const sharedKept = e().stack[1].bmp === A && A.width === 100;
    await R.commit('Resize', (src) => R.core.renderResize(src, 70, 50));
    const released = A.width === 0 && !e().stack.some((s) => s.bmp === A);
    return { aliveAfterBranch, labels1, sharedKept, released, len: e().stack.length };
  });
  assert(r.aliveAfterBranch, 'dropping a redo text step released a bitmap still in use');
  assert(r.labels1[1] === 'Text', 'the text step should now be the oldest edit: ' + r.labels1);
  assert(r.sharedKept, 'evicting a step released a bitmap a later text step still uses');
  assert(r.released, 'a bitmap no step uses any more must be released');
  assert(r.len === 11, 'stack length ' + r.len);
  await ctx.close();
}, { core: true });

test('text: live preview matches the export', async () => {
  const { ctx, page } = await newApp({ init: TEXT_INIT });
  await load(page, gradient());
  await textBox(page, { text: 'Hello\nretouch', font: 'serif', size: 28, colour: '#f2c94c', outline: 8, outlineColour: '#1f6f8b', shadow: 'soft', align: 'left' });
  await page.evaluate(() => { const b = retouch.app.edits.texts[0]; retouch.commitTexts('Text', [{ ...b, rotation: 0.4, x: 110, y: 95 }]); });
  // Show the photo at one device pixel per image pixel, on whole device pixels.
  const compare = (liveFromTool) => page.evaluate(async (liveFromTool) => {
    const R = retouch, v = R.view;
    v.fitMode = false; v.scale = 1 / v.dpr; v.tx = 8 / v.dpr; v.ty = 8 / v.dpr;
    R.draw();                                   // draw now, so nothing (a resize, a font) redraws in between
    const src = R.app.edits.current, w = src.width, h = src.height;
    const shown = v.canvas.getContext('2d').getImageData(8, 8, w, h).data;
    const t = liveFromTool ? R.tools.text.liveTexts() : R.app.edits.texts;
    const ex = await window.__pixels((await R.encodeImage(src, 'png', 1, 'x', t)).bytes);
    let sum = 0, max = 0, textPx = 0;
    for (let i = 0; i < shown.length; i++) {
      const d = Math.abs(shown[i] - ex.data[i]); sum += d; if (d > max) max = d;
    }
    const plain = R.readPixels(src);
    for (let i = 0; i < plain.length; i += 4) if (Math.abs(plain[i] - ex.data[i]) + Math.abs(plain[i + 2] - ex.data[i + 2]) > 30) textPx++;
    return { mean: sum / shown.length, max, textPx };
  }, liveFromTool);
  let r = await compare(false);
  assert(r.textPx > 800, 'the export should contain the text (' + r.textPx + ' changed pixels)');
  assert(r.mean < 0.05 && r.max <= 3, 'main view differs from the export: mean ' + r.mean + ', max ' + r.max);
  // Inside the tool, after moving the box and clearing the selection frame.
  await page.click('[data-open-tool="text"]');
  await page.evaluate(() => { const t = retouch.tools.text; t.replace({ ...t.box(), x: 150, rotation: -0.2 }); t.s.sel = null; t.sync(); });
  r = await compare(true);
  assert(r.mean < 0.05 && r.max <= 3, 'live preview in the tool differs from its export: mean ' + r.mean + ', max ' + r.max);
  await ctx.close();
}, { core: true });

test('text: outline, shadow, alignment and line spacing change the right pixels', async () => {
  const { ctx, page } = await newApp({ init: TEXT_INIT });
  const r = await page.evaluate(async () => {
    await retouch.fontsReady();
    const C = retouch.core, W = 300, H = 160;
    const base = { id: 1, text: 'HHHH', font: 'sans', size: 40, colour: '#FF00FF', align: 'center', outline: 0, outlineColour: '#00FF00', shadow: 'none', x: 150, y: 80, rotation: 0 };
    const bg = C.makeCanvas(W, H); const g = bg.getContext('2d'); g.fillStyle = 'rgb(150,150,150)'; g.fillRect(0, 0, W, H);
    const render = (boxes, zoom = 1) => {
      const c = C.makeCanvas(W * zoom, H * zoom), x = c.getContext('2d');
      x.drawImage(bg, 0, 0, W * zoom, H * zoom);
      x.setTransform(zoom, 0, 0, zoom, 0, 0);
      C.drawTexts(x, boxes);
      return { data: x.getImageData(0, 0, W * zoom, H * zoom).data, w: W * zoom };
    };
    const S = (img, rgb, tol, box) => window.__stats(img.data, img.w, rgb, tol, box);
    const out = {};
    const plain = render([base]);
    out.plainFill = S(plain, [255, 0, 255], 40); out.plainGreen = S(plain, [0, 255, 0], 60).n; out.plainDark = S(plain, [30, 30, 30], 40).n;
    const outlined = render([{ ...base, outline: 0.2 }]);
    const pair = render([base, { ...base, id: 2, y: 25, colour: '#00FFFF' }]);
    out.twoBoxes = { magenta: S(pair, [255, 0, 255], 40).n, cyan: S(pair, [0, 255, 255], 40).n };
    out.outFill = S(outlined, [255, 0, 255], 40); out.outGreen = S(outlined, [0, 255, 0], 60);
    // render() draws onto a copy of bg each time, so the fixture is reusable.
    out.renderTexts = (() => { const c = C.renderTexts(bg, [base]); const d = c.getContext('2d').getImageData(0, 0, W, H).data; return window.__stats(d, W, [255, 0, 255], 40).n; })();
    out.hard = S(render([{ ...base, shadow: 'hard' }]), [38, 38, 38], 30);
    out.hardFill = S(render([{ ...base, shadow: 'hard' }]), [255, 0, 255], 40);
    out.hardZoom = S(render([{ ...base, shadow: 'hard' }], 2), [38, 38, 38], 30);
    out.hardZoomFill = S(render([{ ...base, shadow: 'hard' }], 2), [255, 0, 255], 40);
    out.hardTurned = S(render([{ ...base, shadow: 'hard', rotation: Math.PI / 2, text: 'HH' }]), [38, 38, 38], 30);
    out.hardTurnedFill = S(render([{ ...base, shadow: 'hard', rotation: Math.PI / 2, text: 'HH' }]), [255, 0, 255], 40);
    const dark = (img) => { let n = 0; for (let i = 0; i < img.data.length; i += 4) if (img.data[i] < 140 && img.data[i + 1] < 140) n++; return n; };
    out.softDark = dark(render([{ ...base, shadow: 'soft' }]));
    out.softDarkZoom = dark(render([{ ...base, shadow: 'soft' }], 2));
    out.hardDark = dark(render([{ ...base, shadow: 'hard' }]));
    const two = { ...base, text: 'HHHHHH\nH', size: 30 };
    const m = C.textMeasure(two);
    for (const a of ['left', 'center', 'right']) {
      const img = render([{ ...two, align: a }]);
      out[a + 'Top'] = S(img, [255, 0, 255], 40, [0, 0, W, 80]);
      out[a + 'Low'] = S(img, [255, 0, 255], 40, [0, 81, W, H]);
    }
    out.m = { w: m.w, h: m.h, lh: m.lh, lines: m.lines.length };
    return out;
  });
  // Outline: green ring around the letters, letters still magenta on top.
  assert(r.plainGreen === 0, 'no outline colour without an outline');
  assert(r.outGreen.n > r.plainFill.n * 0.5, 'outline too small: ' + r.outGreen.n + ' green pixels');
  assert(r.outFill.n > r.plainFill.n * 0.8, 'the outline must sit under the letters, not over them: ' + r.outFill.n + ' vs ' + r.plainFill.n);
  near(r.outGreen.bw, r.plainFill.bw + 2 * 0.2 * 40, 3, 'outline reaches 0.2 x size beyond the letters (width)');
  near(r.outGreen.bh, r.plainFill.bh + 2 * 0.2 * 40, 3, 'outline reaches 0.2 x size beyond the letters (height)');
  assert(r.twoBoxes.cyan > 200 && r.twoBoxes.magenta === r.plainFill.n, 'every box is drawn: ' + JSON.stringify(r.twoBoxes));
  assert(r.renderTexts === r.plainFill.n, 'renderTexts draws the same text as drawTexts');
  // Shadow: hard shadow is the letters again, 0.06 x size down and right.
  assert(r.plainDark === 0, 'no shadow when shadow is off');
  assert(r.hard.n > 100, 'hard shadow missing');
  near(r.hard.maxX - r.hardFill.maxX, 0.06 * 40, 1, 'hard shadow offset x'); near(r.hard.maxY - r.hardFill.maxY, 0.06 * 40, 1, 'hard shadow offset y');
  near(r.hardZoom.maxX - r.hardZoomFill.maxX, 2 * 0.06 * 40, 1.5, 'shadow offset scales with the zoom');
  near(r.hardTurned.maxX - r.hardTurnedFill.maxX, 0.06 * 40, 1, 'turned box: shadow still falls right');
  near(r.hardTurned.maxY - r.hardTurnedFill.maxY, 0.06 * 40, 1, 'turned box: shadow still falls down');
  assert(r.softDark > r.hardDark * 1.1, 'soft shadow should spread wider than the hard one: ' + r.softDark + ' vs ' + r.hardDark);
  near(r.softDarkZoom / r.softDark, 4, 0.6, 'soft shadow blur scales with the zoom');
  // Alignment: the short second line sits at the left edge, centre, or right edge.
  near(r.m.lines, 2, 0, 'two lines'); near(r.m.h, 2 * 30 * 1.2, 1e-9, 'box height is lines x 1.2 x size');
  const left = 150 - r.m.w / 2, right = 150 + r.m.w / 2;
  for (const a of ['left', 'center', 'right']) near(r[a + 'Top'].cx, 150, 1.5, a + ': the long line is centred in the box');
  near(r.leftLow.minX, left, 5, 'left aligned short line'); near(r.rightLow.maxX, right, 5, 'right aligned short line');
  near(r.centerLow.cx, 150, 1.5, 'centred short line');
  near(r.leftLow.cy - r.leftTop.cy, 30 * 1.2, 2, 'line spacing');
  await ctx.close();
}, { core: true });

test('text: core maths for hit testing, pinch and angles', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(() => {
    const C = retouch.core;
    const b = { id: 7, x: 100, y: 50, rotation: Math.PI / 6, size: 20, text: 'x' };
    const m = { w: 80, h: 24 };
    const local = C.textToLocal(b, 100 + 30 * Math.cos(Math.PI / 6) - 5 * Math.sin(Math.PI / 6), 50 + 30 * Math.sin(Math.PI / 6) + 5 * Math.cos(Math.PI / 6));
    const back = C.textToImage(b, 30, 5);
    const hits = [[100, 50], [100 + 39 * Math.cos(Math.PI / 6), 50 + 39 * Math.sin(Math.PI / 6)], [100 + 41 * Math.cos(Math.PI / 6), 50 + 41 * Math.sin(Math.PI / 6)],
      [100 - 11 * Math.sin(Math.PI / 6), 50 + 11 * Math.cos(Math.PI / 6)], [100 - 13 * Math.sin(Math.PI / 6), 50 + 13 * Math.cos(Math.PI / 6)], [100 + 30, 50 - 20]]
      .map(([x, y]) => C.textHit(b, m, x, y));
    const slack = C.textHit(b, m, 100 + 43 * Math.cos(Math.PI / 6), 50 + 43 * Math.sin(Math.PI / 6), 4);
    const p = C.textPinch({ ...b, rotation: 0 }, { x: 90, y: 50 }, { x: 110, y: 50 }, { x: 200, y: 100 }, { x: 200, y: 140 });
    const p2 = C.textPinch({ ...b, rotation: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 30 });
    const angles = [C.textAngle(3 * Math.PI / 2), C.textAngle(-3 * Math.PI / 2), C.textAngle(Math.PI / 4), C.textAngle(7 * Math.PI / 3), C.textAngle(-Math.PI / 3)];
    const boxes = [{ ...b, id: 1, rotation: 0, text: 'WWWW' }, { ...b, id: 2, rotation: 0, text: 'WWWW' }, { ...b, id: 3, x: 400, rotation: 0 }];
    const pick = [C.textPick(boxes, 100, 50, 0), C.textPick(boxes, 400, 50, 0), C.textPick(boxes, 250, 50, 0), C.textPick(boxes, 100, 50 + 12.5, 1), C.textPick(boxes, 100, 50 + 14, 1)];
    const mm = C.textMeasure({ ...b, text: 'ab\ncdefgh\n', size: 50 });
    const font = C.textFont({ font: 'bebas', size: 33 });
    const one = { ...b, x: 10, y: 20, size: 10 };
    const rs = C.textsAfterResize([one], 100, 50, 200, 150)[0];
    const pd = C.textsAfterPad([one], { x: 5, y: 7 }, 0.5)[0];
    const ins = C.textsInside([{ id: 1, x: 0, y: 0 }, { id: 2, x: 100, y: 60 }, { id: 3, x: -0.1, y: 5 }, { id: 4, x: 5, y: 60.1 }, { id: 5, x: 100.1, y: 5 }, { id: 6, x: 50, y: -1 }, { id: 7, x: 80, y: 70 }], 100, 60).map((x) => x.id);
    return { local, back, hits, slack, p, p2, angles, pick, mm: { lines: mm.lines.length, lh: mm.lh, h: mm.h, w: mm.w }, font,
      rs: [rs.x, rs.y, rs.size, rs.rotation], pd: [pd.x, pd.y, pd.size, pd.rotation], ins };
  });
  near(r.local.x, 30, 1e-9, 'to local x'); near(r.local.y, 5, 1e-9, 'to local y');
  near(r.back.x, 100 + 30 * Math.cos(Math.PI / 6) - 5 * Math.sin(Math.PI / 6), 1e-9, 'to image x');
  near(r.back.y, 50 + 30 * Math.sin(Math.PI / 6) + 5 * Math.cos(Math.PI / 6), 1e-9, 'to image y');
  assert(JSON.stringify(r.hits) === JSON.stringify([true, true, false, true, false, false]), 'hit tests ' + JSON.stringify(r.hits));
  assert(r.slack, 'slack widens the hit area');
  near(r.p.x, 200, 1e-9, 'pinch x'); near(r.p.y, 120, 1e-9, 'pinch y'); near(r.p.size, 40, 1e-9, 'pinch size'); near(r.p.rotation, Math.PI / 2, 1e-9, 'pinch turn');
  near(r.p2.x, -150, 1e-9, 'pinch about a far point x'); near(r.p2.y, 300, 1e-9, 'pinch about a far point y'); near(r.p2.size, 60, 1e-9, 'pinch size 3x');
  [-Math.PI / 2, Math.PI / 2, Math.PI / 4, Math.PI / 3, -Math.PI / 3].forEach((want, i) => near(r.angles[i], want, 1e-9, 'angle ' + i));
  assert(JSON.stringify(r.pick) === JSON.stringify([2, 3, null, 2, null]), 'pick ' + JSON.stringify(r.pick));
  assert(r.mm.lines === 3 && r.mm.lh === 60 && r.mm.h === 180, 'measure ' + JSON.stringify(r.mm));
  assert(r.font === '400 33px "Bebas Neue"', 'font ' + r.font);
  assert(JSON.stringify(r.rs) === JSON.stringify([20, 60, 25, Math.PI / 6]), 'textsAfterResize ' + r.rs);
  assert(JSON.stringify(r.pd) === JSON.stringify([7.5, 13.5, 5, Math.PI / 6]), 'textsAfterPad ' + r.pd);
  assert(JSON.stringify(r.ins) === '[1,2]', 'textsInside ' + r.ins);
  await ctx.close();
}, { core: true });

test('text: boxes follow crop, resize and add canvas, and leave with what is cut away', async () => {
  const { ctx, page } = await newApp({ init: TEXT_INIT });
  await load(page, gradient());
  const box = { id: 1, text: 'Hi', font: 'sans', size: 20, colour: '#FF00FF', align: 'center', outline: 0, outlineColour: '#000000', shadow: 'none', x: 60, y: 50, rotation: 0.3 };
  await page.evaluate((b) => retouch.commitTexts('Text', [b]), box);
  // The photo pixel under the box centre must still be the same photo pixel (60, 50) afterwards.
  const under = async (b) => page.evaluate(([x, y]) => retouch.readPixels(retouch.app.edits.current, Math.floor(x), Math.floor(y), 1, 1), [b.x, b.y]);
  const check = async (what, want, tol = 1.5) => {
    const t = await texts(page);
    assert(t.length === 1, what + ': ' + t.length + ' boxes');
    const b = t[0];
    for (const k of Object.keys(want)) near(b[k], want[k], k === 'rotation' ? 1e-9 : 0.01, what + ' ' + k);
    samePx(await under(b), [60, 50, 77], tol + 1, what + ': box no longer over the same photo pixel');
    assert(b.text === 'Hi' && b.colour === '#FF00FF', what + ': box content changed');
    return b;
  };
  const sheet = async (tool, clicks) => { await page.click('[data-open-tool="' + tool + '"]'); for (const c of clicks) await page.click(c); await applyTool(page, tool); };
  const A = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  await sheet('crop', ['#crop-rotate']);
  await check('rotate 90', { x: GH - 50, y: 60, size: 20, rotation: 0.3 + Math.PI / 2 });
  await page.click('#btn-undo');
  await sheet('crop', ['#crop-rotate', '#crop-rotate', '#crop-rotate']);
  await check('rotate 270', { x: 50, y: GW - 60, rotation: A(0.3 - Math.PI / 2) });
  await page.click('#btn-undo');
  await sheet('crop', ['#crop-flip-h']);
  await check('flip H keeps letters readable', { x: GW - 60, y: 50, rotation: -0.3 });
  await page.click('#btn-undo');
  await sheet('crop', ['#crop-flip-v']);
  await check('flip V keeps letters readable', { x: 60, y: GH - 50, rotation: -0.3 });
  await page.click('#btn-undo');
  await sheet('crop', ['#crop-rotate', '#crop-flip-h']);
  await check('rotate then flip', { x: 50, y: 60, rotation: A(-0.3 - Math.PI / 2) });
  await page.click('#btn-undo');
  await sheet('crop', ['#crop-flip-h', '#crop-flip-v']);
  await check('flip both ways is a half turn', { x: GW - 60, y: GH - 50, rotation: A(0.3 + Math.PI) });
  await page.click('#btn-undo');
  await sheet('crop', ['#crop-ratios [data-ratio="1:1"]']);
  await check('1:1 crop', { x: 60 - 30, y: 50, size: 20, rotation: 0.3 });
  await page.click('#btn-undo');
  await page.click('[data-open-tool="crop"]');
  await page.fill('#crop-straighten', '10');
  await page.dispatchEvent('#crop-straighten', 'input');
  await applyTool(page, 'crop');
  await check('straighten 10 degrees', { size: 20, rotation: 0.3 + 10 * Math.PI / 180 }, 2.5);
  await page.click('#btn-undo');

  // Resize to 1080 wide: everything scales by the same factor.
  await sheet('resize', ['#resize-ig']);
  const k = 1080 / GW, kh = Math.round(GH * k) / GH;
  await check('resize', { x: 60 * k, y: 50 * kh, size: 20 * (k + kh) / 2, rotation: 0.3 });
  await page.click('#btn-undo');

  // Add canvas 4:5 white: the photo moves down 60 px and so does the box.
  await sheet('pad', ['#pad-ratios [data-ratio="4:5"]', '[data-fill="colour"]', '[data-colour="#FFFFFF"]']);
  const bp = await check('add canvas', { x: 60, y: 110, size: 20, rotation: 0.3 }, 0);
  // And the export draws it there.
  const s = await page.evaluate(() => window.__exportStats([255, 0, 255]));
  near(s.cx, bp.x, 2, 'exported text x after add canvas'); near(s.cy, bp.y, 4, 'exported text y after add canvas');
  await page.click('#btn-undo');

  // The add-canvas preview shows the box where it will land.
  await page.click('[data-open-tool="pad"]');
  await page.click('#pad-ratios [data-ratio="4:5"]');
  const pv = await page.evaluate(() => retouch.app.preview.texts[0]);
  near(pv.y, 110, 1e-9, 'add canvas preview carries the text');
  await page.click('.sheet-panel[data-tool="pad"] [data-cancel]');

  // An off-centre crop moves the box by the crop's top-left corner (21, 16).
  await page.evaluate(() => {
    const p = { quarter: 0, flipH: false, flipV: false, theta: 0, rect: { cx: -20, cy: -15, w: 160, h: 120 } };
    return retouch.commit('Crop', (img) => retouch.core.renderCrop(img, p), (t) => retouch.core.textsAfterCrop(t, 241, 181, p));
  });
  await check('off-centre crop', { x: 60 - 21, y: 50 - 16, size: 20, rotation: 0.3 }, 0);
  await page.click('#btn-undo');

  // A crop that cuts the box away removes it, says so, and undo brings it back.
  await page.evaluate(() => {
    const p = { quarter: 0, flipH: false, flipV: false, theta: 0, rect: { cx: 30, cy: 20, w: 100, h: 60 } };
    return retouch.commit('Crop', (img) => retouch.core.renderCrop(img, p), (t) => retouch.core.textsAfterCrop(t, 241, 181, p));
  });
  assert((await texts(page)).length === 0, 'box outside the crop should be removed');
  const note = await page.textContent('.notice[data-id="text-lost"]');
  assert(/1 text box was outside the new frame/.test(note), 'notice: ' + note);
  await page.click('#btn-undo');
  await check('undo restores the cut box', { x: 60, y: 50 });
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
}, { core: true });

test('text: export in every format carries the text and no metadata', async () => {
  const { ctx, page } = await newApp({ init: TEXT_INIT });
  const jpeg = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 240;
    const x = c.getContext('2d'); x.fillStyle = '#283c50'; x.fillRect(0, 0, 320, 240);
    return Array.from(new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95))).arrayBuffer()));
  }));
  await load(page, plantJpegMetadata(jpeg), 'PXL_text.jpg', 'image/jpeg');
  await textBox(page, { text: 'HHHH', size: 48, font: 'bebas', outline: 5, outlineColour: '#ffffff', shadow: 'hard' });
  await page.click('#btn-export');
  for (const fmt of ['jpeg', 'png', 'webp']) {
    await page.click('[data-format="' + fmt + '"]');
    await page.waitForFunction(() => !document.querySelector('#export-download').disabled);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-download')]);
    const bytes = fs.readFileSync(await dl.path());
    assert(imageFormat(bytes) === fmt, fmt + ': exported ' + imageFormat(bytes));
    const left = findImageMetadata(bytes);
    assert(!left.length, fmt + ': export with text carries ' + left.join(', '));
    const s = await page.evaluate(async (arr) => { const p = await window.__pixels(arr); return window.__stats(p.data, p.w, [255, 0, 255], 60); }, Array.from(bytes));
    assert(s.n > 200, fmt + ': text missing from the export (' + s.n + ' px)');
    near(s.cx, 160, 2, fmt + ': text centre x');
  }
  // Hold: original in Export shows the original, without the text.
  const b = await page.locator('.sheet-panel[data-tool="export"] [data-hold]').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => window.retouch.app.showing === 'before');
  const shown = await page.evaluate(() => { const R = retouch; const d = R.app.edits; return R.app.holding && d.stack[0].texts.length === 0; });
  await page.mouse.up();
  assert(shown, 'export hold shows the original');
  await ctx.close();
}, { core: true });

test('text: sheet controls, typing mode and the stage stays usable', async () => {
  const { ctx, page } = await newApp();
  await load(page, gradient());
  await page.click('[data-open-tool="text"]');
  assert((await page.evaluate(() => retouch.tools.text.s.texts.length)) === 1, 'opening Text with no boxes adds one');
  assert((await page.evaluate(() => retouch.tools.text.box().text)) === '', 'a new box starts empty');
  assert((await page.inputValue('#text-input')) === '', 'the text field starts empty, showing only its placeholder');
  assert((await page.getAttribute('#text-input', 'placeholder')) === 'Type here', 'placeholder');
  assert(await page.evaluate(() => document.activeElement === document.querySelector('#text-input')), 'the text field takes the cursor');
  // Applying an untouched empty box adds nothing to the history.
  await applyTool(page, 'text');
  assert((await page.evaluate(() => [retouch.app.edits.stack.length, retouch.app.edits.texts.length])).join() === '1,0', 'empty box must not make a step');
  await page.click('[data-open-tool="text"]');
  await page.click('#text-add');
  assert((await page.inputValue('#text-input')) === '' && await page.evaluate(() => document.activeElement === document.querySelector('#text-input')), 'Add gives an empty, focused field');
  await page.click('.sheet-panel[data-tool="text"] [data-cancel]');
  await page.click('[data-open-tool="text"]');
  await page.fill('#text-input', 'Caption');
  await page.focus('#text-input');
  assert(await page.isHidden('#text-style'), 'style rows hide while typing');
  const stage = await page.locator('#stage').boundingBox();
  assert(stage.height > 500, 'photo area while typing ' + stage.height);
  // Tapping the photo ends typing.
  const v = await page.locator('#view').boundingBox();
  await page.mouse.click(v.x + 10, v.y + v.height - 10);   // below the hint notice
  assert(await page.isVisible('#text-style'), 'style rows return after typing');
  assert((await page.evaluate(() => retouch.tools.text.s.sel)) === null, 'a tap on empty photo clears the selection');
  assert(await page.isDisabled('#text-delete'), 'nothing to delete with no selection');
  // Tap the box to select it again.
  const c = await onScreen(page, GW / 2, GH / 2);
  await page.mouse.click(c.x, c.y);
  assert((await page.evaluate(() => retouch.tools.text.s.sel)) === 1, 'tap selects the box');
  assert(await page.isVisible('#text-fonts') && await page.isHidden('[data-text-panel="colour"]') && await page.isHidden('[data-text-panel="style"]'), 'Font tab shows first, the others wait');
  await page.click('#text-fonts [data-font="hand"]');
  await page.click('[data-text-tab="style"]');
  assert(await page.isHidden('#text-fonts') && await page.isVisible('#text-outline'), 'Style tab swaps the settings');
  await page.click('[data-align="right"]');
  await page.click('[data-text-tab="colour"]');
  await page.click('[data-target="outline"]');
  await page.click('[data-tcolour="#E2556B"]');
  const b = await page.evaluate(() => retouch.tools.text.box());
  assert(b.font === 'hand' && b.align === 'right' && b.outlineColour === '#E2556B' && b.outline > 0, 'controls: ' + JSON.stringify(b));
  assert((await page.getAttribute('[data-tcolour="#E2556B"]', 'aria-pressed')) === 'true', 'outline swatch pressed');
  // Empty boxes are dropped on apply.
  await page.click('#text-add');
  await page.fill('#text-input', '   ');
  await applyTool(page, 'text');
  assert((await page.evaluate(() => retouch.app.edits.texts.length)) === 1, 'blank box dropped');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

/* ---------- Phase 3: remove background ---------- */

// In-page helpers. __fakeSeg stands in for the model: a pixel is "person" when its
// colour is within tol of rgb, and the answer comes back blocky and soft (a quarter
// of the size, then blurred), the way the real model's mask looks next to a photo.
const BG_INIT = () => {
  window.__fakeSeg = (rgb, tol = 60, cell = 4) => {
    window.retouch.segmenter.override = (canvas) => {
      const w = canvas.width, h = canvas.height, d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
      const cw = Math.ceil(w / cell), ch = Math.ceil(h / cell), m = new Float32Array(cw * ch), n = new Float32Array(cw * ch);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = Math.floor(y / cell) * cw + Math.floor(x / cell), o = (y * w + x) * 4;
        n[i]++;
        if (Math.abs(d[o] - rgb[0]) + Math.abs(d[o + 1] - rgb[1]) + Math.abs(d[o + 2] - rgb[2]) <= tol) m[i]++;
      }
      for (let i = 0; i < m.length; i++) {
        m[i] /= n[i];
      }
      // Blur by hand (not with the app's own box filter) so a bug there cannot hide here.
      const b = new Float32Array(m.length);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        let s = 0, k = 0;
        for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) {
          const X = x + u, Y = y + v;
          if (X >= 0 && X < cw && Y >= 0 && Y < ch) { s += m[Y * cw + X]; k++; }
        }
        b[y * cw + x] = s / k;
      }
      return { w: cw, h: ch, data: b };
    };
  };
  // Skin stand-in: the same blocky answer, given as skin, all of it counted as face.
  window.__fakeSkin = (rgb, tol = 60, cell = 4) => {
    window.__fakeSeg(rgb, tol, cell);
    const person = window.retouch.segmenter.override;
    window.retouch.segmenter.override = null;
    window.retouch.segmenter.skinOverride = (canvas) => {
      const m = person(canvas);
      let sum = 0; for (const v of m.data) sum += v;
      return { ...m, face: sum / m.data.length };
    };
  };
  window.__px = (c, x, y) => Array.from(c.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data);
};
const SKIN = [210, 160, 130], SKY = [40, 90, 200];
// 300 x 200: sky, and a "person" block from x 100 to 199 that runs off the bottom edge.
const personPng = () => makePng(300, 200, (x, y) => (x >= 100 && x < 200 && y >= 50 ? SKIN : SKY).concat(255));
async function bgReady(page) {
  await page.click('[data-open-tool="bg"]');
  await page.waitForFunction(() => window.retouch.tools.bg.pv && window.retouch.app.busyCount === 0, null, { timeout: 30000 });
}
// One finger on the stage through image points pts (screen positions worked out
// from the current zoom), as a touch.
const brush = (page, pts) => page.evaluate((pts) => {
  const c = document.querySelector('#view'), r = c.getBoundingClientRect(), v = retouch.view;
  const at = (p) => ({ clientX: r.left + v.tx + p[0] * v.scale, clientY: r.top + v.ty + p[1] * v.scale });
  const ev = (type, p) => c.dispatchEvent(new PointerEvent(type, { pointerId: 31, ...at(p), bubbles: true, pointerType: 'touch', isPrimary: true }));
  ev('pointerdown', pts[0]);
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    for (let t = 1; t <= 8; t++) ev('pointermove', [a[0] + (b[0] - a[0]) * t / 8, a[1] + (b[1] - a[1]) * t / 8]);
  }
  ev('pointerup', pts[pts.length - 1]);
}, pts);

test('background core: box mean, resample, person probability and edge ramp (independent check)', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(() => {
    const core = retouch.core;
    // Box mean against a direct sum over the window, cut off at the edges.
    const w = 23, h = 17, a = new Float32Array(w * h).map((_, i) => Math.sin(i * 12.9898) * 0.5 + 0.5);
    let boxErr = 0;
    for (const rad of [0, 1, 3, 30]) {
      const got = core.boxMean(Float32Array.from(a), w, h, rad);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let v = Math.max(0, y - rad); v <= Math.min(h - 1, y + rad); v++) for (let u = Math.max(0, x - rad); u <= Math.min(w - 1, x + rad); u++) { s += a[v * w + u]; n++; }
        boxErr = Math.max(boxErr, Math.abs(got[y * w + x] - s / n));
      }
    }
    // Resample: 2 x 2 to 4 x 4 with centres lined up, and a 3 x 1 ramp to 6 x 2.
    const up = Array.from(core.resampleMask(new Float32Array([0, 1, 0, 1]), 2, 2, 4, 4)).map((v) => +v.toFixed(4));
    const ramp = Array.from(core.resampleMask(new Float32Array([0, 0.5, 1]), 3, 1, 6, 2)).map((v) => +v.toFixed(4));
    const same = Array.from(core.resampleMask(new Float32Array([0.2, 0.4, 0.6, 0.8, 1, 0]), 3, 2, 3, 2)).map((v) => +v.toFixed(4));
    // Uneven scale: x doubled, y kept.
    const uneven = Array.from(core.resampleMask(new Float32Array([0, 1, 1, 0]), 2, 2, 4, 2)).map((v) => +v.toFixed(4));
    const person = Array.from(core.bgPerson(new Float32Array([0, 0.25, 1, 1.2, -0.1]))).map((v) => +v.toFixed(4));
    const lo = core.BG_EDGE_LO, hi = core.BG_EDGE_HI;
    const curve = [lo - 0.1, lo, (lo + hi) / 2, hi, hi + 0.1, lo + (hi - lo) * 0.25].map((q) => +core.bgCurve(q).toFixed(4));
    // Faint haze (under 0.2) is cleared, near-certain person (over 0.8) is kept whole,
    // and the ramp is centred on an even chance.
    const haze = [0.15, 0.5, 0.85].map((q) => +core.bgCurve(q).toFixed(4));
    // Share of the photo the model calls a person, from a mask at the guide's size.
    const g = core.makeCanvas(40, 30), gm = new Float32Array(1200).map((_, i) => (i % 40 < 10 ? 1 : 0));
    const coverage = +core.bgModel(g, { w: 40, h: 30, data: gm }).coverage.toFixed(4);
    const found = +core.bgModel(g, { w: 40, h: 30, data: gm }).found.toFixed(4);
    // The real model never says 0: on a photo with no one in it, "person" is a faint
    // 0.08 everywhere. That averages to 8 %, but none of it is found.
    const hazeModel = core.bgModel(g, { w: 40, h: 30, data: new Float32Array(1200).fill(0.08) });
    const hazeShares = [+hazeModel.coverage.toFixed(4), +hazeModel.found.toFixed(4)];
    // An even chance counts as found, just under it does not (a third at each, a third at 0).
    const edgeFound = +core.bgModel(g, { w: 40, h: 30, data: new Float32Array(1200).map((_, i) => [0.5, 0.49, 0][i % 3]) }).found.toFixed(4);
    // putAlpha over a box writes only that box, from the matching part of the map.
    const pc = core.makeCanvas(30, 20), pctx = pc.getContext('2d', { willReadFrequently: true });
    const amap = new Float32Array(600).map((_, i) => (i % 30) / 29);
    core.STRIP_PIXELS = 7;                                              // force many strips
    core.putAlpha(pctx, amap, 30, 20, { x0: 10, y0: 5, x1: 25, y1: 15 });
    core.STRIP_PIXELS = 1000000;
    const pa = (x, y) => pctx.getImageData(x, y, 1, 1).data[3];
    const put = [pa(9, 8), pa(10, 8), pa(24, 14), pa(25, 14), pa(17, 4), pa(17, 5), pa(17, 15), pa(20, 10)];
    const guideDims = [core.bgGuideDims(4080, 3072), core.bgGuideDims(3072, 4080), core.bgGuideDims(300, 200)];
    return { boxErr, up, ramp, same, uneven, person, curve, lo, hi, guideDims, guideLong: core.BG_GUIDE_LONG, haze, coverage, found, hazeShares, edgeFound, put };
  });
  assert(r.boxErr < 1e-5, 'box mean differs from a direct sum by ' + r.boxErr);
  assert(r.up.join() === '0,0.25,0.75,1,0,0.25,0.75,1,0,0.25,0.75,1,0,0.25,0.75,1', 'resample 2x2 to 4x4: ' + r.up);
  assert(r.ramp.join() === '0,0.125,0.375,0.625,0.875,1,0,0.125,0.375,0.625,0.875,1', 'resample ramp: ' + r.ramp);
  assert(r.same.join() === '0.2,0.4,0.6,0.8,1,0', 'resample to the same size copies: ' + r.same);
  assert(r.uneven.join() === '0,0.25,0.75,1,1,0.75,0.25,0', 'resample x only: ' + r.uneven);
  assert(r.person.join() === '1,0.75,0,0,1', 'person = 1 - background, clamped: ' + r.person);
  assert(r.lo > 0 && r.hi < 1 && r.lo < r.hi, 'ramp ends ' + r.lo + ', ' + r.hi);
  assert(r.curve.join() === '0,0,0.5,1,1,0.1563', 'edge ramp (smoothstep): ' + r.curve);
  assert(r.guideLong === 1024, 'guide long edge ' + r.guideLong);
  assert(r.haze.join() === '0,0.5,1', 'haze cleared, certain kept, centred: ' + r.haze);
  assert(r.coverage === 0.25, 'person share ' + r.coverage);
  assert(r.found === 0.25, 'person found ' + r.found);
  assert(r.hazeShares.join() === '0.08,0', 'faint haze averages 8 % but none is found: ' + r.hazeShares);
  assert(r.edgeFound === 0.3333, 'an even chance is found, 0.49 is not: ' + r.edgeFound);
  assert(r.put.join() === '0,88,211,0,0,149,0,176', 'putAlpha over a box: ' + r.put);
  assert(JSON.stringify(r.guideDims) === '[{"w":1024,"h":771},{"w":771,"h":1024},{"w":300,"h":200}]', 'guide sizes ' + JSON.stringify(r.guideDims));
  await ctx.close();
}, { core: true });

test('background core: guided upscale snaps a rough, offset mask onto the photo edge', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(() => {
    const core = retouch.core;
    const W = 768, H = 576, R0 = 150, CX = 384, CY = 288;
    const c = core.makeCanvas(W, H), x = c.getContext('2d', { willReadFrequently: true });
    // Two-tone striped background, a skin-coloured disc for the person.
    for (let i = 0; i < W; i += 12) { x.fillStyle = (i / 12) % 2 ? 'rgb(60,120,190)' : 'rgb(90,150,210)'; x.fillRect(i, 0, 12, H); }
    x.fillStyle = 'rgb(205,160,130)'; x.beginPath(); x.arc(CX, CY, R0, 0, 2 * Math.PI); x.fill();
    // The rough mask: 1/16 scale, blurred, and drawn shift px too big or too small.
    const rough = (shift) => {
      const cw = W / 16, ch = H / 16, m = new Float32Array(cw * ch);
      for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
        let n = 0;
        for (let u = 0; u < 4; u++) for (let v = 0; v < 4; v++) if (Math.hypot((i + (u + 0.5) / 4) * 16 - CX, (j + (v + 0.5) / 4) * 16 - CY) < R0 + shift) n++;
        m[j * cw + i] = n / 16;
      }
      return { w: cw, h: ch, data: m };
    };
    const measure = (a) => {
      let err = 0, width = 0, inside = 1, outside = 0;
      for (let k = 0; k < 16; k++) {
        const th = k * Math.PI / 8 + 0.1, cs = Math.cos(th), sn = Math.sin(th);
        const at = (rr) => a[Math.round(CY + rr * sn - 0.5) * W + Math.round(CX + rr * cs - 0.5)];
        let r90 = null, r50 = null, r10 = null;
        for (let rr = R0 - 40; rr < R0 + 40; rr += 0.25) { const v = at(rr); if (r90 === null && v < 0.9) r90 = rr; if (r50 === null && v < 0.5) r50 = rr; if (r10 === null && v < 0.1) r10 = rr; }
        err = Math.max(err, Math.abs(r50 - R0)); width = Math.max(width, r10 - r90);
        inside = Math.min(inside, at(R0 - 25)); outside = Math.max(outside, at(R0 + 25));
      }
      let haze = 0;
      for (let py = 0; py < H; py += 2) for (let px = 0; px < W; px += 2) if (Math.hypot(px + 0.5 - CX, py + 0.5 - CY) > R0 + 30) haze = Math.max(haze, a[py * W + px]);
      return { err, width, inside, outside, haze };
    };
    const out = {};
    for (const shift of [0, 6, -6]) {
      const m = rough(shift);
      out['guided' + shift] = measure(core.bgGuided(c, W, H, core.bgModel(c, m)));
      out['plain' + shift] = measure(core.resampleMask(m.data, m.w, m.h, W, H).map(core.bgCurve));
    }
    // The model fitted on a half-size guide, applied at full size: edges stay crisp.
    const half = core.makeCanvas(W / 2, H / 2);
    half.getContext('2d').drawImage(c, 0, 0, W / 2, H / 2);
    core.STRIP_PIXELS = 10000;                                          // full size read in many strips
    out.fromHalf = measure(core.bgGuided(c, W, H, core.bgModel(half, rough(6))));
    core.STRIP_PIXELS = 1000000;
    // Properties of the filter itself: a flat mask stays flat; a mask equal to the
    // red channel comes back as the red channel.
    const g = x.getImageData(0, 0, W, H).data, n = W * H, I = new Float32Array(3 * n), red = new Float32Array(n);
    for (let i = 0; i < n; i++) { I[3 * i] = g[4 * i] / 255; I[3 * i + 1] = g[4 * i + 1] / 255; I[3 * i + 2] = g[4 * i + 2] / 255; red[i] = I[3 * i]; }
    const apply = (m) => { let e = 0; for (let i = 0; i < n; i += 37) e = Math.max(e, Math.abs(m.ar[i] * I[3 * i] + m.ag[i] * I[3 * i + 1] + m.ab[i] * I[3 * i + 2] + m.b[i] - m.want(i))); return e; };
    const flat = core.guidedCoeffs(I, new Float32Array(n).fill(0.3), W, H, 8, 1e-3); flat.want = () => 0.3;
    const lin = core.guidedCoeffs(I, red, W, H, 8, 1e-6); lin.want = (i) => red[i];
    out.flatErr = apply(flat); out.linErr = apply(lin);
    // The whole filter against a slow, direct reading of He, Sun and Tang on a small random
    // photo: per window, means and the colour covariance, a 3 x 3 solve by elimination,
    // then each pixel averages the a and b of every window that covers it.
    const w = 13, h = 9, rad = 2, eps = 0.01, N = w * h;
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const Ir = new Float32Array(3 * N).map(rnd), pr = new Float32Array(N).map(rnd);
    const win = (cx, cy, f) => { let s = 0, k = 0; for (let y = Math.max(0, cy - rad); y <= Math.min(h - 1, cy + rad); y++) for (let x = Math.max(0, cx - rad); x <= Math.min(w - 1, cx + rad); x++) { s += f(y * w + x); k++; } return s / k; };
    const solve = (M, v) => {
      const A = M.map((row, i) => [...row, v[i]]);
      for (let c = 0; c < 3; c++) {
        let piv = c; for (let i = c + 1; i < 3; i++) if (Math.abs(A[i][c]) > Math.abs(A[piv][c])) piv = i;
        [A[c], A[piv]] = [A[piv], A[c]];
        for (let i = 0; i < 3; i++) if (i !== c) { const f = A[i][c] / A[c][c]; for (let j = c; j < 4; j++) A[i][j] -= f * A[c][j]; }
      }
      return A.map((row, i) => row[3] / row[i]);
    };
    const ak = [], bk = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const mu = [0, 1, 2].map((c) => win(x, y, (i) => Ir[3 * i + c])), mp = win(x, y, (i) => pr[i]);
      const S = [0, 1, 2].map((c) => [0, 1, 2].map((d) => win(x, y, (i) => Ir[3 * i + c] * Ir[3 * i + d]) - mu[c] * mu[d] + (c === d ? eps : 0)));
      const cv = [0, 1, 2].map((c) => win(x, y, (i) => Ir[3 * i + c] * pr[i]) - mu[c] * mp);
      const a = solve(S, cv);
      ak.push(a); bk.push(mp - a[0] * mu[0] - a[1] * mu[1] - a[2] * mu[2]);
    }
    const ref = { ar: (i) => win(i % w, Math.floor(i / w), (j) => ak[j][0]), ag: (i) => win(i % w, Math.floor(i / w), (j) => ak[j][1]),
      ab: (i) => win(i % w, Math.floor(i / w), (j) => ak[j][2]), b: (i) => win(i % w, Math.floor(i / w), (j) => bk[j]) };
    const gc = core.guidedCoeffs(Ir, pr, w, h, rad, eps);
    out.refErr = Math.max(...['ar', 'ag', 'ab', 'b'].map((k) => Math.max(...Array.from(gc[k]).map((v, i) => Math.abs(v - ref[k](i))))));
    // A photo of one flat colour has no colour variance at all: eps alone keeps the
    // solve finite, and the result is the mask, smoothed.
    const flatI = new Float32Array(3 * N).fill(0.5), fc = core.guidedCoeffs(flatI, pr, w, h, rad, eps);
    out.flatPhoto = ['ar', 'ag', 'ab', 'b'].every((k) => fc[k].every(Number.isFinite)) && Math.max(...Array.from(fc.ar).map(Math.abs)) < 1e-6;
    // Reading coefficients back at another size: b = 0.2 to 0.8 across a 2 x 2 grid, read
    // at 4 x 2, gives the same values as resampling b; and each colour weight picks its channel.
    const rd = (m, data, W, H) => { const o = new Float32Array(W * H); core.guidedApply(data, W, H, 0, H, m, o); return Array.from(o).map((v) => +v.toFixed(4)); };
    const z = new Float32Array(4);
    const bmap = new Float32Array([0.2, 0.8, 0.2, 0.8]);
    out.readB = rd({ ar: z, ag: z, ab: z, b: bmap, w: 2, h: 2 }, new Uint8ClampedArray(32), 4, 2);
    out.readBWant = Array.from(core.resampleMask(bmap, 2, 2, 4, 2)).map((v) => +core.bgCurve(v).toFixed(4));
    const one = new Float32Array(4).fill(1), px1 = new Uint8ClampedArray([51, 128, 204, 255]);
    out.readC = [rd({ ar: one, ag: z, ab: z, b: z, w: 2, h: 2 }, px1, 1, 1)[0], rd({ ar: z, ag: one, ab: z, b: z, w: 2, h: 2 }, px1, 1, 1)[0], rd({ ar: z, ag: z, ab: one, b: z, w: 2, h: 2 }, px1, 1, 1)[0]];
    out.readCWant = [51, 128, 204].map((v) => +core.bgCurve(v / 255).toFixed(4));
    return out;
  });
  for (const shift of [0, 6, -6]) {
    const g = r['guided' + shift], p = r['plain' + shift];
    assert(g.err <= 1.5, 'mask ' + shift + ' px off: edge lands ' + g.err + ' px from the photo edge');
    assert(g.width <= 3, 'mask ' + shift + ' px off: edge is ' + g.width + ' px wide (10 to 90 %)');
    assert(g.inside >= 0.98 && g.outside <= 0.02 && g.haze <= 0.02, 'mask ' + shift + ': inside ' + g.inside + ', outside ' + g.outside + ', haze ' + g.haze);
    assert(p.width >= 6, 'the plain upscale should be soft, which is the point of the filter: ' + p.width);
  }
  assert(r.plain6.err >= 4, 'an offset mask upscaled plainly stays offset: ' + r.plain6.err);
  assert(r.fromHalf.err <= 1.5 && r.fromHalf.width <= 3, 'half-size guide, full-size result: ' + JSON.stringify(r.fromHalf));
  assert(r.flatErr < 1e-3, 'flat mask changed by ' + r.flatErr);
  assert(r.linErr < 0.02, 'a mask that is the red channel came back off by ' + r.linErr);
  assert(r.refErr < 1e-4, 'guided filter differs from the direct reading by ' + r.refErr);
  assert(r.flatPhoto, 'flat photo: coefficients must stay finite, with no colour weight');
  assert(r.readB.every((v, i) => Math.abs(v - r.readBWant[i]) < 1e-3) && r.readB[0] !== r.readB[1], 'coefficients read back at 4 x 2: ' + r.readB + ' want ' + r.readBWant);
  assert(r.readC.every((v, i) => Math.abs(v - r.readCWant[i]) < 1e-3), 'colour weights pick their channel: ' + r.readC + ' want ' + r.readCWant);
  await ctx.close();
}, { core: true });

test('background core: feather, brush strokes and the backdrop fills', async () => {
  const { ctx, page } = await newApp({ init: BG_INIT });
  const r = await page.evaluate(() => {
    const core = retouch.core, out = {};
    // Feather against a direct double box blur, and no fading at the frame.
    const W = 120, H = 40, step = new Float32Array(W * H).map((_, i) => (i % W < 60 ? 1 : 0));
    const f = 8 / W, rad = 4;                                          // r = round(f * 120 / 2) = 4
    const got = core.bgFeather(Float32Array.from(step), W, H, f);
    const box1 = (a) => { const o = new Float32Array(a.length); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, n = 0; for (let v = Math.max(0, y - rad); v <= Math.min(H - 1, y + rad); v++) for (let u = Math.max(0, x - rad); u <= Math.min(W - 1, x + rad); u++) { s += a[v * W + u]; n++; } o[y * W + x] = s / n; } return o; };
    const want = box1(box1(step));
    out.featherErr = Math.max(...got.map((v, i) => Math.abs(v - want[i])));
    out.featherRow = Array.from(got.subarray(50, 70)).map((v) => +v.toFixed(3));
    out.featherEnds = [got[0], got[W - 1], got[(H - 1) * W], got[H * W - 1]];
    out.featherRowsSame = [0, H - 1].every((y) => got.subarray(y * W, y * W + W).every((v, x) => Math.abs(v - got[20 * W + x]) < 1e-6));
    out.featherOff = core.bgFeather(Float32Array.from(step), W, H, 0).every((v, i) => v === step[i]);
    // Brush: a keep stroke on nothing, along y = 50.5 from x 20 to 80, radius 10.
    const A = (v) => new Float32Array(100 * 100).fill(v);
    const paint = (a, W, H, st, k) => { core.paintStroke(a, W, H, st, k); return a; };
    const keep = { mode: 'keep', r: 10, pts: [{ x: 20, y: 50.5 }, { x: 80, y: 50.5 }] };
    const k1 = paint(A(0), 100, 100, keep);
    const at = (a, x, y) => +a[y * 100 + x].toFixed(3);
    out.keep = [at(k1, 50, 50), at(k1, 50, 45), at(k1, 50, 42), at(k1, 50, 40), at(k1, 50, 58), at(k1, 50, 60), at(k1, 5, 50), at(k1, 95, 50), at(k1, 89, 50)];
    // Pixels (50, 42) and (50, 58) have their centres 8 px from the line: inside the 10 px
    // radius, in the soft outer 35 %, so (10 - 8) / 3.5 = 0.571. (89, 50) is 9.5 px past
    // the end: 0.5 / 3.5 = 0.143. (50, 40) and (50, 60) are exactly 10 px away: nothing.
    const e1 = paint(A(1), 100, 100, { ...keep, mode: 'erase' });
    out.eraseIsMirror = e1.every((v, i) => Math.abs(v - (1 - k1[i])) < 1e-6);
    const half = paint(A(0.5), 100, 100, keep);
    out.keepHalf = [at(half, 50, 42), at(half, 50, 30)];
    // Going back and forth over the same line paints the same as once.
    const back = paint(A(0), 100, 100, { mode: 'keep', r: 10, pts: [{ x: 20, y: 50.5 }, { x: 80, y: 50.5 }, { x: 30, y: 50.5 }, { x: 80, y: 50.5 }] });
    out.backSame = back.every((v, i) => Math.abs(v - k1[i]) < 1e-6);
    // Order matters: keep then erase leaves it cut, erase then keep leaves it kept.
    const ke = core.bgStrokes(A(0.5), 100, 100, [keep, { ...keep, mode: 'erase' }]);
    const ek = core.bgStrokes(A(0.5), 100, 100, [{ ...keep, mode: 'erase' }, keep]);
    out.order = [at(ke, 50, 50), at(ek, 50, 50)];
    // Every pixel against a direct reckoning: distance from the pixel centre to the
    // nearest point of the stroke, full inside 65 % of the radius, fading to 0 at it.
    const ref = (W, H, st, k) => {
      const a = new Float32Array(W * H), r = st.r * k;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let d = Infinity;
        for (let i = 0; i < st.pts.length; i++) {
          const P = st.pts[i], Q = st.pts[Math.min(i + 1, st.pts.length - 1)];
          for (let t = 0; t <= 1; t += 1 / 512) d = Math.min(d, Math.hypot(x + 0.5 - k * (P.x + (Q.x - P.x) * t), y + 0.5 - k * (P.y + (Q.y - P.y) * t)));
        }
        a[y * W + x] = d >= r ? 0 : d <= 0.65 * r ? 1 : (r - d) / (0.35 * r);
      }
      return a;
    };
    const maxDiff = (u, v) => u.reduce((m, x, i) => Math.max(m, Math.abs(x - v[i])), 0);
    // A tap is one point: a round dot. Scaled by k = 0.5: the same stroke at half size.
    const tap = { mode: 'keep', r: 6, pts: [{ x: 30, y: 30 }] };
    const zig = { mode: 'keep', r: 7, pts: [{ x: 10, y: 10 }, { x: 60, y: 30 }, { x: 20, y: 80 }] };
    out.refDiff = [maxDiff(k1, ref(100, 100, keep, 1)), maxDiff(paint(A(0), 100, 100, tap), ref(100, 100, tap, 1)),
      maxDiff(paint(new Float32Array(2500), 50, 50, keep, 0.5), ref(50, 50, keep, 0.5)), maxDiff(paint(A(0), 100, 100, zig), ref(100, 100, zig, 1)),
      maxDiff(paint(new Float32Array(3600), 60, 60, zig, 0.6), ref(60, 60, zig, 0.6))];
    out.bounds = core.strokeBounds({ r: 10, pts: [{ x: 5, y: 50 }, { x: 80, y: 95 }] }, 1, 100, 100);
    // Backdrops: a 40 x 30 photo, left half kept, right half cut.
    const src = core.makeCanvas(40, 30), sx = src.getContext('2d');
    sx.fillStyle = 'rgb(200,100,50)'; sx.fillRect(0, 0, 20, 30); sx.fillStyle = 'rgb(20,40,220)'; sx.fillRect(20, 0, 20, 30);
    const alpha = new Float32Array(40 * 30).map((_, i) => (i % 40 < 20 ? 1 : 0));
    const px = (c, x, y) => window.__px(c, x, y);
    const t = core.renderCutout(src, alpha, 40, 30, { fill: 'transparent' });
    const col = core.renderCutout(src, alpha, 40, 30, { fill: 'colour', colour: '#10E020' });
    const blur = core.renderCutout(src, alpha, 40, 30, { fill: 'blur', blur: 0.5 });
    const veil = core.renderCutout(src, alpha, 40, 30, { fill: 'veil' });
    const halfA = core.renderCutout(src, new Float32Array(1200).fill(0.5), 40, 30, { fill: 'colour', colour: '#FFFFFF' });
    out.fills = { t: [px(t, 5, 5), px(t, 35, 5)], col: [px(col, 5, 5), px(col, 35, 5)], blur: [px(blur, 5, 5), px(blur, 35, 5), px(blur, 21, 15)], veil: [px(veil, 5, 5), px(veil, 35, 5)], half: px(halfA, 5, 5), dims: [t.width, t.height] };
    return out;
  });
  assert(r.featherErr < 1e-5, 'feather differs from a double box blur by ' + r.featherErr);
  assert(r.featherRow[0] === 1 && r.featherRow[19] === 0 && r.featherRow.every((v, i) => i === 0 || v <= r.featherRow[i - 1]), 'feather ramp ' + r.featherRow);
  assert(Math.abs(r.featherRow[9] + r.featherRow[10] - 1) < 1e-3, 'feather is centred on the edge ' + r.featherRow);
  assert(r.featherEnds.join() === '1,0,1,0', 'feather must not fade the frame edges: ' + r.featherEnds);
  assert(r.featherRowsSame, 'feather faded the top or bottom row');
  assert(r.featherOff, 'feather 0 must change nothing');
  assert(r.keep.join() === '1,1,0.571,0,0.571,0,0,0,0.143', 'keep stroke ' + r.keep);
  assert(r.eraseIsMirror, 'erase on a full mask must mirror keep on an empty one');
  assert(r.keepHalf.join() === '0.786,0.5', 'keep pulls towards 1 by the coverage: ' + r.keepHalf);
  assert(r.backSame, 'a stroke over itself must not paint twice');
  assert(r.order.join() === '0,1', 'later strokes win: ' + r.order);
  assert(r.refDiff.every((d) => d < 0.01), 'strokes (line, tap, half size, zigzag, zigzag at 0.6) against a direct reckoning: ' + r.refDiff);
  assert(JSON.stringify(r.bounds) === '{"x0":0,"y0":40,"x1":90,"y1":100}', 'bounds ' + JSON.stringify(r.bounds));
  const f = r.fills;
  assert(f.dims.join() === '40,30', 'cutout size ' + f.dims);
  samePx(f.t[0], [200, 100, 50, 255], 0, 'transparent: kept part');
  assert(f.t[1][3] === 0, 'transparent: cut part alpha ' + f.t[1]);
  samePx(f.col[0], [200, 100, 50, 255], 0, 'colour: kept part');
  samePx(f.col[1], [16, 224, 32, 255], 0, 'colour: cut part is the colour');
  samePx(f.blur[0], [200, 100, 50, 255], 0, 'blur: kept part');
  assert(f.blur[1][3] === 255 && f.blur[1][2] > 150 && f.blur[1][0] < 120, 'blur: cut part is the blurred photo, mostly its blue side ' + f.blur[1]);
  assert(f.blur[2][3] === 255 && f.blur[2][0] > 40, 'blur: next to the kept side, the backdrop carries its colour spread over: ' + f.blur[2]);
  samePx(f.veil[0], [200, 100, 50, 255], 0, 'veil: kept part');
  samePx(f.veil[1], [106, 37, 130, 255], 3, 'veil: cut part tinted (darkroom red, 0.46)');
  samePx(f.half, [228, 178, 153, 255], 2, 'half alpha over white');
  await ctx.close();
}, { core: true });

test('background core: plain border key, holes, photographed backdrops and edge unmixing (independent check)', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(() => {
    const core = retouch.core;
    // Pictures as RGBA arrays from px(x, y) -> [r, g, b].
    const pic = (w, h, px) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = px(x, y), o = (y * w + x) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; } return d; };
    const B = [0, 114, 187], W = [255, 255, 255], DARK = [22, 23, 23];
    const ring = (x, y) => { const s = Math.max(Math.abs(x - 50), Math.abs(y - 30)); return s >= 6 && s <= 12; };
    // Banner: blue, a white square ring (blue hole inside), and a 2 px dark line along the top.
    const banner = pic(100, 60, (x, y) => (y < 2 ? DARK : ring(x, y) ? W : B));
    const kb = core.borderKey(banner, 100, 60);
    const mb = core.keyMask(banner, 100, 60, kb);
    const at = (a, x, y, w = 100) => +a[y * w + x].toFixed(3);
    // Photographed backdrop: blue with grain (+/- 12 on each channel, fixed pattern).
    const grain = (x, y) => ((x * 7 + y * 13) % 25) - 12;
    const photo = pic(100, 60, (x, y) => (ring(x, y) ? W : B.map((v) => v + grain(x, y))));
    const kp = core.borderKey(photo, 100, 60);
    const mp = core.keyMask(photo, 100, 60, kp);
    // Busy border: the gradient.
    const kg = core.borderKey(pic(100, 60, (x, y) => [x * 2, y * 4, 77]), 100, 60);
    // The ramp between KEY_IN and KEY_OUT, one pixel at a time, on a photographed key
    // (a flat key's walk stops at KEY_MATCH and leaves the rest to keyCut).
    const one = (c) => core.keyMask(new Uint8ClampedArray([...c, 255]), 1, 1, { rgb: B, flat: false })[0];
    const ramp = [0, core.KEY_IN, (core.KEY_IN + core.KEY_OUT) / 2, core.KEY_OUT].map((s) => +one([B[0] + s, B[1], B[2]]).toFixed(3));
    // Edge unmixing: a white bar on blue with a column of half-and-half pixels between.
    const half = B.map((v, c) => Math.round((v + W[c]) / 2));
    const bar = pic(40, 20, (x) => (x < 15 ? B : x === 15 ? half : W));
    const kc = core.keyCut(bar, 40, 20, { rgb: B, flat: true });
    const cut = { mixA: at(kc.a, 15, 10, 40), mixRGB: Array.from(kc.rgb.slice((10 * 40 + 15) * 4, (10 * 40 + 15) * 4 + 3)), white: at(kc.a, 30, 10, 40), blue: at(kc.a, 5, 10, 40) };
    // A pixel off the blue-to-white line (mid orange beside blue and white) keeps the ramp.
    const off = pic(40, 20, (x) => (x < 15 ? B : x === 15 ? [240, 120, 30] : W));
    const ko = core.keyCut(off, 40, 20, { rgb: B, flat: true });
    // keyModel: a plain picture with nothing on it gives no key; the banner gives one.
    const canvasOf = (d, w, h) => { const c = core.makeCanvas(w, h); c.getContext('2d').putImageData(new ImageData(d, w, h), 0, 0); return c; };
    const empty = core.keyModel(canvasOf(pic(60, 40, () => B), 60, 40));
    const km = core.keyModel(canvasOf(banner, 100, 60));
    // A pale subject touching a pale flat fill (white strands on mint): the walk in
    // from the border must not run into the white.
    const MINT = [216, 233, 227];
    const pale = pic(60, 40, (x, y) => (x >= 20 && x < 40 ? W : MINT));
    const mm = core.keyMask(pale, 60, 40, core.borderKey(pale, 60, 40));
    // A photographed backdrop on about 70 % of the border is not enough (a wall, not a
    // backdrop); on about 90 % it is. Grainy blue, with a dark shelf along the top left.
    const shelf = (len) => pic(100, 60, (x, y) => (y < 8 && x < len ? DARK : ring(x, y) ? W : B.map((v) => v + grain(x, y))));
    const k70 = core.keyModel(canvasOf(shelf(90), 100, 60)), k90 = core.keyModel(canvasOf(shelf(30), 100, 60));
    // With that shelf at 80 px, the dark is a third of the border but one flat colour,
    // while the grainy blue is two thirds spread over several grid bins: the busiest
    // bin is dark, the colour with the most border pixels near it is blue.
    const k80 = core.borderKey(shelf(80), 100, 60);
    // A flat fill on only half the border (the other half a gradient) is not plain.
    const halfFlat = core.keyModel(canvasOf(pic(100, 60, (x, y) => (y < 30 ? [x * 2, y * 4, 77] : B)), 100, 60));
    // A pocket of grainy backdrop that reaches the border only along the bottom row,
    // walled off by white everywhere else.
    const pocket = pic(100, 60, (x, y) => (y >= 40 && y < 44 ? W : y >= 44 && (x < 3 || x >= 97) ? W : ring(x, y) ? W : B.map((v) => v + grain(x, y))));
    const kpk = core.borderKey(pocket, 100, 60), mpk = core.keyMask(pocket, 100, 60, kpk);
    // Heads: hair and face skin count, body skin and clothes do not.
    const conf = (k) => [0, 1, 2, 3, 4, 5].map((c) => new Float32Array(100).map((_, i) => (c === k && i < 10 ? 0.9 : c === 0 ? (i < 10 ? 0.1 : 1) : 0)));
    const heads = [1, 2, 3, 4].map((k) => core.headShare(conf(k)));
    // The marked point of an L shape (whose centre is outside it) is a marked pixel.
    const L = { w: 10, h: 10, data: new Float32Array(100).map((_, i) => (i % 10 === 0 || i >= 90 ? 1 : 0)) };
    const lp = core.markedPoint(L);
    const none = core.markedPoint({ w: 4, h: 4, data: new Float32Array(16).fill(0.4) });
    return {
      kb, kp: { rgb: kp.rgb, share: kp.share, flat: kp.flat }, kgShare: kg.share,
      banner: [at(mb, 2, 30), at(mb, 50, 30), at(mb, 44, 30), at(mb, 50, 0), at(mb, 99, 59)],
      photo: [at(mp, 2, 30), at(mp, 50, 30), at(mp, 44, 30)],
      ramp, cut, offA: at(ko.a, 15, 10, 40), empty, km: km && { kind: km.kind, found: +km.found.toFixed(3), flat: km.flat },
      pale: [at(mm, 30, 20, 60), at(mm, 5, 20, 60)], k70, k90: k90 && k90.kind, heads, lp, none,
      k80: { rgb: k80.rgb, share: +k80.share.toFixed(2) }, halfFlat,
      pocket: [at(mpk, 50, 52), at(mpk, 50, 41), at(mpk, 1, 50)],
    };
  });
  assert(r.kb.rgb.join() === '0,114,187' && r.kb.share === 1 && r.kb.flat === true, 'banner key, the dark top line skipped: ' + JSON.stringify(r.kb));
  assert(r.banner.join() === '0,0,1,1,0', 'flat key: blue gone, hole gone, ring kept, dark line kept: ' + r.banner);
  assert(r.kp.flat === false && r.kp.share === 1 && Math.abs(r.kp.rgb[1] - 114) <= 2, 'grainy backdrop is plain but not flat: ' + JSON.stringify(r.kp));
  assert(r.photo.join() === '0,1,1', 'photographed backdrop: outside gone, the same blue inside the ring kept: ' + r.photo);
  assert(r.kgShare < 0.6, 'gradient border is not plain: ' + r.kgShare);
  assert(r.ramp.join() === '0,0,0.5,1', 'ramp from KEY_IN to KEY_OUT: ' + r.ramp);
  near(r.cut.mixA, 0.5, 0.02, 'half-and-half pixel is half kept');
  samePx(r.cut.mixRGB, [255, 255, 255], 2, 'half-and-half pixel is white once the blue is taken out');
  assert(r.cut.white === 1 && r.cut.blue === 0, 'white kept, blue gone: ' + JSON.stringify(r.cut));
  assert(r.offA === 1, 'a pixel off the blend line keeps the ramp (orange is far from blue): ' + r.offA);
  assert(r.empty === null, 'a picture that is all background gives no key');
  assert(r.pale.join() === '1,0', 'white beside mint kept, mint gone: ' + r.pale);
  assert(r.pocket.join() === '0,1,1', 'backdrop reached only from the bottom row is gone, its walls kept: ' + r.pocket);
  assert(r.k80.rgb.join() === '0,114,187' && r.k80.share === 0.72, 'grainy blue beats a busier flat bin: ' + JSON.stringify(r.k80));
  assert(r.halfFlat === null, 'a flat fill on half the border is not plain');
  assert(r.k70 === null && r.k90 === 'key', 'photographed backdrop needs 80 % of the border: ' + JSON.stringify([r.k70, r.k90]));
  assert(r.heads.join() === '0.1,0,0.1,0', 'hair and face skin are a head, body skin and clothes are not: ' + r.heads);
  // L: the left column (10 px) and the bottom row (9 more). Centre (2.37, 6.63), off the L;
  // the nearest marked pixel is (0, 7), cell centre (0.5, 7.5) of 10.
  assert(r.lp && Math.abs(r.lp.x * 10 - 0.5) < 1e-9 && Math.abs(r.lp.y * 10 - 7.5) < 1e-9, 'L shape: nearest marked pixel to its centre: ' + JSON.stringify(r.lp));
  assert(r.none === null, 'nothing marked, no point');
  assert(r.km && r.km.kind === 'key' && r.km.flat && r.km.found === 0.117, 'banner model (ring 504 px + dark line 200 px of 6000): ' + JSON.stringify(r.km));
  await ctx.close();
}, { core: true });

// A photo with no one in it: the real model's answer is a faint haze of about 0.08
// "person" everywhere (and the same floor for skin). Found 26/10/26 on a banner,
// where the sheet cut the whole picture away. Since v0.7.0 the sheet then picks
// the subject itself: a plain border is keyed out by colour, anything else gets
// the object at the centre, and a tap picks a different one.
const haze = () => {
  const h = (v) => () => ({ w: 16, h: 12, data: new Float32Array(192).fill(v) });
  retouch.segmenter.override = h(0.08);
  retouch.segmenter.skinOverride = () => ({ ...h(0.034)(), face: 0.017 });
  // Stand-in for the tap-to-select model: the object is a 9 x 9 cell block round the
  // point asked for, on a 32 x 24 grid. Every call is recorded.
  window.__picks = [];
  retouch.segmenter.objectOverride = (canvas, pt) => {
    window.__picks.push([+pt.x.toFixed(3), +pt.y.toFixed(3)]);
    if (window.__emptyPick) return { w: 32, h: 24, data: new Float32Array(768) };
    const cx = Math.floor(pt.x * 32), cy = Math.floor(pt.y * 24);
    return { w: 32, h: 24, data: new Float32Array(768).map((_, i) => (Math.abs(i % 32 - cx) <= 4 && Math.abs(Math.floor(i / 32) - cy) <= 4 ? 1 : 0)) };
  };
};
const notices = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.notice')).map((n) => n.textContent));
// A still, single-finger tap at image point (x, y), then the wait for a double tap to rule it out.
async function tapAt(page, x, y) {
  await page.evaluate(([x, y]) => {
    const c = document.querySelector('#view'), r = c.getBoundingClientRect(), v = retouch.view;
    const at = { clientX: r.left + v.tx + x * v.scale, clientY: r.top + v.ty + y * v.scale };
    for (const type of ['pointerdown', 'pointerup']) c.dispatchEvent(new PointerEvent(type, { pointerId: 41, ...at, bubbles: true, pointerType: 'touch', isPrimary: true }));
  }, [x, y]);
  await page.waitForTimeout(450);
  await idle(page);
}

test('background: no person on a plain border, the background colour is taken away', async () => {
  const { ctx, page } = await newApp({ init: BG_INIT });
  await load(page, personPng());                       // sky all round, a skin block
  await page.evaluate(haze);
  await bgReady(page);
  const m = await page.evaluate(() => { const m = retouch.tools.bg.model; return { kind: m.kind, rgb: m.rgb, flat: m.flat, found: +m.found.toFixed(3) }; });
  assert(m.kind === 'key' && m.rgb.join() === '40,90,200' && m.flat === true, 'keyed on the sky: ' + JSON.stringify(m));
  near(m.found, 1 / 4, 0.01, 'kept share (the skin block)');
  assert(await page.textContent('#bg-out') === 'Plain background removed.', 'status line ' + await page.textContent('#bg-out'));
  assert(!(await notices(page)).some((t) => /Nothing found/.test(t)), 'no notice: ' + await notices(page));
  assert(await page.isVisible('.hint[data-for="bg-view"]'), 'view mode says a tap picks again');
  await applyTool(page, 'bg');
  const got = await page.evaluate(() => [[150, 120], [20, 20], [150, 199], [99, 120]].map(([x, y]) => retouch.readPixels(retouch.app.edits.current, x, y, 1, 1)));
  samePx(got[0], SKIN.concat(255), 0, 'skin kept as it was');
  assert(got[1][3] === 0, 'sky taken away: ' + got[1]);
  samePx(got[2], SKIN.concat(255), 0, 'skin at the bottom edge kept');
  assert(got[3][3] === 0, 'sky right beside the skin taken away: ' + got[3]);
  assert(await page.evaluate(() => window.__picks.length) === 0, 'the object model was not needed');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('background: no person and a busy border, the centre object is picked; a tap picks another', async () => {
  const { ctx, page } = await newApp({ init: BG_INIT });
  await load(page, gradient());                        // every border pixel a different colour
  await page.evaluate(haze);
  await bgReady(page);
  let m = await page.evaluate(() => ({ kind: retouch.tools.bg.model.kind, picks: window.__picks }));
  assert(m.kind === 'object' && JSON.stringify(m.picks) === '[[0.5,0.5]]', 'centre picked: ' + JSON.stringify(m));
  assert(await page.textContent('#bg-out') === 'Centre object picked.', 'status line ' + await page.textContent('#bg-out'));
  // A stroke, then a tap near the top left: the new object, and the stroke is dropped.
  await page.click('[data-bgmode="erase"]');
  await brush(page, [[120, 90], [125, 90]]);
  await page.click('[data-bgmode="view"]');
  await page.waitForTimeout(100);
  assert(await page.textContent('#bg-out') === 'Centre object picked, 1 stroke.', 'stroke counted');
  await tapAt(page, 40, 30);
  m = await page.evaluate(() => ({ kind: retouch.tools.bg.model.kind, picks: window.__picks, n: retouch.tools.bg.strokes.length }));
  near(m.picks[1][0], 40.5 / 241, 0.01, 'tap x');
  near(m.picks[1][1], 30.5 / 181, 0.01, 'tap y');
  assert(m.picks.length === 2 && m.n === 0, 'one new pick, strokes cleared: ' + JSON.stringify(m));
  assert(await page.textContent('#bg-out') === 'Object picked.', 'status line ' + await page.textContent('#bg-out'));
  const a = await page.evaluate(() => [[40, 30], [200, 150]].map(([x, y]) => window.__px(retouch.tools.bg.pv.mask, Math.round(x * retouch.tools.bg.pv.k), Math.round(y * retouch.tools.bg.pv.k))[3]));
  assert(a[0] > 250 && a[1] < 5, 'mask follows the new object: ' + a);
  // A double tap zooms and picks nothing; a tap in a brush mode paints, not picks.
  await page.evaluate(() => {
    const c = document.querySelector('#view'), r = c.getBoundingClientRect(), v = retouch.view;
    const at = { clientX: r.left + v.tx + 100 * v.scale, clientY: r.top + v.ty + 100 * v.scale };
    for (const type of ['pointerdown', 'pointerup', 'pointerdown', 'pointerup']) c.dispatchEvent(new PointerEvent(type, { pointerId: 42, ...at, bubbles: true, pointerType: 'touch', isPrimary: true }));
  });
  await page.waitForTimeout(450);
  assert(await page.evaluate(() => window.__picks.length) === 2, 'double tap picks nothing');
  await page.click('[data-bgmode="keep"]');
  await tapAt(page, 100, 100);
  assert(await page.evaluate(() => window.__picks.length) === 2, 'a tap while brushing paints instead');
  // A pick that finds nothing says so, and points at tapping.
  await page.click('[data-bgmode="view"]');
  await page.evaluate(() => { window.__emptyPick = true; });
  await tapAt(page, 120, 90);
  assert(await page.textContent('#bg-out') === 'Nothing picked.', 'status line ' + await page.textContent('#bg-out'));
  assert((await notices(page)).some((t) => /Nothing found to keep here\. Tap the subject to pick it\./.test(t)), 'notice: ' + await notices(page));
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('background: something marked without a head (a bag, a cat) goes to the object model at that spot', async () => {
  const { ctx, page } = await newApp({ init: BG_INIT });
  await load(page, gradient());
  await page.evaluate(haze);
  // The person model marks a block in the top right quarter, with no head in the picture.
  await page.evaluate(() => {
    retouch.segmenter.override = () => ({ w: 16, h: 12, head: 0, data: new Float32Array(192).map((_, i) => (i % 16 >= 10 && i % 16 < 14 && Math.floor(i / 16) >= 2 && Math.floor(i / 16) < 5 ? 1 : 0)) });
  });
  await bgReady(page);
  const m = await page.evaluate(() => ({ kind: retouch.tools.bg.model.kind, centre: retouch.tools.bg.model.centre, picks: window.__picks }));
  assert(m.kind === 'object' && m.centre === false && m.picks.length === 1, 'object at the marked spot: ' + JSON.stringify(m));
  near(m.picks[0][0], 11.5 / 16, 0.07, 'marked x');
  near(m.picks[0][1], 3.5 / 12, 0.09, 'marked y');
  assert(await page.textContent('#bg-out') === 'Object picked.', 'status line ' + await page.textContent('#bg-out'));
  // With a head, the same mark is a person.
  await page.click('.sheet-panel[data-tool="bg"] [data-cancel]');
  await page.evaluate(() => { const o = retouch.segmenter.override; retouch.segmenter.override = (c) => ({ ...o(c), head: 0.01 }); });
  await bgReady(page);
  assert(await page.evaluate(() => retouch.tools.bg.model.kind) === 'person', 'with a head it is a person');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('skin: haze is not skin, and the sheet says no skin was found', async () => {
  const { ctx, page } = await newApp({ init: BG_INIT });
  await load(page, personPng());
  await page.evaluate(haze);
  await skinReady(page);
  assert(await page.textContent('#skin-out') === 'No skin found.', 'skin status ' + await page.textContent('#skin-out'));
  assert((await notices(page)).some((t) => /No skin found in this photo/.test(t)), 'no-skin notice: ' + await notices(page));
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('background: the sheet cuts the person out onto transparent, colour and blur', async () => {
  const { ctx, page } = await newApp({ init: [TEXT_INIT, BG_INIT] });
  await load(page, personPng());
  await textBox(page, { text: 'HI', size: 30 });
  const before = await texts(page);
  await page.evaluate(() => window.__fakeSeg([210, 160, 130]));
  await bgReady(page);
  assert(/Person found in \d+ % of the photo/.test(await page.textContent('#bg-out')), 'status line ' + await page.textContent('#bg-out'));
  assert(await page.isVisible('#bg-view-rows') && await page.isHidden('#bg-brush-rows'), 'view mode shows feather and fill');
  // The live preview is the result: compare it with what Apply makes.
  const preview = await page.evaluate(() => [[150, 120], [20, 20], [150, 199], [96, 120], [104, 120]].map(([x, y]) => window.__px(retouch.app.preview.src, x, y)));
  await applyTool(page, 'bg');
  const got = await page.evaluate(() => [[150, 120], [20, 20], [150, 199], [96, 120], [104, 120], [199, 199], [100, 50]].map(([x, y]) => retouch.readPixels(retouch.app.edits.current, x, y, 1, 1)));
  samePx(got[0], SKIN.concat(255), 1, 'person kept as it was');
  assert(got[1][3] === 0, 'sky cut away: ' + got[1]);
  samePx(got[2], SKIN.concat(255), 1, 'person at the bottom edge of the frame is not faded');
  assert(got[3][3] <= 40 && got[4][3] >= 215, 'edge sits on the photo edge at x = 100: ' + got[3] + ' / ' + got[4]);
  assert(got[5][3] >= 200 && got[6][3] >= 100, 'corner pixels of the person kept: ' + got[5] + ' / ' + got[6]);
  for (let i = 0; i < preview.length; i++) assert(Math.abs(preview[i][3] - got[i][3]) <= 2, 'preview alpha differs from the result at point ' + i + ': ' + preview[i] + ' vs ' + got[i]);
  assert(JSON.stringify(await texts(page)) === JSON.stringify(before), 'text boxes carried through unchanged');
  const step = await page.evaluate(() => [retouch.app.edits.stack.length, retouch.app.edits.stack[retouch.app.edits.index].label]);
  assert(step.join() === '3,Remove background', 'history ' + step);
  // Transparent areas mean the export is PNG.
  await page.click('#btn-export');
  assert(await page.isVisible('#export-alpha-note'), 'alpha note on export');
  assert((await page.getAttribute('[data-format="png"]', 'aria-pressed')) === 'true', 'PNG forced');
  await page.click('.sheet-panel[data-tool="export"] [data-cancel]');
  // Undo, then colour and blur backdrops.
  await page.click('#btn-undo');
  samePx(await px(page, 20, 20), SKY.concat(255), 0, 'undo brings the sky back');
  await bgReady(page);
  await page.click('[data-bgfill="colour"]');
  assert(await page.isVisible('#bg-colour-row'), 'colour swatches shown');
  await page.click('[data-bgcolour="#000000"]');
  await applyTool(page, 'bg');
  samePx(await px(page, 20, 20), [0, 0, 0, 255], 0, 'black backdrop');
  samePx(await px(page, 150, 120), SKIN.concat(255), 1, 'person on black');
  await page.click('#btn-undo');
  await bgReady(page);
  assert((await page.getAttribute('[data-bgfill="colour"]', 'aria-pressed')) === 'true', 'the backdrop choice is remembered');
  await page.click('[data-bgfill="blur"]');
  assert(await page.isVisible('#bg-blur-row') && await page.isHidden('#bg-colour-row'), 'blur slider shown');
  await applyTool(page, 'bg');
  const sky = await px(page, 20, 20), nearPerson = await px(page, 90, 150);
  assert(sky[3] === 255 && nearPerson[3] === 255, 'blur backdrop is opaque');
  assert(nearPerson[0] > SKY[0] + 15, 'the blurred photo shows the person spread into the sky beside them: ' + nearPerson);
  samePx(await px(page, 150, 120), SKIN.concat(255), 1, 'person sharp on the blur');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('background: refine brush keeps and erases with one finger; two fingers zoom instead', async () => {
  const { ctx, page } = await newApp({ init: BG_INIT });
  await load(page, personPng());
  await page.evaluate(() => window.__fakeSeg([210, 160, 130]));
  await bgReady(page);
  await page.click('[data-bgmode="erase"]');
  assert(await page.isVisible('#bg-brush-rows') && await page.isHidden('#bg-view-rows'), 'brush mode shows the brush rows');
  // The brush view tints what will be cut away, over the photo.
  samePx(await page.evaluate(() => window.__px(retouch.app.preview.src, 20, 20)), [116, 64, 119, 255], 4, 'sky under the red veil');
  samePx(await page.evaluate(() => window.__px(retouch.app.preview.src, 150, 120)), SKIN.concat(255), 1, 'person clear in the brush view');
  await page.fill('#bg-brush', '30');
  await page.dispatchEvent('#bg-brush', 'input');
  await brush(page, [[120, 120], [180, 120]]);
  let st = await page.evaluate(() => retouch.tools.bg.strokes.map((s) => [s.mode, s.pts.length, +(s.r * retouch.view.scale).toFixed(2)]));
  assert(st.length === 1 && st[0][0] === 'erase' && st[0][1] > 4 && st[0][2] === 15, 'erase stroke ' + JSON.stringify(st));
  assert(await page.isEnabled('#bg-undo-stroke'), 'undo stroke enabled');
  samePx(await page.evaluate(() => window.__px(retouch.app.preview.src, 150, 120)), [208, 102, 81, 255], 4, 'erased skin shows under the veil in the preview');
  await page.click('[data-bgmode="keep"]');
  await brush(page, [[20, 20], [60, 20]]);
  assert((await page.evaluate(() => retouch.tools.bg.strokes.length)) === 2, 'keep stroke added');
  // A second finger cancels the stroke the first one started, and zooms.
  const s0 = await page.evaluate(() => retouch.view.scale);
  await page.evaluate(() => {
    const c = document.querySelector('#view'), r = c.getBoundingClientRect();
    const ev = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerType: 'touch', isPrimary: id === 41 }));
    ev('pointerdown', 41, 180, 200); ev('pointermove', 41, 175, 200);
    ev('pointerdown', 42, 220, 200);
    for (let i = 1; i <= 10; i++) { ev('pointermove', 41, 175 - i * 6, 200); ev('pointermove', 42, 220 + i * 6, 200); }
    ev('pointerup', 41, 115, 200); ev('pointerup', 42, 280, 200);
  });
  assert((await page.evaluate(() => retouch.tools.bg.strokes.length)) === 2, 'the pinch must not leave a stroke');
  assert((await page.evaluate(() => retouch.view.scale)) > s0 * 1.5, 'two fingers zoomed in');
  samePx(await page.evaluate(() => window.__px(retouch.app.preview.src, 150, 200 - 1)), SKIN.concat(255), 1, 'cancelled stroke left no mark');
  await page.click('#bg-undo-stroke');
  assert((await page.evaluate(() => retouch.tools.bg.strokes.map((s) => s.mode).join())) === 'erase', 'undo stroke drops the last one');
  // Zoomed in now: the brush is the same size on screen, smaller on the photo.
  await brush(page, [[20, 20], [60, 20]]);
  st = await page.evaluate(() => retouch.tools.bg.strokes.map((s) => [s.mode, +(s.r * retouch.view.scale).toFixed(2)]));
  assert(st.length === 2 && st[1][0] === 'keep' && st[1][1] === 15, 'keep stroke after zoom ' + JSON.stringify(st));
  await page.click('[data-bgmode="view"]');
  await applyTool(page, 'bg');
  const got = await page.evaluate(() => [[150, 120], [150, 170], [40, 20], [40, 80]].map(([x, y]) => retouch.readPixels(retouch.app.edits.current, x, y, 1, 1)));
  assert(got[0][3] === 0, 'erased across the person: ' + got[0]);
  samePx(got[1], SKIN.concat(255), 1, 'rest of the person kept');
  samePx(got[2], SKY.concat(255), 1, 'sky painted back with keep');
  assert(got[3][3] === 0, 'unpainted sky still cut: ' + got[3]);
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

// A flat graphic like a logo: blue field, an orange block, white bars. The real model
// must find no one in it, and the sheet must say so.
const logoPng = () => makePng(480, 120, (x, y) => {
  if (x >= 30 && x < 110 && y >= 20 && y < 100 && x - 30 > (y - 20) / 3) return [240, 120, 30, 255];
  if (x >= 140 && x < 450 && ((y >= 30 && y < 55) || (y >= 70 && y < 85))) return [255, 255, 255, 255];
  return [0, 114, 188, 255];
});
test('background: the real model finds no one in a flat graphic, so its background colour is keyed out', async () => {
  const { ctx, page } = await newApp();
  await load(page, logoPng());
  await bgReady(page);
  const m = await page.evaluate(() => { const m = retouch.tools.bg.model; return { kind: m.kind, rgb: m.rgb, flat: m.flat }; });
  assert(m.kind === 'key' && m.rgb.join() === '0,114,188' && m.flat, 'a logo is keyed on its background: ' + JSON.stringify(m));
  assert(await page.textContent('#bg-out') === 'Plain background removed.', 'status line ' + await page.textContent('#bg-out'));
  await applyTool(page, 'bg');
  const px = await page.evaluate(() => [[5, 5], [200, 40], [60, 80], [470, 60]].map(([x, y]) => retouch.readPixels(retouch.app.edits.current, x, y, 1, 1)));
  assert(px[0][3] === 0 && px[3][3] === 0, 'background gone: ' + px[0] + ' / ' + px[3]);
  samePx(px[1], [255, 255, 255, 255], 0, 'white bar kept');
  samePx(px[2], [240, 120, 30, 255], 0, 'orange block kept');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

// A red disc on a patchwork of muted squares: no person, no plain border, so the real
// tap-to-select model picks the disc when tapped.
const discPng = () => makePng(400, 300, (x, y) => {
  if (Math.hypot(x - 200, y - 150) <= 70) return [224, 48, 48, 255];
  const i = Math.floor(x / 20), j = Math.floor(y / 20), v = 90 + ((i * 37 + j * 53) % 5) * 25;
  return [v, 150 - ((i + j) % 3) * 30, 255 - v, 255];
});
test('background: the real tap-to-select model picks the object tapped', async () => {
  const { ctx, page } = await newApp({ init: BG_INIT });
  await load(page, discPng());
  await bgReady(page);
  // Whatever was picked first (the person model can mistake a red disc for a
  // person), a tap on the disc picks it with the real tap-to-select model.
  await tapAt(page, 200, 150);
  const m = await page.evaluate(() => { const m = retouch.tools.bg.model; return { kind: m.kind, centre: m.centre, found: m.found, o: retouch.segmenter.objectOverride }; });
  assert(m.kind === 'object' && m.centre === false && m.o === null, 'disc picked by the real model: ' + JSON.stringify(m));
  near(m.found, Math.PI * 70 * 70 / 120000, 0.03, 'picked share is the disc');
  const a = await page.evaluate(() => { const pv = retouch.tools.bg.pv; return [[200, 150], [20, 20], [380, 280]].map(([x, y]) => window.__px(pv.mask, Math.round(x * pv.k), Math.round(y * pv.k))[3]); });
  assert(a[0] > 250 && a[1] < 5 && a[2] < 5, 'disc kept, squares cut: ' + a);
  console.log('      disc: found ' + (m.found * 100).toFixed(1) + ' % (disc is ' + (Math.PI * 4900 / 1200).toFixed(1) + ' %)');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('background: the real model runs from vendor/, offline, and nothing else is asked for', async () => {
  const { ctx, page } = await newApp({ sw: true });
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 });
  const cached = await page.evaluate(async () => {
    const names = await caches.keys(), mp = names.find((n) => n.startsWith('retouch-mediapipe-'));
    return { names, files: mp ? (await (await caches.open(mp)).keys()).map((r) => new URL(r.url).pathname.split('/').pop()).sort() : [] };
  });
  assert(cached.files.join() === 'magic_touch.tflite,selfie_multiclass_256x256.tflite,vision_bundle.js,vision_wasm_internal.js,vision_wasm_internal.wasm', 'MediaPipe cache: ' + JSON.stringify(cached));
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.retouch && window.retouch.app);
  await load(page, personPng());
  const labels = [];
  await page.exposeFunction('__busyLabel', (t) => labels.push(t));
  await page.evaluate(() => new MutationObserver(() => window.__busyLabel(document.querySelector('#busy').textContent)).observe(document.querySelector('#busy'), { childList: true, characterData: true, subtree: true }));
  await bgReady(page);
  // The person model always runs first. This picture has no person and a plain sky
  // border, so the sky is then keyed out by colour.
  const m = await page.evaluate(async () => ({ kind: retouch.tools.bg.model.kind, person: !!(retouch.segmenter.promise && await retouch.segmenter.promise), override: retouch.segmenter.override }));
  assert(m.person && m.override === null && m.kind === 'key', 'real person model ran, then the key: ' + JSON.stringify(m));
  // A tap loads the tap-to-select model, offline too.
  await tapAt(page, 150, 120);
  const t = await page.evaluate(() => ({ kind: retouch.tools.bg.model.kind, w: retouch.tools.bg.model.w, n: retouch.tools.bg.model.ar.length }));
  assert(t.kind === 'object' && t.w === 300 && t.n === 60000, 'object model offline, on the guide grid: ' + JSON.stringify(t));
  assert(labels.includes('Loading model'), 'first use says it is loading the model: ' + labels);
  await applyTool(page, 'bg');
  const d = await dims(page);
  assert(d.join() === '300,200', 'result size ' + d);
  // A second opening reuses the loaded model.
  await page.click('#btn-undo');
  await bgReady(page);
  assert(labels[labels.length - 1] !== 'Loading model', 'second use does not load again: ' + labels);
  await page.click('.sheet-panel[data-tool="bg"] [data-cancel]');
  await ctx.setOffline(false);
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('background: a failed model load says so plainly and leaves the photo alone', async () => {
  const { ctx, page } = await newApp({ init: BG_INIT });
  await load(page, personPng());
  await page.evaluate(() => { window.retouch.segmenter.override = () => { throw new Error('model file missing'); }; });
  await page.click('[data-open-tool="bg"]');
  await page.waitForSelector('.notice.fail[data-id="bg"]');
  const t = await page.textContent('.notice.fail[data-id="bg"]');
  assert(/Background removal could not start: model file missing/.test(t), 'message ' + t);
  await idle(page);
  assert(await page.evaluate(() => retouch.app.tool === null && retouch.app.edits.stack.length === 1), 'tool closed, no step added');
  await ctx.close();
});

/* ---------- Phase 4: smooth skin ---------- */

// A synthetic skin patch, built in the page: skin tone with fine grain, four soft
// reddish spots, and a hard dark "eyebrow" bar. Returns a canvas and a measure() that
// reads spot depth, eyebrow contrast, the eyebrow's edge step and the grain.
const SKIN_PATCH = () => {
  window.__skinPatch = (W = 400, H = 400) => {
    const c = retouch.core.makeCanvas(W, H), x = c.getContext('2d', { willReadFrequently: true });
    const img = x.createImageData(W, H), d = img.data;
    let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const spots = [[80, 80], [200, 120], [300, 260], [120, 300]];
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const g = (rnd() - 0.5) * 14;
      let r = 200 + g, gg = 150 + g, bb = 130 + g;
      for (const [sx, sy] of spots) { const dd = Math.hypot(X - sx, y - sy), k = Math.exp(-(dd * dd) / 24.5); r -= 8 * k; gg -= 35 * k; bb -= 30 * k; }
      if (y >= 200 && y < 210 && X >= 60 && X < 340) { r = 70 + g; gg = 50 + g; bb = 40 + g; }
      const o = (y * W + X) * 4; d[o] = r; d[o + 1] = gg; d[o + 2] = bb; d[o + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    const G = (dd, i) => dd[4 * i + 1];
    const measure = (dd) => {
      let depth = 0;
      for (const [sx, sy] of spots) {
        let ring = 0, rn = 0, cen = 0, cn = 0;
        for (let y = sy - 15; y <= sy + 15; y++) for (let X = sx - 15; X <= sx + 15; X++) {
          const dist = Math.hypot(X - sx, y - sy), i = y * W + X;
          if (dist >= 10 && dist <= 14) { ring += G(dd, i); rn++; }
          if (dist <= 1.5) { cen += G(dd, i); cn++; }
        }
        depth += (ring / rn - cen / cn) / spots.length;
      }
      let inb = 0, nb = 0, outb = 0, no = 0, e1 = 0, e2 = 0;
      for (let X = 100; X < 300; X++) {
        for (let y = 202; y < 208; y++) { inb += G(dd, y * W + X); nb++; }
        for (let y = 214; y < 219; y++) { outb += G(dd, y * W + X); no++; }
        e1 += G(dd, 209 * W + X); e2 += G(dd, 210 * W + X);
      }
      let s2 = 0, n2 = 0;
      for (let y = 21; y < 99; y++) for (let X = 301; X < 379; X++) {
        let m = 0; for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) m += G(dd, (y + v) * W + X + u);
        const e = G(dd, y * W + X) - m / 9; s2 += e * e; n2++;
      }
      return { depth, brow: outb / no - inb / nb, step: (e2 - e1) / 200, grain: Math.sqrt(s2 / n2) };
    };
    return { c, measure };
  };
};

test('skin core: edge-preserving filter, grain, mix and tiles (independent check)', async () => {
  const { ctx, page } = await newApp({ init: SKIN_PATCH });
  const r = await page.evaluate(() => {
    const core = retouch.core, out = {};
    // The self-guided filter against a direct reading on a small random channel.
    const w = 17, h = 11, rad = 2, eps = 0.01, n = w * h;
    let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const I = new Float32Array(n).map(rnd);
    const win = (cx, cy, f) => { let s = 0, k = 0; for (let y = Math.max(0, cy - rad); y <= Math.min(h - 1, cy + rad); y++) for (let x = Math.max(0, cx - rad); x <= Math.min(w - 1, cx + rad); x++) { s += f(y * w + x); k++; } return s / k; };
    const A = [], B = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const m = win(x, y, (i) => I[i]), v = win(x, y, (i) => I[i] * I[i]) - m * m;
      A.push(v / (v + eps)); B.push(m - (v / (v + eps)) * m);
    }
    const got = core.selfGuided(I, w, h, rad, eps);
    out.sgErr = Math.max(...Array.from(got).map((g, i) => Math.abs(g - (win(i % w, Math.floor(i / w), (j) => A[j]) * I[i] + win(i % w, Math.floor(i / w), (j) => B[j])))));
    out.sgFlat = Array.from(core.selfGuided(new Float32Array(n).fill(0.4), w, h, rad, eps)).every((v) => Math.abs(v - 0.4) < 1e-6);
    // Grain D: zero for a smooth ramp (nothing taken away), and for an exact edge kept by a tiny eps.
    const ramp = new Uint8ClampedArray(4 * n).map((_, i) => (i % 4 === 3 ? 255 : 100 + (Math.floor(i / 4) % w) * 3));
    const fr = core.skinFilter(ramp, w, h, { r: 2, g: 1, eps: 0.004 });
    out.rampD = Math.max(...fr.D.map((p) => Math.max(...Array.from(p).map(Math.abs))));
    // Away from the frame (where the window is cut off), a straight ramp comes back unchanged.
    out.rampS = Math.max(...Array.from(fr.S[0]).map((v, i) => (i % w >= 4 && i % w < w - 4 ? Math.abs(v - ramp[4 * i] / 255) : 0)));
    // At a hard edge the filter keeps (a tiny eps), the grain put back must be near zero,
    // or the edge would be sharpened a second time.
    const step = new Uint8ClampedArray(4 * n).map((_, i) => (i % 4 === 3 ? 255 : (Math.floor(i / 4) % w) < 8 ? 50 : 200));
    const fs = core.skinFilter(step, w, h, { r: 2, g: 1, eps: 0.0004 });
    out.stepD = Math.max(...fs.D.map((p) => Math.max(...Array.from(p).map(Math.abs))));
    // Mix: original + strength x alpha x (S + texture x D - original), per channel.
    const d = new Uint8ClampedArray([100, 150, 200, 255, 100, 150, 200, 255]);
    const f = { S: [new Float32Array([0.5, 0.5]), new Float32Array([0.5, 0.5]), new Float32Array([0.5, 0.5])], D: [new Float32Array([0.2, 0.2]), new Float32Array([0, 0]), new Float32Array([-0.2, -0.2])] };
    core.skinMix(d, 2, 1, f, { strength: 0.5, texture: 0.5 }, new Float32Array([1, 0.5]), 2, 0, 0);
    out.mix = Array.from(d);
    // Sizes and bounds.
    out.face = [core.skinFaceSize(0.25, 0.4, 400, 400), core.skinFaceSize(0.001, 0.36, 400, 400), core.skinFaceSize(0, 0, 400, 300)].map((v) => +v.toFixed(2));
    out.radii = [core.skinRadii(1000), core.skinRadii(1000, 0.5), core.skinRadii(10)];
    out.prob = Array.from(core.skinProb(new Float32Array([0.2, 0.7, 0]), new Float32Array([0.3, 0.6, 0]))).map((v) => +v.toFixed(3));
    const am = new Float32Array(20 * 10); am[3 * 20 + 5] = 0.2; am[6 * 20 + 12] = 1;
    out.bounds = [core.alphaBounds(am, 20, 10), core.alphaBounds(am, 20, 10, 4), core.alphaBounds(new Float32Array(200), 20, 10)];
    // Full size in tiles equals one pass over the whole box; pixels outside the mask, and
    // everything at strength 0, are left exactly as they were.
    const { c } = window.__skinPatch(300, 220);
    // Mask: kept up to x = 240, at full or 30 % strength in bands, so each tile reads its own part of it.
    const a = new Float32Array(300 * 220).map((_, i) => ((i % 300) < 240 ? (Math.floor(i / 300) % 40 < 30 ? 1 : 0.3) : 0));
    const o = { strength: 1, texture: 0.35, r: 6, g: 2, eps: core.SKIN_EPS };
    const read = (cv) => cv.getContext('2d').getImageData(0, 0, 300, 220).data;
    core.SKIN_TILE = 4096; const whole = read(core.renderSmooth(c, a, 300, 220, o));
    core.SKIN_TILE = 37; const tiled = read(core.renderSmooth(c, a, 300, 220, o));
    core.SKIN_TILE = 512;
    const orig = read(c);
    out.tileDiff = whole.reduce((m, v, i) => Math.max(m, Math.abs(v - tiled[i])), 0);
    // The same on strong random noise, where a tile that read too little around itself shows a seam.
    const noisy = core.makeCanvas(300, 220), nx = noisy.getContext('2d', { willReadFrequently: true }), ni = nx.createImageData(300, 220);
    for (let i = 0; i < ni.data.length; i++) ni.data[i] = i % 4 === 3 ? 255 : 60 + rnd() * 140;
    nx.putImageData(ni, 0, 0);
    const no = { ...o, eps: 0.05 };
    core.SKIN_TILE = 4096; const nWhole = read(core.renderSmooth(noisy, a, 300, 220, no));
    core.SKIN_TILE = 37; const nTiled = read(core.renderSmooth(noisy, a, 300, 220, no));
    core.SKIN_TILE = 512;
    out.noiseTileDiff = nWhole.reduce((m, v, i) => Math.max(m, Math.abs(v - nTiled[i])), 0);
    let outside = 0, inside = 0;
    for (let y = 0; y < 220; y++) for (let x = 0; x < 300; x++) for (let k = 0; k < 4; k++) { const i = (y * 300 + x) * 4 + k; if (x >= 240) outside = Math.max(outside, Math.abs(tiled[i] - orig[i])); else inside = Math.max(inside, Math.abs(tiled[i] - orig[i])); }
    out.outside = outside; out.inside = inside;
    out.off = read(core.renderSmooth(c, a, 300, 220, { ...o, strength: 0 })).every((v, i) => v === orig[i]);
    out.empty = read(core.renderSmooth(c, new Float32Array(300 * 220), 300, 220, o)).every((v, i) => v === orig[i]);
    // Smoothing moves pixels towards their neighbours, not to another colour: the mean of
    // each channel over a flat patch of skin stays put.
    const mean = (dd, k) => { let t = 0, m = 0; for (let y = 20; y < 80; y++) for (let x = 150; x < 230; x++) { t += dd[(y * 300 + x) * 4 + k]; m++; } return t / m; };
    out.means = [0, 1, 2].map((k) => +(mean(tiled, k) - mean(orig, k)).toFixed(2));
    return out;
  });
  assert(r.sgErr < 1e-4, 'self-guided filter differs from the direct reading by ' + r.sgErr);
  assert(r.sgFlat, 'a flat channel must stay flat');
  assert(r.rampD < 0.01 && r.rampS < 0.01, 'a smooth ramp is left alone (no grain, no change): ' + r.rampD + ' / ' + r.rampS);
  // Pixel 1, alpha 1: 100/255 + 0.5 (0.5 + 0.1 - 0.392) = 0.496 -> 126.6; green 0.588 + 0.5 (0.5 - 0.588) = 0.544 -> 138.8;
  // blue 0.784 + 0.5 (0.4 - 0.784) = 0.592 -> 151. Pixel 2, alpha 0.5: a quarter of the way (blue 175.5, stored as 175).
  assert(r.mix.join() === '127,139,151,255,113,144,175,255', 'mix ' + r.mix);
  assert(r.face.join() === '200,240,30', 'face size ' + r.face);
  assert(JSON.stringify(r.radii) === '[{"r":24,"g":5},{"r":12,"g":3},{"r":1,"g":1}]', 'radii ' + JSON.stringify(r.radii));
  assert(r.prob.join() === '0.5,1,0', 'skin = body + face skin, clamped: ' + r.prob);
  assert(JSON.stringify(r.bounds) === '[{"x0":5,"y0":3,"x1":13,"y1":7},{"x0":1,"y0":0,"x1":17,"y1":10},null]', 'alpha bounds ' + JSON.stringify(r.bounds));
  assert(r.tileDiff <= 1 && r.noiseTileDiff <= 1, 'tiles must join without a seam: differs by ' + r.tileDiff + ' (patch), ' + r.noiseTileDiff + ' (noise)');
  assert(r.outside === 0 && r.inside > 5, 'only masked pixels change: outside ' + r.outside + ', inside ' + r.inside);
  assert(r.off && r.empty, 'strength 0 or an empty mask must change nothing');
  assert(r.stepD < 0.02, 'grain put back at a kept edge: ' + r.stepD);
  assert(r.means.every((v) => Math.abs(v) < 1.5), 'channel means moved: ' + r.means);
  await ctx.close();
}, { core: true });

test('skin core: spots fade, the eyebrow edge stays, texture brings the grain back', async () => {
  const { ctx, page } = await newApp({ init: SKIN_PATCH });
  const r = await page.evaluate(() => {
    const core = retouch.core, { c, measure } = window.__skinPatch();
    const a = new Float32Array(400 * 400).fill(1), rr = core.skinRadii(400);
    const run = (strength, texture) => measure(core.renderSmooth(c, a, 400, 400, { strength, texture, ...rr, eps: core.SKIN_EPS }).getContext('2d').getImageData(0, 0, 400, 400).data);
    return { rr, orig: measure(c.getContext('2d').getImageData(0, 0, 400, 400).data), full: run(1, 0.35), half: run(0.5, 0.35), plain: run(1, 0), grainy: run(1, 1) };
  });
  const o = r.orig, f = r.full;
  assert(o.depth > 30 && o.brow > 95 && o.grain > 3.5, 'fixture ' + JSON.stringify(o));
  assert(f.depth <= 0.4 * o.depth, 'spots fade by at least 60 %: ' + o.depth.toFixed(1) + ' to ' + f.depth.toFixed(1));
  assert(f.brow >= 0.88 * o.brow && f.step >= 0.85 * o.step, 'eyebrow kept: contrast ' + f.brow.toFixed(1) + ' of ' + o.brow.toFixed(1) + ', edge ' + f.step.toFixed(1) + ' of ' + o.step.toFixed(1));
  assert(r.half.depth > f.depth + 5 && r.half.depth < o.depth - 5, 'half strength lands between: ' + r.half.depth.toFixed(1));
  assert(r.plain.grain <= 0.15 * o.grain, 'texture 0 is smooth: grain ' + r.plain.grain.toFixed(2) + ' of ' + o.grain.toFixed(2));
  assert(r.grainy.grain >= 0.9 * o.grain && r.grainy.depth <= 0.5 * o.depth, 'texture 100 keeps the grain but not the spots: ' + JSON.stringify(r.grainy));
  assert(f.grain > r.plain.grain * 2 && f.grain < r.grainy.grain, 'texture 35 is in between: ' + f.grain.toFixed(2));
  await ctx.close();
}, { core: true });

// 300 x 200: grainy blue sky, and a grainy skin block (x 100 to 199, y 50 to 199) with one spot at
// (150, 110), about 5 px across: 4 % of the block's size, like a blemish on a face.
const skinPng = () => {
  let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return makePng(300, 200, (x, y) => {
    const g = (rnd() - 0.5) * 14;
    if (x >= 100 && x < 200 && y >= 50) {
      const k = Math.exp(-((x - 150) ** 2 + (y - 110) ** 2) / 8);
      return [200 + g - 8 * k, 150 + g - 35 * k, 130 + g - 30 * k, 255].map((v) => Math.round(Math.min(255, Math.max(0, v))));
    }
    return [40 + g, 90 + g, 200 + g, 255].map((v) => Math.round(Math.min(255, Math.max(0, v))));
  });
};
async function skinReady(page) {
  await page.click('[data-open-tool="skin"]');
  await page.waitForFunction(() => window.retouch.tools.skin.pv && window.retouch.app.busyCount === 0, null, { timeout: 30000 });
}
// Spot depth in the green channel at (150, 110), and grain in a patch of sky and of skin.
const skinStats = (page, which = 'current') => page.evaluate((which) => {
  const src = which === 'preview' ? retouch.app.preview.src : retouch.app.edits.current;
  const d = retouch.readPixels(src), W = 300, G = (x, y) => d[(y * W + x) * 4 + 1];
  let ring = 0, rn = 0, cen = 0, cn = 0;
  for (let y = 95; y <= 125; y++) for (let x = 135; x <= 165; x++) { const r = Math.hypot(x - 150, y - 110); if (r >= 10 && r <= 14) { ring += G(x, y); rn++; } if (r <= 1.5) { cen += G(x, y); cn++; } }
  const grain = (x0, y0) => { let s = 0, n = 0; for (let y = y0; y < y0 + 30; y++) for (let x = x0; x < x0 + 30; x++) { let m = 0; for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) m += G(x + u, y + v); s += (G(x, y) - m / 9) ** 2; n++; } return Math.sqrt(s / n); };
  return { depth: ring / rn - cen / cn, sky: grain(20, 20), skin: grain(120, 150), bytes: d };
}, which);

test('skin: the sheet smooths only the skin; strength and texture work; undo restores', async () => {
  const { ctx, page } = await newApp({ init: [TEXT_INIT, BG_INIT] });
  await load(page, skinPng());
  await textBox(page, { text: 'HI', size: 30 });
  const before = await texts(page);
  const orig = await skinStats(page);
  await page.evaluate(() => window.__fakeSkin([200, 150, 130], 80));
  await skinReady(page);
  assert(/Skin found in \d+ % of the photo/.test(await page.textContent('#skin-out')), 'status ' + await page.textContent('#skin-out'));
  assert(await page.isVisible('#skin-view-rows') && await page.isHidden('#skin-brush-rows'), 'view rows shown');
  await page.fill('#skin-strength', '100'); await page.dispatchEvent('#skin-strength', 'input');
  const pv = await skinStats(page, 'preview');
  await applyTool(page, 'skin');
  const got = await skinStats(page);
  // How much a spot fades is pinned down by the core patch test; here the "face" is small
  // (r = 3 px), so only check that the spot clearly fades.
  assert(got.depth <= 0.65 * orig.depth, 'spot faded: ' + orig.depth.toFixed(1) + ' to ' + got.depth.toFixed(1));
  assert(Math.abs(pv.depth - got.depth) <= 3, 'preview matches the result: ' + pv.depth.toFixed(1) + ' vs ' + got.depth.toFixed(1));
  assert(got.skin < orig.skin && got.skin > 0.2 * orig.skin, 'skin grain reduced, not wiped (texture 35 %): ' + orig.skin.toFixed(2) + ' to ' + got.skin.toFixed(2));
  let sky = 0;
  for (let y = 0; y < 200; y++) for (let x = 0; x < 300; x++) if (x < 90 || x >= 210 || y < 40) for (let k = 0; k < 4; k++) sky = Math.max(sky, Math.abs(got.bytes[(y * 300 + x) * 4 + k] - orig.bytes[(y * 300 + x) * 4 + k]));
  assert(sky === 0, 'sky away from the skin must not change: ' + sky);
  assert(JSON.stringify(await texts(page)) === JSON.stringify(before), 'text boxes carried through');
  assert((await page.evaluate(() => retouch.app.edits.stack[retouch.app.edits.index].label)) === 'Smooth skin', 'history label');
  await page.click('#btn-undo');
  assert((await skinStats(page)).depth === orig.depth, 'undo restores the photo');
  // Lower strength and full texture: less smoothing, grain kept.
  await skinReady(page);
  assert((await page.inputValue('#skin-strength')) === '100', 'strength remembered');
  await page.fill('#skin-strength', '50'); await page.dispatchEvent('#skin-strength', 'input');
  await page.fill('#skin-texture', '100'); await page.dispatchEvent('#skin-texture', 'input');
  await applyTool(page, 'skin');
  const soft = await skinStats(page);
  assert(soft.depth > got.depth + 3 && soft.depth < orig.depth - 3, 'half strength: ' + soft.depth.toFixed(1));
  assert(soft.skin >= 0.85 * orig.skin, 'texture 100 keeps the grain: ' + soft.skin.toFixed(2) + ' of ' + orig.skin.toFixed(2));
  // Strength 0 adds no step.
  await page.click('#btn-undo');
  await skinReady(page);
  await page.fill('#skin-strength', '0'); await page.dispatchEvent('#skin-strength', 'input');
  await applyTool(page, 'skin');
  assert((await page.evaluate(() => retouch.app.edits.stack.length)) === 3, 'strength 0 makes no step');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('skin: the brush adds and removes areas; the brush view shows them in blue', async () => {
  const { ctx, page } = await newApp({ init: BG_INIT });
  await load(page, skinPng());
  const orig = await skinStats(page);
  await page.evaluate(() => window.__fakeSkin([200, 150, 130], 80));
  await skinReady(page);
  await page.fill('#skin-strength', '100'); await page.dispatchEvent('#skin-strength', 'input');
  await page.click('[data-skinmode="erase"]');
  assert(await page.isVisible('#skin-brush-rows') && await page.isHidden('#skin-view-rows'), 'brush rows shown');
  const tint = await page.evaluate(() => [window.__px(retouch.app.preview.src, 150, 170), window.__px(retouch.app.preview.src, 20, 20)]);
  assert(tint[0][2] > 150 && tint[0][0] < 170, 'skin tinted blue in the brush view: ' + tint[0]);
  assert(Math.abs(tint[1][2] - orig.bytes[(20 * 300 + 20) * 4 + 2]) <= 1, 'sky not tinted: ' + tint[1]);
  // Remove the spot from the mask, add a patch of sky.
  await brush(page, [[140, 110], [160, 110]]);
  await page.click('[data-skinmode="keep"]');
  await page.fill('#skin-brush', '120'); await page.dispatchEvent('#skin-brush', 'input');
  await brush(page, [[25, 25], [45, 25], [45, 40], [25, 40]]);
  assert((await page.evaluate(() => retouch.tools.skin.strokes.map((s) => s.mode).join())) === 'erase,keep', 'two strokes');
  await page.click('#skin-undo-stroke');
  await brush(page, [[25, 25], [45, 25], [45, 40], [25, 40]]);
  await page.click('[data-skinmode="view"]');
  await applyTool(page, 'skin');
  const got = await skinStats(page);
  assert(Math.abs(got.depth - orig.depth) < 4, 'removed area keeps its spot: ' + orig.depth.toFixed(1) + ' / ' + got.depth.toFixed(1));
  assert(got.sky < 0.6 * orig.sky, 'added sky patch is smoothed: ' + orig.sky.toFixed(2) + ' to ' + got.sky.toFixed(2));
  assert(got.skin < orig.skin, 'the rest of the skin is smoothed');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('skin: the real model gives skin from its own classes, and a failure is said plainly', async () => {
  const { ctx, page } = await newApp();
  await load(page, skinPng());
  await skinReady(page);
  const m = await page.evaluate(() => ({ w: retouch.tools.skin.model.w, cov: retouch.tools.skin.model.coverage, face: retouch.tools.skin.faceSize, o: retouch.segmenter.skinOverride }));
  assert(m.w === 300 && m.cov >= 0 && m.cov <= 1 && m.face >= 20 && m.o === null, 'real skin model ' + JSON.stringify(m));
  await page.click('.sheet-panel[data-tool="skin"] [data-cancel]');
  await page.evaluate(() => { retouch.segmenter.skinOverride = () => { throw new Error('model file missing'); }; });
  await page.click('[data-open-tool="skin"]');
  await page.waitForSelector('.notice.fail[data-id="skin"]');
  assert(/Skin smoothing could not start: model file missing/.test(await page.textContent('.notice.fail[data-id="skin"]')), 'failure message');
  await idle(page);
  assert(await page.evaluate(() => retouch.app.tool === null && retouch.app.edits.stack.length === 1), 'tool closed, nothing changed');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

/* ---------- Phase 5: spot eraser ---------- */

test('spot core: the fill rebuilds flat colour, gradients and edges; grain matches; nothing else moves', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(() => {
    const core = retouch.core, W = 120, H = 100, out = {};
    const inSpot = (x, y) => Math.hypot(x + 0.5 - 60, y + 0.5 - 50) < 10;
    const build = (pix) => {
      const c = core.makeCanvas(W, H), x = c.getContext('2d', { willReadFrequently: true }), img = x.createImageData(W, H);
      for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) img.data.set([...pix(X, y), 255], (y * W + X) * 4);
      x.putImageData(img, 0, 0);
      return x;
    };
    const fix = (pix, st = { r: 10, pts: [{ x: 60, y: 50 }] }) => {
      const x = build(pix), before = x.getImageData(0, 0, W, H).data;
      const patch = core.fixSpot(x, st, W, H);
      return { d: x.getImageData(0, 0, W, H).data, before, patch, x };
    };
    // Flat colour and a straight gradient under a magenta spot come back exactly.
    let f = fix((x, y) => (inSpot(x, y) ? [255, 0, 255] : [120, 140, 160]));
    out.flat = f.d.reduce((m, v, i) => Math.max(m, i % 4 === 3 ? 0 : Math.abs(v - [120, 140, 160][i % 4])), 0);
    f = fix((x, y) => (inSpot(x, y) ? [255, 0, 255] : [x * 2, y * 2, 77]));
    let g = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; g = Math.max(g, Math.abs(f.d[o] - x * 2), Math.abs(f.d[o + 1] - y * 2), Math.abs(f.d[o + 2] - 77)); }
    out.gradient = g;
    // Outside the spot nothing changes, and the patch puts the spot back exactly.
    let moved = 0;
    for (let i = 0; i < W * H; i++) if (!inSpot(i % W, Math.floor(i / W))) for (let k = 0; k < 4; k++) moved = Math.max(moved, Math.abs(f.d[4 * i + k] - f.before[4 * i + k]));
    out.moved = moved;
    f.x.putImageData(f.patch.img, f.patch.x, f.patch.y);
    out.undo = f.x.getImageData(0, 0, W, H).data.every((v, i) => v === f.before[i]);
    out.patch = [f.patch.x, f.patch.y, f.patch.img.width, f.patch.img.height];
    // A hard edge through the middle of the spot is rebuilt near its true place (between x 59 and 60).
    f = fix((x, y) => (inSpot(x, y) ? [255, 0, 255] : x < 60 ? [40, 40, 40] : [220, 220, 220]));
    out.edge = [52, 56, 58, 61, 63, 67].map((x) => f.d[(50 * W + x) * 4]);
    // Grainy skin with a dark spot: the fill takes the skin's colour and grain.
    let seed = 9; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const gr = Array.from({ length: W * H }, () => (rnd() - 0.5) * 20);
    f = fix((x, y) => { const v = gr[y * W + x]; return inSpot(x, y) ? [120 + v, 60 + v, 50 + v] : [200 + v, 150 + v, 130 + v]; });
    const stat = (cond) => { let s2 = 0, m = 0, k = 0; for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) { if (!cond(x, y)) continue; let a = 0; for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) a += f.d[((y + v) * W + x + u) * 4 + 1]; const e = f.d[(y * W + x) * 4 + 1] - a / 9; s2 += e * e; m += f.d[(y * W + x) * 4 + 1]; k++; } return [Math.sqrt(s2 / k), m / k]; };
    out.grainSpot = stat((x, y) => Math.hypot(x + 0.5 - 60, y + 0.5 - 50) < 8);
    out.grainAround = stat((x, y) => { const d = Math.hypot(x + 0.5 - 60, y + 0.5 - 50); return d > 14 && d < 30; });
    // A spot against the frame edge, and a stroke rather than a dot.
    f = fix((x, y) => (Math.hypot(x + 0.5, y + 0.5 - 50) < 8 ? [0, 255, 0] : [90, 90, 200]), { r: 8, pts: [{ x: 0, y: 50 }] });
    out.atEdge = f.d.reduce((m, v, i) => Math.max(m, i % 4 === 3 ? 0 : Math.abs(v - [90, 90, 200][i % 4])), 0);
    const onLine = (x, y) => Math.abs(y + 0.5 - 30) < 3 && x >= 20 && x < 100;
    f = fix((x, y) => (onLine(x, y) ? [10, 10, 10] : [180, 170, 160]), { r: 4, pts: [{ x: 18, y: 30 }, { x: 102, y: 30 }] });
    out.line = f.d.reduce((m, v, i) => Math.max(m, i % 4 === 3 ? 0 : Math.abs(v - [180, 170, 160][i % 4])), 0);
    // Weighting: errors against the true picture inside the spot, for a vertical edge, a
    // slanted edge and a thin slanted line crossing it. Limits sit just above what the
    // fill does now; leaving out the direction or distance weights goes well past them.
    const mae = (truth, st = { r: 10, pts: [{ x: 60, y: 50 }] }) => {
      const x = build(truth); core.fixSpot(x, st, W, H);
      const d = x.getImageData(0, 0, W, H).data;
      let e = 0, k = 0;
      for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) if (inSpot(X, y)) { e += Math.abs(d[(y * W + X) * 4] - truth(X, y)[0]); k++; }
      return +(e / k).toFixed(2);
    };
    out.mae = [mae((x) => (x < 60 ? [40, 40, 40] : [220, 220, 220])), mae((x, y) => (x - 60 + (y - 50) * 0.5 < 0 ? [40, 40, 40] : [220, 220, 220])),
      mae((x, y) => (Math.abs((x - 60) * 0.6 - (y - 50) * 0.8) < 1.5 ? [30, 30, 30] : [200, 200, 200]))];
    // Large spots on grainy, shaded skin (the case that burst into black and white rays
    // on the phone, 24/10/26, reaching 0 and 255): the bulk of the fill (1st to 99th
    // percentile) stays within 15 levels of the skin's own, nothing comes near black or
    // white, and its texture is the skin's own (spread within 20 % of the skin's).
    out.big = [[20, 30], [20, 45], [30, 60]].map(([amp, rad]) => {
      const BW = 300; let sd = 7; const rr = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
      const c = core.makeCanvas(BW, BW), x = c.getContext('2d', { willReadFrequently: true }), img = x.createImageData(BW, BW);
      for (let y = 0; y < BW; y++) for (let X = 0; X < BW; X++) { const g = (rr() - 0.5) * amp + 6 * Math.sin(y / 3); img.data.set([205 + g - y * 0.05, 150 + g, 130 + g, 255], (y * BW + X) * 4); }
      x.putImageData(img, 0, 0);
      // Spread and the 1st and 99th percentiles of the green channel over a region.
      const stat = (dd, cond) => { const vs = []; for (let y = 0; y < BW; y++) for (let X = 0; X < BW; X++) if (cond(Math.hypot(X - 150, y - 150))) vs.push(dd[(y * BW + X) * 4 + 1]); vs.sort((a, b) => a - b); const m = vs.reduce((a, b) => a + b, 0) / vs.length; return { mn: vs[Math.floor(vs.length * 0.01)], mx: vs[Math.floor(vs.length * 0.99)], lo: vs[0], hi: vs[vs.length - 1], mean: m, sd: Math.sqrt(vs.reduce((a, b) => a + (b - m) ** 2, 0) / vs.length) }; };
      const around = stat(x.getImageData(0, 0, BW, BW).data, (dist) => dist > rad + 5 && dist < rad + 30);
      core.fixSpot(x, { r: rad, pts: [{ x: 150, y: 150 }] }, BW, BW);
      const fill = stat(x.getImageData(0, 0, BW, BW).data, (dist) => dist < rad - 1);
      return { rad, fill: [fill.mn, fill.mx], around: [around.mn, around.mx], inRange: fill.mn >= around.mn - 15 && fill.mx <= around.mx + 15, extremes: [fill.lo, fill.hi], sdRatio: +(fill.sd / around.sd).toFixed(2), meanDiff: +Math.abs(fill.mean - around.mean).toFixed(1) };
    });
    // A bright cone with clean slopes all pointing up into the spot: carried along them,
    // the fill would end brighter than anything round it. The fill itself (before grain)
    // is held to the range of the pixels touching the spot.
    {
      const N = 41, cd = new Uint8ClampedArray(N * N * 4), cm = new Uint8Array(N * N);
      let edgeMax = 0;
      for (let i = 0; i < N * N; i++) {
        const dd = Math.hypot(i % N - 20, Math.floor(i / N) - 20), v = Math.round(250 - 4 * dd);
        cd.set([v, v, v, 255], 4 * i);
        if (dd < 10) cm[i] = 1;
      }
      for (let i = 0; i < N * N; i++) if (!cm[i] && [i - 1, i + 1, i - N, i + N].some((j) => cm[j])) edgeMax = Math.max(edgeMax, cd[4 * i]);
      core.inpaint(cd, N, N, cm);
      let top = 0; for (let i = 0; i < N * N; i++) if (cm[i]) top = Math.max(top, cd[4 * i]);
      out.cone = [top, edgeMax];
    }
    // Arrival distance over every pixel of an awkward spot (an L and a disc), against the
    // true distance to the nearest known pixel.
    const M = 80, dm = new Uint8ClampedArray(M * M * 4).fill(128), mk = new Uint8Array(M * M);
    for (let i = 0; i < M * M; i++) { const x = i % M, y = Math.floor(i / M); if ((x > 10 && x < 30 && y > 10 && y < 70) || (x > 10 && x < 70 && y > 50 && y < 70) || Math.hypot(x - 55, y - 25) < 14) mk[i] = 1; }
    const T2 = core.inpaint(dm, M, M, mk);
    const known = []; for (let j = 0; j < M * M; j++) if (!mk[j]) known.push([j % M, Math.floor(j / M)]);
    let tmax = 0, tsum = 0, tn = 0;
    for (let i = 0; i < M * M; i++) {
      if (!mk[i]) continue;
      const x = i % M, y = Math.floor(i / M);
      let best = 1e9; for (const [u, v] of known) { const dd = (u - x) * (u - x) + (v - y) * (v - y); if (dd < best) best = dd; }
      const e = Math.abs(T2[i] - Math.sqrt(best)); tmax = Math.max(tmax, e); tsum += e; tn++;
    }
    out.Tall = [+tmax.toFixed(2), +(tsum / tn).toFixed(3)];
    // Healing. The membrane against a direct solve (Jacobi, run to the end) on a small
    // random problem: inside the mask each value is the mean of its four neighbours.
    {
      const mw = 14, mh = 11, mk = new Uint8Array(mw * mh), hv = new Float32Array(3 * mw * mh);
      let sd = 5; const rr = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < mw * mh; i++) { const x = i % mw, y = Math.floor(i / mw); if (x > 2 && x < 11 && y > 2 && y < 8 && !(x === 5 && y === 4)) mk[i] = 1; for (let c = 0; c < 3; c++) hv[3 * i + c] = rr() * 100; }
      const ref = Float32Array.from(hv);
      for (let it = 0; it < 20000; it++) { const nx = Float32Array.from(ref); for (let i = 0; i < mw * mh; i++) if (mk[i]) for (let c = 0; c < 3; c++) nx[3 * i + c] = (ref[3 * (i - 1) + c] + ref[3 * (i + 1) + c] + ref[3 * (i - mw) + c] + ref[3 * (i + mw) + c]) / 4; ref.set(nx); }
      core.membrane(hv, mw, mh, mk);
      out.membrane = Math.max(...Array.from(hv).map((v, i) => Math.abs(v - ref[i])));
    }
    // The source: with a second dark mark beside the spot, on each side in turn, the copy
    // never brings it in; and the healed fill is used (not the fallback).
    out.avoid = [[100, 72], [128, 100], [100, 128], [72, 100], [120, 80]].map(([mx, my]) => {
      const BW = 200; let sd = 3; const rr = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
      const c = core.makeCanvas(BW, BW), x = c.getContext('2d', { willReadFrequently: true }), img = x.createImageData(BW, BW);
      for (let y = 0; y < BW; y++) for (let X = 0; X < BW; X++) { const g = (rr() - 0.5) * 16; const dark = Math.hypot(X - 100, y - 100) < 8 || Math.hypot(X - mx, y - my) < 8; img.data.set([dark ? 120 + g : 200 + g, dark ? 70 + g : 150 + g, dark ? 60 + g : 130 + g, 255], (y * BW + X) * 4); }
      x.putImageData(img, 0, 0);
      const p = core.fixSpot(x, { r: 10, pts: [{ x: 100, y: 100 }] }, BW, BW);
      const d = x.getImageData(90, 90, 20, 20).data; let mn = 255; for (let i = 1; i < d.length; i += 4) mn = Math.min(mn, d[i]);
      return [mn, p.healed];
    });
    // No room for a source (a spot filling most of a small photo): Telea's fill is used.
    {
      const x = build((X, y) => [120 + (X % 3), 140, 160]);
      const tiny = core.makeCanvas(40, 40), tx = tiny.getContext('2d', { willReadFrequently: true });
      tx.drawImage(x.canvas, 0, 0);
      const p = core.fixSpot(tx, { r: 12, pts: [{ x: 20, y: 20 }] }, 40, 40);
      const d = tx.getImageData(14, 14, 12, 12).data; let e = 0; for (let i = 0; i < d.length; i += 4) e = Math.max(e, Math.abs(d[i + 1] - 140), Math.abs(d[i + 2] - 160));
      out.fallback = [p.healed, e];
    }
    // The fallback (Telea's fill and grain) on the same scenes, called directly.
    const telea = (pix, rad = 10, cx = 60, cy = 50, BW = W, BH = H) => {
      const x = (() => { const c = core.makeCanvas(BW, BH), xx = c.getContext('2d', { willReadFrequently: true }), img = xx.createImageData(BW, BH); for (let y = 0; y < BH; y++) for (let X = 0; X < BW; X++) img.data.set([...pix(X, y), 255], (y * BW + X) * 4); xx.putImageData(img, 0, 0); return xx; })();
      const img = x.getImageData(0, 0, BW, BH), mk = new Uint8Array(BW * BH);
      for (let i = 0; i < BW * BH; i++) if (Math.hypot(i % BW + 0.5 - cx, Math.floor(i / BW) + 0.5 - cy) < rad) mk[i] = 1;
      core.fillTelea(img.data, BW, BH, mk);
      return img.data;
    };
    const tin = (x, y) => Math.hypot(x + 0.5 - 60, y + 0.5 - 50) < 10;
    {
      let t = telea((x, y) => (tin(x, y) ? [255, 0, 255] : [120, 140, 160]));
      out.tFlat = t.reduce((m, v, i) => Math.max(m, i % 4 === 3 ? 0 : Math.abs(v - [120, 140, 160][i % 4])), 0);
      t = telea((x, y) => (tin(x, y) ? [255, 0, 255] : [x * 2, y * 2, 77]));
      let g = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; g = Math.max(g, Math.abs(t[o] - x * 2), Math.abs(t[o + 1] - y * 2)); }
      out.tGrad = g;
      const tm = (truth) => { const d = telea(truth); let e = 0, k = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (tin(x, y)) { e += Math.abs(d[(y * W + x) * 4] - truth(x, y)[0]); k++; } return +(e / k).toFixed(2); };
      out.tMae = [tm((x) => (x < 60 ? [40, 40, 40] : [220, 220, 220])), tm((x, y) => (x - 60 + (y - 50) * 0.5 < 0 ? [40, 40, 40] : [220, 220, 220])),
        tm((x, y) => (Math.abs((x - 60) * 0.6 - (y - 50) * 0.8) < 1.5 ? [30, 30, 30] : [200, 200, 200]))];
      // Grainy, shaded skin, a small and a large spot: the fill stays in range, and its
      // texture is close to the skin's (grain put back; not streaky).
      out.tTex = [[12, 15], [30, 60]].map(([amp, rad]) => {
        let sd = 7; const rr = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
        const gr = Array.from({ length: 300 * 300 }, () => (rr() - 0.5) * amp);
        const tt = telea((X, y) => { const v = gr[y * 300 + X] + 6 * Math.sin(y / 3); return [205 + v - y * 0.05, 150 + v, 130 + v]; }, rad, 150, 150, 300, 300);
        const sdOf = (cond) => { const vs = []; for (let y = 0; y < 300; y++) for (let X = 0; X < 300; X++) if (cond(Math.hypot(X - 150, y - 150))) vs.push(tt[(y * 300 + X) * 4 + 1]); vs.sort((p, q) => p - q); const m = vs.reduce((a2, c) => a2 + c, 0) / vs.length; return { sd: Math.sqrt(vs.reduce((a2, c) => a2 + (c - m) ** 2, 0) / vs.length), lo: vs[0], hi: vs[vs.length - 1] }; };
        const fill = sdOf((r) => r < rad - 1), around = sdOf((r) => r > rad + 5 && r < rad + 30);
        return { rad, ratio: +(fill.sd / around.sd).toFixed(2), lo: fill.lo, hi: fill.hi };
      });
    }
    // Healing scenes where each rule of the source search decides the result.
    {
      const make = (BW, BH, pix) => { const c = core.makeCanvas(BW, BH), x = c.getContext('2d', { willReadFrequently: true }), img = x.createImageData(BW, BH); for (let y = 0; y < BH; y++) for (let X = 0; X < BW; X++) img.data.set([...pix(X, y).map((v) => Math.round(v)), 255], (y * BW + X) * 4); x.putImageData(img, 0, 0); return x; };
      const maeIn = (x, BW, truth, inside) => { const d = x.getImageData(0, 0, BW, x.canvas.height).data; let e = 0, k = 0; for (let i = 0; i < d.length / 4; i++) { const X = i % BW, y = Math.floor(i / BW); if (!inside(X, y)) continue; e += Math.abs(d[4 * i + 1] - truth(X, y)[1]); k++; } return +(e / k).toFixed(2); };
      const minIn = (x, BW, inside) => { const d = x.getImageData(0, 0, BW, x.canvas.height).data; let m = 255; for (let i = 0; i < d.length / 4; i++) if (inside(i % BW, Math.floor(i / BW))) m = Math.min(m, d[4 * i + 1]); return m; };
      const barsAt = (X, y) => Math.abs(y - 100) <= 3 && ((X >= 112 && X <= 128) || (X >= 72 && X <= 88));
      const inC = (X, y) => Math.hypot(X + 0.5 - 100, y + 0.5 - 100) < 9;
      // Wrinkle rows with dark bars where the best-matching sources would come from, with
      // grain (the rim match must allow for a colour difference) and without (marks in a
      // source must count against it): the bars are never copied in.
      out.marks = [[6, 3], [0, 2.3]].map(([gamp, per]) => {
        let sd = 4; const rr = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
        const x = make(200, 200, (X, y) => { const g = (rr() - 0.5) * gamp + 18 * Math.sin(y / per); return barsAt(X, y) ? [110, 60, 50] : [200 + g, 150 + g, 130 + g]; });
        core.fixSpot(x, { r: 10, pts: [{ x: 100, y: 100 }] }, 200, 200);
        return minIn(x, 200, inC);
      });
      // A long scratch over wrinkle rows: healed with skin, nothing dark left.
      const scratch = (X, y) => Math.abs(y - 100) <= 1 && X >= 60 && X <= 240;
      const xs = make(300, 220, (X, y) => { const v = 150 + 18 * Math.sin(y / 3); return scratch(X, y) ? [60, 40, 40] : [v + 50, v, v - 20]; });
      core.fixSpot(xs, { r: 4, pts: [{ x: 58, y: 100 }, { x: 242, y: 100 }] }, 300, 220);
      out.scratch = minIn(xs, 300, scratch);
      // A large spot on fine tilted wrinkles: the search lines them up to within a fraction of a level.
      const tilt = (X, y) => { const v = 150 + 40 * Math.sin((y - 0.37 * X) / 1.6); return [v + 50, v, v - 20]; };
      const inT = (X, y) => Math.hypot(X + 0.5 - 150, y + 0.5 - 150) < 30;
      const xt = make(300, 300, (X, y) => (inT(X, y) ? [0, 0, 0] : tilt(X, y)));
      core.fixSpot(xt, { r: 30, pts: [{ x: 150, y: 150 }] }, 300, 300);
      out.tilted = maeIn(xt, 300, tilt, inT);
    }
    // The heap gives keys back smallest first, whatever order they went in.
    const hp = core.minHeap(), keys = Array.from({ length: 500 }, (_, i) => Math.sin(i * 7.3) * 100);
    keys.forEach((k, i) => hp.push(i, k));
    const order = []; while (hp.size) order.push(keys[hp.pop()]);
    out.heap = order.length === 500 && order.every((k, i) => !i || k >= order[i - 1]);
    // Arrival distance: in a disc of radius 10, T at a pixel is about its distance from the edge.
    const d = new Uint8ClampedArray(41 * 41 * 4).fill(128), mask = new Uint8Array(41 * 41);
    for (let i = 0; i < 41 * 41; i++) if (Math.hypot(i % 41 - 20, Math.floor(i / 41) - 20) < 10) mask[i] = 1;
    const T = core.inpaint(d, 41, 41, mask);
    out.T = [[20, 20], [25, 20], [20, 14], [27, 27]].map(([x, y]) => +(T[y * 41 + x] - (10 - Math.hypot(x - 20, y - 20))).toFixed(2));
    out.Tout = T[0] === 0 && T[20 * 41 + 35] === 0;
    // Grain estimate: an edge running through the ring is not grain.
    const e = new Uint8ClampedArray(30 * 30 * 4), em = new Uint8Array(900);
    for (let i = 0; i < 900; i++) { const v = i % 30 < 15 ? 30 : 220; e.set([v, v, v, 255], 4 * i); if (Math.hypot(i % 30 - 15, Math.floor(i / 30) - 15) < 5) em[i] = 1; }
    out.edgeGrain = core.spotGrain(e, 30, 30, em, core.spotRing(em, 30, 30));
    // On noise of known spread (10 levels), the estimate comes back close to 10.
    const nz = new Uint8ClampedArray(60 * 60 * 4), nm = new Uint8Array(3600);
    for (let i = 0; i < 3600; i++) { const v = 128 + 10 * core.spotNoise(i % 60 + 500, Math.floor(i / 60) + 900); nz.set([v, v, v, 255], 4 * i); if (Math.hypot(i % 60 - 30, Math.floor(i / 60) - 30) < 6) nm[i] = 1; }
    out.knownGrain = core.spotGrain(nz, 60, 60, nm, core.spotRing(nm, 60, 60, 20)).map((v) => +v.toFixed(2));
    // The noise: repeatable, mean about 0, spread about 1.
    let s1 = 0, s2 = 0; for (let i = 0; i < 20000; i++) { const z = core.spotNoise(i % 200, Math.floor(i / 200)); s1 += z; s2 += z * z; }
    out.noise = [+(s1 / 20000).toFixed(3), +Math.sqrt(s2 / 20000).toFixed(3), core.spotNoise(5, 7) === core.spotNoise(5, 7), core.spotNoise(5, 7) !== core.spotNoise(7, 5)];
    return out;
  });
  assert(r.flat === 0, 'flat colour should come back exactly, off by ' + r.flat);
  assert(r.gradient <= 1, 'gradient should come back within 1 level, off by ' + r.gradient);
  assert(r.moved === 0, 'pixels outside the spot changed by ' + r.moved);
  assert(r.undo, 'the patch must restore the spot exactly');
  assert(r.patch.join() === '49,39,22,22', 'patch block (the spot\'s box plus a pixel) ' + r.patch);
  assert(r.edge[0] < 60 && r.edge[1] < 70 && r.edge[4] > 190 && r.edge[5] > 200 && r.edge[2] < r.edge[3], 'edge rebuilt in place: ' + r.edge);
  assert(Math.abs(r.grainSpot[1] - r.grainAround[1]) < 4, 'fill colour matches the skin: ' + r.grainSpot[1].toFixed(1) + ' vs ' + r.grainAround[1].toFixed(1));
  assert(r.grainSpot[0] > 0.7 * r.grainAround[0] && r.grainSpot[0] < 1.3 * r.grainAround[0], 'fill grain matches: ' + r.grainSpot[0].toFixed(2) + ' vs ' + r.grainAround[0].toFixed(2));
  assert(r.atEdge <= 1 && r.line <= 1, 'spot at the frame edge ' + r.atEdge + ', stroke ' + r.line);
  assert(r.T.every((v) => Math.abs(v) <= 1.5) && r.Tout, 'arrival distance vs distance from the edge: ' + r.T);
  assert(r.Tall[0] <= 1 && r.Tall[1] <= 0.1, 'arrival distance over an L-shaped spot, worst and mean error: ' + r.Tall);
  assert(r.mae.every((v) => v <= 2), 'healed error at a vertical edge, slanted edge, thin line (a copy from along the line): ' + r.mae);
  for (const b of r.big) assert(b.inRange && b.extremes[0] > 60 && b.extremes[1] < 240 && b.sdRatio >= 0.8 && b.sdRatio <= 1.25 && b.meanDiff <= 4, 'large spot, radius ' + b.rad + ': ' + JSON.stringify(b));
  assert(r.heap, 'heap must give keys back smallest first');
  assert(r.tFlat === 0 && r.tGrad <= 1, 'fallback: flat ' + r.tFlat + ', gradient ' + r.tGrad);
  assert(r.tMae[0] <= 12 && r.tMae[1] <= 14.5 && r.tMae[2] <= 28, 'fallback error at a vertical edge, slanted edge, thin line: ' + r.tMae);
  assert(r.tTex.every((t) => t.ratio >= 0.8 && t.ratio <= 1.35 && t.lo > 60 && t.hi < 240), 'fallback texture on grainy skin (fill spread against the skin\'s): ' + JSON.stringify(r.tTex));
  assert(r.membrane < 0.1, 'membrane differs from a direct solve by ' + r.membrane);
  assert(r.avoid.every(([mn, healed]) => healed && mn > 110), 'the copy must not bring in a nearby mark: ' + JSON.stringify(r.avoid));
  assert(r.fallback[0] === false && r.fallback[1] <= 2, 'no room for a source: Telea fill used, flat colour kept: ' + r.fallback);
  assert(r.marks.every((m) => m > 110), 'dark bars near the spot must not be copied in: ' + r.marks);
  assert(r.scratch > 150, 'scratch healed with skin (wrinkle rows lined up): darkest ' + r.scratch);
  assert(r.tilted <= 0.6, 'large spot on tilted wrinkles, error ' + r.tilted);
  assert(r.cone[0] <= r.cone[1], 'fill on a cone must not pass the brightest pixel at its edge: ' + r.cone);
  assert(r.edgeGrain.every((v) => v < 0.5), 'an edge is not grain: ' + r.edgeGrain);
  assert(r.knownGrain.every((v) => Math.abs(v - 10) < 1.5), 'grain of noise with spread 10: ' + r.knownGrain);
  assert(Math.abs(r.noise[0]) < 0.03 && Math.abs(r.noise[1] - 1) < 0.05 && r.noise[2] && r.noise[3], 'noise ' + r.noise);
  await ctx.close();
}, { core: true });

// 300 x 200 grainy skin with a dark spot at (80, 70) and a dark scratch along y = 140 from x 150 to 250.
const spotPng = () => {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return makePng(300, 200, (x, y) => {
    const g = (rnd() - 0.5) * 12;
    if (Math.hypot(x - 80, y - 70) < 5) return [110 + g, 70 + g, 60 + g, 255].map(Math.round);
    if (Math.abs(y - 140) < 2 && x >= 150 && x < 250) return [60 + g, 40 + g, 40 + g, 255].map(Math.round);
    return [200 + g, 150 + g, 130 + g, 255].map(Math.round);
  });
};
// Mean green inside a box of the current image (or the stage preview).
const meanG = (page, x0, y0, x1, y1, which = 'current') => page.evaluate(([x0, y0, x1, y1, which]) => {
  const src = which === 'preview' ? retouch.app.preview.src : retouch.app.edits.current;
  const d = retouch.readPixels(src, x0, y0, x1 - x0, y1 - y0);
  let s = 0; for (let i = 1; i < d.length; i += 4) s += d[i];
  return s / (d.length / 4);
}, [x0, y0, x1, y1, which]);

test('spot: a tap fills a spot, a stroke fills a scratch; undo stroke; two fingers zoom instead', async () => {
  const { ctx, page } = await newApp({ init: [TEXT_INIT, BG_INIT] });
  await load(page, spotPng());
  await textBox(page, { text: 'HI', size: 30 });
  const before = await texts(page);
  const spot0 = await meanG(page, 77, 67, 84, 74), line0 = await meanG(page, 160, 139, 240, 142);
  await page.click('[data-open-tool="spot"]');
  assert((await page.textContent('#spot-out')) === 'No spots fixed yet.' && await page.isDisabled('#spot-undo-stroke'), 'starts with nothing fixed');
  await brush(page, [[80, 70]]); await idle(page);                    // a tap
  assert((await page.evaluate(() => retouch.tools.spot.patches.length)) === 1, 'tap fixed one spot');
  const spot1 = await meanG(page, 77, 67, 84, 74, 'preview');
  assert(spot0 < 90 && spot1 > 140, 'spot filled with skin on the stage: ' + spot0.toFixed(1) + ' to ' + spot1.toFixed(1));
  await brush(page, [[145, 140], [255, 140]]); await idle(page);
  assert((await meanG(page, 160, 139, 240, 142, 'preview')) > 140, 'scratch filled');
  assert((await page.textContent('#spot-out')) === '2 spots fixed.', 'status ' + await page.textContent('#spot-out'));
  await page.click('#spot-undo-stroke');
  assert(Math.abs((await meanG(page, 160, 139, 240, 142, 'preview')) - line0) < 0.01, 'undo stroke brings the scratch back exactly');
  // A second finger: no fill, and the view zooms.
  const s0 = await page.evaluate(() => retouch.view.scale);
  await page.evaluate(() => {
    const c = document.querySelector('#view'), r = c.getBoundingClientRect();
    const ev = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerType: 'touch', isPrimary: id === 51 }));
    ev('pointerdown', 51, 180, 200); ev('pointermove', 51, 175, 200); ev('pointerdown', 52, 220, 200);
    for (let i = 1; i <= 10; i++) { ev('pointermove', 51, 175 - i * 6, 200); ev('pointermove', 52, 220 + i * 6, 200); }
    ev('pointerup', 51, 115, 200); ev('pointerup', 52, 280, 200);
  });
  assert((await page.evaluate(() => retouch.tools.spot.patches.length)) === 1, 'the pinch fixed nothing');
  assert((await page.evaluate(() => retouch.view.scale)) > s0 * 1.5, 'two fingers zoomed');
  // Zoomed in, the scratch again, then apply.
  await brush(page, [[145, 140], [255, 140]]); await idle(page);
  await applyTool(page, 'spot');
  const spot2 = await meanG(page, 77, 67, 84, 74), line2 = await meanG(page, 160, 139, 240, 142), skin = await meanG(page, 20, 20, 60, 60);
  assert(Math.abs(spot2 - skin) < 6 && Math.abs(line2 - skin) < 6, 'filled like the skin around: spot ' + spot2.toFixed(1) + ', scratch ' + line2.toFixed(1) + ', skin ' + skin.toFixed(1));
  assert(Math.abs(spot2 - spot1) < 0.01, 'the result is what the stage showed');
  assert((await page.evaluate(() => retouch.app.edits.stack[retouch.app.edits.index].label)) === 'Spot eraser', 'history label');
  assert(JSON.stringify(await texts(page)) === JSON.stringify(before), 'text boxes carried through');
  await page.click('#btn-undo');
  assert(Math.abs((await meanG(page, 77, 67, 84, 74)) - spot0) < 0.01, 'undo restores the photo');
  // Apply with nothing fixed adds no step; a big stroke gets a warning.
  await page.click('[data-open-tool="spot"]');
  await applyTool(page, 'spot');
  assert((await page.evaluate(() => retouch.app.edits.stack.length)) === 3, 'nothing fixed, no step');
  await page.click('[data-open-tool="spot"]');
  await page.fill('#spot-brush', '80'); await page.dispatchEvent('#spot-brush', 'input');
  await brush(page, [[20, 20], [280, 20], [280, 180], [20, 180]]); await idle(page);
  await page.waitForSelector('.notice[data-id="spot-large"]');
  await page.click('.sheet-panel[data-tool="spot"] [data-cancel]');
  assert((await page.evaluate(() => retouch.app.edits.stack.length)) === 3, 'cancel keeps nothing');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

/* ---------- Video phase V1: check, open, trim, sound, export ---------- */

// In the page: build a synthetic clip with WebCodecs and the app's own Mediabunny.
// Frame i is a flat colour whose red level says which frame it is (20 + 2i), so a
// decoded frame can be traced back. The sound is a tone rising from 440 Hz (so no two
// packets are alike and each can be traced too), in Opus (Chromium on
// Linux has no AAC encoder; the copying code does not care which codec it is).
// The file is written with the index (moov) last, so a test can add boxes to it.
const VIDEO_INIT = () => {
  window.__makeClip = async (o = {}) => {
    const { w = 320, h = 240, fps = 30, frames = 90, gop = 30, audio = true, rotation = 0, colorSpace = null, blue = 64, rate = 48000, channels = 1, mark = false } = o;
    const MB = await retouch.loadMediabunny();
    const target = new MB.BufferTarget();
    const out = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: false }), target });
    const vs = new MB.EncodedVideoPacketSource('avc');
    out.addVideoTrack(vs, { rotation });
    let as = null;
    if (audio) { as = new MB.EncodedAudioPacketSource('opus'); out.addAudioTrack(as); }
    await out.start();
    const vc = [];
    const enc = new VideoEncoder({ output: (c, m) => vc.push([c, m]), error: (e) => { throw e; } });
    enc.configure({ codec: 'avc1.42001f', width: w, height: h, framerate: fps, bitrate: 1e6 });
    const cv = new OffscreenCanvas(w, h), cx = cv.getContext('2d');
    for (let i = 0; i < frames; i++) {
      cx.fillStyle = 'rgb(' + (20 + 2 * i) + ',128,' + blue + ')'; cx.fillRect(0, 0, w, h);
      if (mark) { cx.fillStyle = '#fff'; cx.fillRect(0, 0, w / 4, h / 4); }     // a white corner, top left as stored
      const f = new VideoFrame(cv, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(f, { keyFrame: i % gop === 0 }); f.close();
    }
    await enc.flush(); enc.close();
    const ac = [];
    if (audio) {
      const ae = new AudioEncoder({ output: (c, m) => ac.push([c, m]), error: (e) => { throw e; } });
      ae.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: channels, bitrate: 48000 });
      const n = rate / 50, total = Math.round(rate * frames / fps);
      for (let s = 0; s < total; s += n) {
        const d = new Float32Array(n * channels);
        for (let k = 0; k < n; k++) { const tau = (s + k) / rate; for (let c = 0; c < channels; c++) d[k * channels + c] = 0.3 * Math.sin(2 * Math.PI * (440 * tau + 150 * tau * tau)); }
        const a = new AudioData({ format: 'f32', sampleRate: rate, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round(s * 1e6 / rate), data: d });
        ae.encode(a); a.close();
      }
      await ae.flush(); ae.close();
    }
    let i = 0, j = 0;
    while (i < vc.length || j < ac.length) {
      if (j >= ac.length || (i < vc.length && vc[i][0].timestamp <= ac[j][0].timestamp)) {
        const [c, m] = vc[i++];
        if (m && m.decoderConfig && colorSpace) m.decoderConfig.colorSpace = colorSpace;
        await vs.add(MB.EncodedPacket.fromEncodedChunk(c), m);
      } else { const [c, m] = ac[j++]; await as.add(MB.EncodedPacket.fromEncodedChunk(c), m); }
    }
    await out.finalize();
    return Array.from(new Uint8Array(target.buffer));
  };
  // Decode samples (bytes found by the test's own MP4 reader) and return each frame's
  // mean colour at the centre.
  window.__decode = async (codec, description, samples) => {
    const got = [];
    const dec = new VideoDecoder({
      output: (f) => {
        const c = new OffscreenCanvas(8, 8), x = c.getContext('2d');
        x.drawImage(f, f.displayWidth / 2 - 4, f.displayHeight / 2 - 4, 8, 8, 0, 0, 8, 8);
        const d = x.getImageData(0, 0, 8, 8).data;
        got.push([d[0], d[1], d[2]]); f.close();
      },
      error: (e) => { got.push('error ' + e.message); },
    });
    dec.configure({ codec, description: new Uint8Array(description) });
    samples.forEach((s, i) => dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: i * 33333, data: new Uint8Array(s.data) })));
    await dec.flush();
    return got;
  };
  // Read an export back with Mediabunny: its picture and sound facts, the mean colour
  // of a 4 x 4 patch at each point (fractions of the width and height) in the frame
  // on screen at each time, and the loudness (RMS) of the first sound channel in
  // each time window.
  window.__probe = async (arr, o = {}) => {
    const MB = await retouch.loadMediabunny();
    const input = new MB.Input({ source: new MB.BufferSource(new Uint8Array(arr).buffer), formats: [MB.MP4] });
    const vt = await input.getPrimaryVideoTrack(), at = await input.getPrimaryAudioTrack();
    const res = { w: vt.displayWidth, h: vt.displayHeight, codec: vt.codec, colors: [], rms: [], duration: await input.computeDuration(),
      audio: at ? { codec: at.codec, rate: at.sampleRate, ch: at.numberOfChannels, duration: (await at.computeDuration()) } : null };
    if (o.at) {
      const sink = new MB.CanvasSink(vt, { poolSize: 1 });
      for await (const wc of sink.canvasesAtTimestamps(o.at)) {
        const x = wc.canvas.getContext('2d');
        res.colors.push((o.points || [[0.5, 0.5]]).map(([u, v]) => {
          const d = x.getImageData(Math.min(res.w - 4, Math.floor(u * res.w)), Math.min(res.h - 4, Math.floor(v * res.h)), 4, 4).data;
          const m = [0, 0, 0];
          for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) m[c] += d[i + c] / 16;
          return m.map(Math.round);
        }));
      }
    }
    if (at && o.windows) {
      const sink = new MB.AudioSampleSink(at);
      for (const [a, b] of o.windows) {
        let sum = 0, n = 0;
        for await (const s of sink.samples(a, b)) {
          const p = new Float32Array(s.numberOfFrames);
          s.copyTo(p, { planeIndex: 0, format: 'f32-planar' });
          for (const v of p) { sum += v * v; n++; }
          s.close();
        }
        res.rms.push(Math.sqrt(sum / Math.max(1, n)));
      }
    }
    input.dispose();
    return res;
  };
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
};

async function makeClip(page, opts = {}) {
  await page.evaluate(VIDEO_INIT);
  return Buffer.from(await page.evaluate((o) => window.__makeClip(o), opts));
}
async function loadVideo(page, buffer, name = 'PXL_20261029_test.mp4') {
  await page.evaluate(() => { window.__beforeClip = window.retouch.app.video; });
  await page.setInputFiles('#file', { name, mimeType: 'video/mp4', buffer });
  await page.waitForFunction(() => window.retouch.app.video && window.retouch.app.video !== window.__beforeClip && window.retouch.app.busyCount === 0);
}
// Open the video export sheet, wait for the copy, download it, return the bytes.
async function exportVideo(page) {
  await page.click('#btn-export');
  await page.waitForFunction(() => !document.querySelector('#vexport-download').disabled || /Fail/.test(document.querySelector('#vexport-meta').textContent), null, { timeout: 30000 });
  const meta = await page.textContent('#vexport-meta');
  assert(!/Fail/.test(meta), 'export failed: ' + meta);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#vexport-download')]);
  const bytes = fs.readFileSync(await dl.path());
  await page.click('.sheet-panel[data-tool="vexport"] [data-cancel]');
  return { bytes, name: dl.suggestedFilename() };
}
const vtrack = (m) => m.tracks.find((t) => t.handler === 'vide');
const strack = (m) => m.tracks.find((t) => t.handler === 'soun');
const seconds = (t) => t.mediaDuration / t.mdhd.timescale;
// avc1.PPCCLL from the avcC box, as WebCodecs wants it.
const avcCodec = (avcC) => 'avc1.' + Array.from(avcC.subarray(1, 4)).map((x) => x.toString(16).padStart(2, '0')).join('');
async function decodeTrack(page, t, from = 0, count = t.sampleCount) {
  const sync = new Set(t.sync || []);
  const samples = [];
  for (let k = from; k < from + count; k++) samples.push({ key: t.sync ? sync.has(k) : true, data: Array.from(t.sample(k)) });
  return page.evaluate(([c, d, s]) => window.__decode(c, d, s), [avcCodec(t.entryChild('avcC')), Array.from(t.entryChild('avcC')), samples]);
}

// Add what a phone camera writes: a GPS position, make and model, and an XMP packet.
const mp4Box = (type, body) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); };
function plantVideoMetadata(clip) {
  const b = Buffer.from(clip);
  let i = 0, moov = null;
  while (i + 8 <= b.length) { const size = b.readUInt32BE(i); if (b.toString('latin1', i + 4, i + 8) === 'moov') moov = { start: i, end: i + size }; i += size; }
  assert(moov && moov.end === b.length, 'the fixture needs its moov box last');
  const tag = (type, text) => { const t = Buffer.from(text); const len = Buffer.alloc(4); len.writeUInt16BE(t.length, 0); len.writeUInt16BE(0x15C7, 2); return mp4Box(type, Buffer.concat([len, t])); };
  const udta = mp4Box('udta', Buffer.concat([tag('\xA9xyz', '+01.2897+103.8501/'), tag('\xA9mak', 'Google'), tag('\xA9mod', 'Pixel 9 Pro XL'),
    mp4Box('meta', Buffer.concat([Buffer.alloc(4), mp4Box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from('mdta'), Buffer.alloc(13)]))]))]));
  const newMoov = mp4Box('moov', Buffer.concat([b.subarray(moov.start + 8, moov.end), udta]));
  const xmp = mp4Box('uuid', Buffer.concat([Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex'), Buffer.from(XMP_PACKET)]));
  return Buffer.concat([b.subarray(0, moov.start), xmp, newMoov]);
}

test('video core: trim plans, keyframes, sound and write order (independent check)', async () => {
  const { ctx, page } = await newApp();
  // A 30 fps clip, keyframes every 10 frames, no B-frames.
  const P = (n, gop = 10, fps = 30) => Array.from({ length: n }, (_, i) => ({ ts: i / fps, dur: 1 / fps, key: i % gop === 0, seq: i }));
  // B-frames, decode order I0 P3 B1 B2 P6 B4 B5 I9 ... (presentation times in frames).
  const B = (() => {
    const order = [0, 3, 1, 2, 6, 4, 5, 9, 7, 8, 12, 10, 11];
    return order.map((f, i) => ({ ts: f / 30, dur: 1 / 30, key: f % 9 === 0, seq: i }));
  })();
  // An open GOP: the keyframe at frame 6 is followed in decode order by frames 4 and 5,
  // which need the frames before it.
  const OPEN = [0, 1, 2, 3, 6, 4, 5, 7, 8].map((f, i) => ({ ts: f / 30, dur: 1 / 30, key: f === 0 || f === 6, seq: i }));
  const r = await page.evaluate(([P10, B, OPEN]) => {
    const v = retouch.core.video;
    const keys = v.keyTimes(P10);
    return {
      keys: keys.length, keyEvery: v.keyEvery(keys), keyEvery1: v.keyEvery([2]), keyEveryOdd: v.keyEvery([0, 1, 2, 2.5, 3.5, 4.5]),
      noKeys: v.planTrim(P10.map((p) => ({ ...p, key: false })), 0, 1),
      kb: [v.keyBefore(keys, 0.5), v.keyBefore(keys, 1 / 3), v.keyBefore(keys, 1 / 3 - 1e-9), v.keyBefore(keys, 1 / 3 - 1e-4), v.keyBefore(keys, -1), v.keyBefore(keys, 99)],
      mid: v.planTrim(P10, 0.5, 1.5), exact: v.planTrim(P10, 1 / 3, 1), whole: v.planTrim(P10, 0, 2), tail: v.planTrim(P10, 1.9, 2),
      b: v.planTrim(B, 0.05, 0.2), bEnd: v.planTrim(B, 0, 4.5 / 30),
      open: v.planTrim(OPEN, 7 / 30, 9 / 30),
      snap: [v.snapToFrame([0, 0.1, 0.2], 0.3, 0.12), v.snapToFrame([0, 0.1, 0.2], 0.3, 0.29), v.snapToFrame([0, 0.1, 0.2], 0.3, 0.16)],
      inter: v.interleave([0, 0.1, 0.2], [0.05, 0.1, 0.3]),
    };
  }, [P(60), B, OPEN]);
  assert(r.keys === 6 && Math.abs(r.keyEvery - 1 / 3) < 1e-9 && r.keyEvery1 === null && r.keyEveryOdd === 1, 'keyframes ' + JSON.stringify([r.keys, r.keyEvery, r.keyEvery1, r.keyEveryOdd]));
  assert(r.noKeys === null, 'no keyframes, no plan');
  const t = (x) => Math.round(x * 30 * 1000) / 1000;   // seconds to frames
  assert(JSON.stringify(r.kb.map(t)) === JSON.stringify([10, 10, 10, 0, 0, 50]), 'keyBefore ' + JSON.stringify(r.kb.map(t)));
  // From 0.5 s (frame 15) to 1.5 s: starts at the keyframe at frame 10, ends after frame 44.
  assert(t(r.mid.from) === 10 && t(r.mid.to) === 45 && r.mid.moved && !r.mid.whole, 'mid ' + JSON.stringify(r.mid));
  assert(r.mid.keep.length === 35 && r.mid.keep[0] === 10 && r.mid.keep[34] === 44, 'mid keep ' + r.mid.keep);
  assert(!r.exact.moved && t(r.exact.from) === 10 && t(r.exact.to) === 30 && r.exact.keep.length === 20, 'start on a keyframe does not move ' + JSON.stringify(r.exact));
  assert(r.whole.whole && r.whole.keep.length === 60 && t(r.whole.to) === 60, 'whole ' + JSON.stringify(r.whole));
  assert(t(r.tail.from) === 50 && r.tail.keep.length === 10, 'tail ' + JSON.stringify(r.tail));
  // B-frames, from frame 1.5 to frame 6: starts at I0. Frame 6 is past the end, but B4
  // and B5 are shown and are built from P6, so P6 comes too and the clip runs to frame 7.
  assert(t(r.b.from) === 0 && JSON.stringify(r.b.keep) === JSON.stringify([0, 1, 2, 3, 4, 5, 6]) && t(r.b.to) === 7, 'B-frames ' + JSON.stringify(r.b));
  // End at 4.5 frames: frame 4 is the last shown, and it is built from P6, which comes too.
  assert(JSON.stringify(r.bEnd.keep) === JSON.stringify([0, 1, 2, 3, 4, 5]) && t(r.bEnd.to) === 7, 'B end ' + JSON.stringify(r.bEnd));
  // Open GOP: frames 4 and 5 sit after the keyframe at 6 in decode order but need what was cut.
  assert(t(r.open.from) === 6 && JSON.stringify(r.open.keep) === JSON.stringify([4, 7, 8]) && t(r.open.to) === 9, 'open GOP ' + JSON.stringify(r.open));
  assert(JSON.stringify(r.snap) === JSON.stringify([0.1, 0.3, 0.2]), 'snap ' + JSON.stringify(r.snap));
  assert(JSON.stringify(r.inter) === JSON.stringify([[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]]), 'interleave ' + JSON.stringify(r.inter));
  // Sound: 20 ms packets from -20 ms (the encoder's run-in) to 2 s.
  const A = Array.from({ length: 101 }, (_, i) => ({ ts: -0.02 + i * 0.02, dur: 0.02, key: true, seq: i }));
  const s = await page.evaluate(([A, P10]) => {
    const v = retouch.core.video;
    return { mid: v.planAudio(A, v.planTrim(P10, 0.5, 1.5)), whole: v.planAudio(A, v.planTrim(P10, 0, 1)), odd: v.planAudio(A, { from: 0.335, to: 0.5, whole: false }) };
  }, [A, P(60)]);
  // From 1/3 s to 1.5 s: the packet that sounds at 1/3 s (0.32 to 0.34) through the one ending at 1.5 s.
  assert(s.mid[0] === 17 && s.mid[s.mid.length - 1] === 75 && s.mid.length === 59, 'sound for a trim ' + [s.mid[0], s.mid[s.mid.length - 1], s.mid.length]);
  assert(s.whole[0] === 0 && s.whole.length === 51, 'untrimmed start keeps the run-in ' + [s.whole[0], s.whole.length]);
  assert(s.odd[0] === 17 && s.odd[s.odd.length - 1] === 25, 'a packet that ends after the start comes too ' + s.odd);
  const f = await page.evaluate(() => {
    const v = retouch.core.video;
    return {
      depth: ['avc1.640028', 'avc1.6E0033', 'avc1.7A0033', 'avc1.F40033', 'avc1.42001f', 'hvc1.1.6.L153.B0', 'hvc1.2.4.L153.B0', 'hev1.A2.4.L120.B0', 'hvc1.4.10.L120.9D.08', 'vp09.02.10.10.01.09.16.09', 'vp09.00.10.08', 'av01.0.04M.10', 'av01.0.08M.08', 'vp8', 'mp4a.40.2', ''].map(v.bitDepth),
      hdr: [v.hdrName({ transfer: 'pq' }), v.hdrName({ transfer: 'hlg' }), v.hdrName({ transfer: 'bt709' }), v.hdrName(null)],
      time: [0, 1.006, 59.994, 61.5, 3599.999, 3723.45, -2].map(v.fmtTime),
      isv: [['a.mp4', ''], ['A.MOV', ''], ['clip', 'video/mp4'], ['x.webm', ''], ['photo.jpg', 'image/jpeg'], ['x.mp4.jpg', ''], ['x.m4v', ''], ['x.3gp', 'video/3gpp']].map(([n, ty]) => v.isVideoFile(n, ty)),
      desc: v.describe({ codec: 'hevc', width: 3840, height: 2160, fps: 59.94, bitDepth: 10, colorSpace: { transfer: 'hlg' }, duration: 12.4, keyEvery: 1, audio: { codec: 'aac', sampleRate: 48000, channels: 2 } }),
      desc2: v.describe({ codec: 'avc', width: 1080, height: 1920, fps: 30, bitDepth: 8, colorSpace: { transfer: 'bt709' }, duration: 3, keyEvery: null, audio: null }),
      names: [v.codecName('avc'), v.codecName('aac'), v.codecName('xyz'), v.codecName(null)],
    };
  });
  assert(JSON.stringify(f.depth) === JSON.stringify([8, 10, 10, 10, 8, 8, 10, 10, null, 10, 8, 10, 8, 8, null, null]), 'bit depth ' + JSON.stringify(f.depth));
  assert(JSON.stringify(f.hdr) === JSON.stringify(['PQ', 'HLG', null, null]), 'hdr ' + JSON.stringify(f.hdr));
  assert(JSON.stringify(f.time) === JSON.stringify(['0:00.00', '0:01.01', '0:59.99', '1:01.50', '1:00:00.00', '1:02:03.45', '0:00.00']), 'fmtTime ' + JSON.stringify(f.time));
  assert(JSON.stringify(f.isv) === JSON.stringify([true, true, true, true, false, false, true, true]), 'isVideoFile ' + JSON.stringify(f.isv));
  assert(f.desc === 'HEVC 3840 × 2160 · 59.94 fps · 10-bit HDR HLG · 0:12.40 · sound AAC 48 kHz 2 ch · keyframe every 1.00 s', 'describe: ' + f.desc);
  assert(f.desc2 === 'H.264 1080 × 1920 · 30 fps · 8-bit SDR · 0:03.00 · no sound', 'describe: ' + f.desc2);
  assert(JSON.stringify(f.names) === JSON.stringify(['H.264', 'AAC', 'XYZ', 'unknown']), 'names ' + JSON.stringify(f.names));
  await ctx.close();
}, { core: true });

test('video core: edit history, MP4 dates and metadata finder, check report (independent check)', async () => {
  const { ctx, page } = await newApp();
  const h = await page.evaluate(() => {
    const c = new retouch.core.ClipHistory({ start: 0, end: 3, audio: true });
    const log = [];
    const snap = () => log.push([c.index, c.current.start, c.current.end, c.current.audio, c.current.label, c.canUndo, c.canRedo]);
    snap();
    c.push({ start: 1, end: 2.5 }, 'Trim'); snap();
    c.push({ audio: false }, 'Remove sound'); snap();
    c.undo(); snap();
    c.push({ start: 2 }, 'Trim'); snap();
    c.undo(); c.undo(); snap(); c.undo(); snap();
    c.redo(); c.redo(); c.redo(); snap();
    return { log, len: c.stack.length, orig: c.original };
  });
  assert(JSON.stringify(h.log) === JSON.stringify([
    [0, 0, 3, true, 'Original', false, false],
    [1, 1, 2.5, true, 'Trim', true, false],
    [2, 1, 2.5, false, 'Remove sound', true, false],
    [1, 1, 2.5, true, 'Trim', true, true],
    [2, 2, 2.5, true, 'Trim', true, false],
    [0, 0, 3, true, 'Original', false, true],
    [0, 0, 3, true, 'Original', false, true],
    [2, 2, 2.5, true, 'Trim', true, false]]), 'history ' + JSON.stringify(h.log));
  assert(h.len === 3 && h.orig.start === 0 && h.orig.end === 3, 'redo tail dropped, original kept');
  // A moov with a version 0 mvhd, a version 1 tkhd and a version 0 mdhd, all dated.
  const full = (type, v, body) => mp4Box(type, Buffer.concat([Buffer.from([v, 0, 0, 0]), body]));
  const dated = (v) => { const b = Buffer.alloc(v ? 16 : 8); for (let i = 0; i < b.length; i++) b[i] = 0x11 + i; return b; };
  const rest = (n) => Buffer.alloc(n, 0x7F);
  const moov = mp4Box('moov', Buffer.concat([full('mvhd', 0, Buffer.concat([dated(0), rest(88)])),
    mp4Box('trak', Buffer.concat([full('tkhd', 1, Buffer.concat([dated(1), rest(68)])), mp4Box('mdia', full('mdhd', 0, Buffer.concat([dated(0), rest(12)])))]))]));
  const m = await page.evaluate((arr) => {
    const v = retouch.core.video, b = new Uint8Array(arr);
    const before = v.findMeta(['ftyp', 'mdat', 'moov'], b);
    const n = v.zeroDates(b);
    const after = v.findMeta(['ftyp', 'mdat', 'moov'], b);
    const top = v.findMeta(['ftyp', 'uuid', 'mdat', 'moov'], b);
    return { before, n, after, top, bytes: Array.from(b) };
  }, Array.from(moov));
  assert(JSON.stringify(m.before) === JSON.stringify(['date in mvhd', 'date in tkhd', 'date in mdhd']), 'dates found ' + JSON.stringify(m.before));
  assert(m.n === 3 && m.after.length === 0, 'dates zeroed ' + m.n + ' ' + JSON.stringify(m.after));
  assert(JSON.stringify(m.top) === JSON.stringify(['top-level uuid']), 'top-level box ' + JSON.stringify(m.top));
  // Only the dates changed: the rest of every header is as it was.
  const got = Buffer.from(m.bytes);
  const want = Buffer.from(moov);
  for (const [at, n] of [[20, 8], [8 + 8 + 100 + 8 + 8 + 4, 16]]) want.fill(0, at, at + n);
  const mdhdAt = want.indexOf(Buffer.from('mdhd')) + 8; want.fill(0, mdhdAt, mdhdAt + 8);
  assert(got.equals(want), 'zeroDates changed more than the dates');
  // Planted metadata in a real clip is found by the app's finder too.
  await page.evaluate(VIDEO_INIT);
  const clip = plantVideoMetadata(Buffer.from(await page.evaluate(() => window.__makeClip({ frames: 6, audio: false }))));
  const found = await page.evaluate((arr) => {
    const v = retouch.core.video, b = new Uint8Array(arr), top = v.boxes(b);
    const mv = top.find((x) => x.type === 'moov');
    return v.findMeta(top.map((x) => x.type), b.subarray(mv.start, mv.end));
  }, Array.from(clip));
  for (const w of ['top-level uuid', 'udta box', 'GPS location', 'date in mvhd']) assert(found.includes(w), 'finder missed ' + w + ': ' + JSON.stringify(found));
  // The report.
  const rep = await page.evaluate(() => {
    const v = retouch.core.video;
    const res = { 'h264-1080p30': { supported: true, ran: { frames: 30, fps: 61.4 }, error: null }, aac: { supported: false, ran: null, error: null },
      opus: { supported: true, ran: null, error: 'EncodingError: boom' }, 'aac-dec': { supported: true, ran: null, error: null },
      'hevc-dec': { supported: false, ran: null, error: 'TypeError: bad' }, 'h264-1080p60': { supported: true, ran: { seconds: 1, chunks: 47 }, error: null } };
    return { text: v.report(res, { version: '9.9.9', when: '29/10/26 · 1630 hrs', browser: 'Chrome 141, Android 15, Pixel 9 Pro XL', hdrScreen: true, clip: null }),
      verdicts: Object.values(res).map(v.verdict), ids: v.CHECKS.map((c) => c.id), labels: v.CHECKS.map((c) => c.label), configs: v.CHECKS.map((c) => c.config) };
  });
  assert(rep.text === ['retouch 9.9.9 video check, 29/10/26 · 1630 hrs', 'Browser: Chrome 141, Android 15, Pixel 9 Pro XL', 'HDR screen: yes',
    'PASS H.264 encode 1080p 30 fps: works, 30 frames at 61 fps', 'PASS H.264 encode 1080p 60 fps: works, 1 s of tone in 47 packets',
    'FAIL AAC encode 48 kHz stereo: not supported', 'WATCH Opus encode 48 kHz stereo: says yes, but the trial failed: EncodingError: boom',
    'FAIL HEVC decode 4K 60 fps: not supported (TypeError: bad)', 'PASS AAC decode 48 kHz stereo: supported', 'Open clip: none'].join('\n'), 'report:\n' + rep.text);
  assert(JSON.stringify(rep.verdicts) === JSON.stringify(['pass', 'fail', 'watch', 'pass', 'fail', 'pass']), 'verdicts ' + rep.verdicts);
  // What the brief asks the check to cover: H.264 at the Pixel's sizes and rates, and AAC.
  const need = { 'H.264 encode 1080p 30 fps': [1920, 1080, 30], 'H.264 encode 1080p 60 fps': [1920, 1080, 60], 'H.264 encode 4K 30 fps': [3840, 2160, 30], 'H.264 encode 4K 60 fps': [3840, 2160, 60] };
  for (const [label, [w, hh, fr]] of Object.entries(need)) {
    const c = rep.configs[rep.labels.indexOf(label)];
    assert(c && /^avc1\.64/.test(c.codec) && c.width === w && c.height === hh && c.framerate === fr, label + ': ' + JSON.stringify(c));
  }
  const aac = rep.configs[rep.ids.indexOf('aac')];
  assert(aac && aac.codec === 'mp4a.40.2' && aac.sampleRate === 48000 && aac.numberOfChannels === 2, 'AAC check ' + JSON.stringify(aac));
  // H.264 levels: 4.0, 4.2, 5.1, 5.2 (the last two hex digits).
  assert(JSON.stringify(rep.configs.slice(0, 4).map((c) => c.codec.slice(-2).toUpperCase())) === JSON.stringify(['28', '2A', '33', '34']), 'H.264 levels');
  await ctx.close();
}, { core: true });

test('video check: opens from the empty screen, runs every check, copies a plain report', async () => {
  const { ctx, page } = await newApp();
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  assert(await page.isVisible('#btn-check-empty'), 'Video check button on the empty screen');
  await page.click('#btn-check-empty');
  assert((await page.textContent('#strip-code')) === 'Video check', 'no edit count with nothing open: ' + await page.textContent('#strip-code'));
  await page.waitForFunction(() => retouch.app.check && retouch.app.check.done, null, { timeout: 120000 });
  const rows = await page.$$eval('#vcheck-list .check-row', (rs) => rs.map((r) => [r.dataset.check, r.querySelector('.v').className, r.textContent]));
  const ids = await page.evaluate(() => retouch.core.video.CHECKS.map((c) => c.id));
  assert(rows.length === ids.length && rows.every((r, i) => r[0] === ids[i]), 'one row per check');
  // Each verdict agrees with what WebCodecs itself says here.
  const direct = await page.evaluate(async () => {
    const out = {};
    for (const c of retouch.core.video.CHECKS) {
      const api = { 'video-encode': VideoEncoder, 'audio-encode': AudioEncoder, 'video-decode': VideoDecoder, 'audio-decode': AudioDecoder }[c.kind];
      out[c.id] = (await api.isConfigSupported(c.config)).supported;
    }
    return out;
  });
  for (const [id, cls, text] of rows) {
    if (direct[id]) assert(/pass|watch/.test(cls) && /works|supported|says yes/.test(text), id + ' says yes here, row: ' + text);
    else assert(/fail/.test(cls) && /not supported/.test(text), id + ' says no here, row: ' + text);
  }
  assert(/works, 30 frames at \d+ fps/.test(rows[0][2]), 'H.264 1080p 30 trial ran: ' + rows[0][2]);
  await page.click('#vcheck-copy');
  await page.waitForSelector('.notice[data-id="vcheck"]');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const shown = await page.textContent('#vcheck-report');
  assert(clip === shown && /^retouch \d+\.\d+\.\d+ video check, \d\d\/\d\d\/\d\d/.test(clip), 'copied report: ' + clip.slice(0, 80));
  for (const l of ['H.264 encode 1080p 30 fps', 'H.264 encode 1080p 60 fps', 'H.264 encode 4K 30 fps', 'H.264 encode 4K 60 fps', 'AAC encode 48 kHz stereo', 'HDR screen:', 'Open clip: none']) assert(clip.includes(l), 'report lacks ' + l);
  assert(!clip.includes('—'), 'no em dashes');
  const strip = await page.textContent('#vcheck-out');
  assert(/working/.test(strip), 'status strip: ' + strip);
  // With a clip open, the report names it.
  await page.click('.sheet-panel[data-tool="vcheck"] [data-cancel]');
  await loadVideo(page, await makeClip(page));
  await page.click('[data-open-tool="vcheck"]');
  const rep2 = await page.textContent('#vcheck-report');
  assert(/Open clip: H\.264 320 × 240 · 30 fps · 8-bit SDR · 0:03\.00 · sound Opus 48 kHz 1 ch · keyframe every 1\.00 s \(avc1\./.test(rep2), 'clip line: ' + rep2.split('\n').pop());
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('video: opens from the picker, shows its facts, plays; photo tools give way to video tools', async () => {
  const { ctx, page } = await newApp();
  await load(page, gradient());
  await loadVideo(page, await makeClip(page));
  const r = await page.evaluate(() => {
    const v = retouch.app.video.clips[0];
    return { edits: retouch.app.edits, info: v.info, frames: v.vpk.length, keys: v.keys, audio: v.apk.length, first: v.first, end: v.end, mode: document.body.dataset.mode,
      toolsShown: Array.from(document.querySelectorAll('.tool')).filter((b) => b.offsetParent).map((b) => b.dataset.openTool),
      canvas: getComputedStyle(document.querySelector('#view')).display, player: getComputedStyle(document.querySelector('#player')).display };
  });
  assert(r.edits === null, 'the photo is closed');
  assert(r.mode === 'video' && r.canvas === 'none' && r.player === 'block', 'video mode ' + JSON.stringify([r.mode, r.canvas, r.player]));
  assert(JSON.stringify(r.toolsShown) === JSON.stringify(['trim', 'cut', 'sound', 'vcheck']), 'tools ' + r.toolsShown);
  assert(r.frames === 90 && r.keys.length === 3 && Math.abs(r.keys[1] - 1) < 1e-6 && r.audio >= 149, 'index ' + JSON.stringify([r.frames, r.keys, r.audio]));
  assert(Math.abs(r.first) < 1e-6 && Math.abs(r.end - 3) < 1e-3, 'length ' + [r.first, r.end]);
  assert(r.info.width === 320 && r.info.height === 240 && Math.abs(r.info.fps - 30) < 0.01 && r.info.codec === 'avc' && r.info.audio.codec === 'opus', 'facts ' + JSON.stringify(r.info));
  assert((await page.textContent('#dims')) === '320 × 240 · 0:03.00', 'top bar: ' + await page.textContent('#dims'));
  assert(/^0 edit ▸ /.test(await page.textContent('#top-code')), 'edit counter');
  await page.waitForFunction(() => retouch.player.readyState >= 2, null, { timeout: 10000 });
  await page.click('#play');
  await page.waitForFunction(() => retouch.player.currentTime > 0.3, null, { timeout: 10000 });
  assert(await page.evaluate(() => document.querySelector('#play').hasAttribute('data-playing')), 'play button shows pause');
  await page.click('#play');
  assert(/^0:00\.\d\d \/ 0:03\.00$/.test(await page.textContent('#clock')), 'clock ' + await page.textContent('#clock'));
  // A photo opened after a video closes the video.
  await load(page, gradient());
  assert(await page.evaluate(() => retouch.app.video === null && !document.body.dataset.mode && !retouch.player.getAttribute('src')), 'video closed for the photo');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('video: trim between keyframes copies the packets unchanged; frames, length and sound check out', async () => {
  const { ctx, page } = await newApp();
  const src = await makeClip(page);
  await loadVideo(page, src);
  await page.waitForFunction(() => retouch.player.readyState >= 1);
  await page.click('[data-open-tool="trim"]');
  assert(await page.isVisible('.hint[data-for="trim"]'), 'the keyframe caption shows');
  // Playhead to 1.2 s, Start here: it snaps back to the keyframe at 1.0 s and says so.
  await page.evaluate(() => { retouch.player.currentTime = 1.2; });
  await page.waitForFunction(() => Math.abs(retouch.player.currentTime - 1.2) < 0.01);
  await page.click('#trim-set-start');
  const note = await page.textContent('#trim-note');
  assert(/Start moved back to 0:01\.00, the keyframe before 0:01\.20/.test(note) && await page.isVisible('#trim-note'), 'note: ' + note);
  // Playhead on frame 74 (2.467 s), End here: the end goes to the edge after it, 2.5 s.
  await page.evaluate(() => { retouch.player.currentTime = 74 / 30 + 0.005; });
  await page.waitForFunction(() => Math.abs(retouch.player.currentTime - 74 / 30 - 0.005) < 0.01);
  await page.click('#trim-set-end');
  const cells = [await page.textContent('#trim-from'), await page.textContent('#trim-to'), await page.textContent('#trim-len')];
  assert(JSON.stringify(cells) === JSON.stringify(['0:01.00', '0:02.50', '0:01.50']), 'cells ' + cells);
  await applyTool(page, 'trim');
  assert((await page.textContent('#dims')) === '320 × 240 · 0:01.50' && /^1 edit ▸ /.test(await page.textContent('#top-code')), 'after trim: ' + await page.textContent('#dims'));
  const t0 = Date.now();
  const { bytes, name } = await exportVideo(page);
  assert(/^retouch-\d{6}-\d{4}\.mp4$/.test(name), 'file name ' + name);
  const n = await page.textContent('.notice[data-id="export"]');
  assert(/Saved retouch-.*\.mp4, 0:01\.50, 320 × 240, .*Copied without re-encoding\. Metadata stripped: no location, dates or camera details\./.test(n), 'confirmation: ' + n);
  const a = parseMp4(src), b = parseMp4(bytes);
  const av = vtrack(a), bv = vtrack(b);
  assert(bv.sampleCount === 45, 'frames ' + bv.sampleCount);
  near(seconds(bv), 1.5, 0.002, 'video length');
  assert(JSON.stringify(bv.sync) === JSON.stringify([0, 30]), 'keyframes in the trimmed clip ' + JSON.stringify(bv.sync));
  // Lossless: every kept frame is the same bytes as frame 30 onwards of the source.
  for (let k = 0; k < 45; k++) assert(bv.sample(k).equals(av.sample(30 + k)), 'frame ' + k + ' differs from source frame ' + (30 + k));
  assert(bv.entryChild('avcC').equals(av.entryChild('avcC')), 'codec setup copied as it was');
  const bs = strack(b), as_ = strack(a);
  assert(bs && bs.codec === 'Opus', 'sound track kept');
  near(seconds(bs), 1.5, 0.025, 'sound length');
  const firstSound = as_.offsets.findIndex((o, k) => as_.sample(k).equals(bs.sample(0)));
  assert(firstSound === 50, 'sound starts with the packet that plays at 1.0 s, source packet ' + firstSound);
  for (let k = 0; k < bs.sampleCount; k++) assert(bs.sample(k).equals(as_.sample(firstSound + k)), 'sound packet ' + k + ' changed');
  // The first frame decodes, and it is source frame 30 (red 80); the last is frame 74 (red 168).
  const cols = await decodeTrack(page, bv);
  assert(cols.length === 45 && typeof cols[0] !== 'string', 'all frames decode: ' + cols.length + ' ' + cols[0]);
  near(cols[0][0], 80, 6, 'first frame is source frame 30');
  near(cols[44][0], 168, 6, 'last frame is source frame 74');
  assert(findVideoMetadata(bytes).length === 0, 'metadata: ' + findVideoMetadata(bytes));
  assert(!(await page.evaluate(() => window.__csp.length)), 'CSP violations: ' + await page.evaluate(() => window.__csp));
  console.log('      45 frames copied in ' + (Date.now() - t0) + ' ms');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
}, { core: true });

test('video: remove sound keeps every frame byte for byte and leaves no sound track', async () => {
  const { ctx, page } = await newApp();
  const src = await makeClip(page);
  await loadVideo(page, src);
  await page.click('[data-open-tool="sound"]');
  assert((await page.textContent('#sound-what')) === 'Opus · 48 kHz · 1 ch', 'sound facts ' + await page.textContent('#sound-what'));
  await page.click('[data-sound="remove"]');
  assert(await page.evaluate(() => retouch.player.muted), 'the preview is silent');
  assert((await page.textContent('#sound-result')) === 'picture only', 'result cell');
  await applyTool(page, 'sound');
  assert(/0:03\.00 · no sound$/.test(await page.textContent('#dims')), 'top bar ' + await page.textContent('#dims'));
  const { bytes } = await exportVideo(page);
  const b = parseMp4(bytes), a = parseMp4(src);
  assert(b.tracks.length === 1 && b.tracks[0].handler === 'vide' && !strack(b), 'tracks ' + b.tracks.map((t) => t.handler));
  const av = vtrack(a), bv = vtrack(b);
  assert(bv.sampleCount === 90, 'frames ' + bv.sampleCount);
  near(seconds(bv), 3, 0.002, 'length');
  for (let k = 0; k < 90; k++) assert(bv.sample(k).equals(av.sample(k)), 'frame ' + k + ' changed');
  assert(JSON.stringify(bv.sync) === JSON.stringify([0, 30, 60]), 'keyframes ' + bv.sync);
  assert(!bytes.includes(Buffer.from('Opus')) && !bytes.includes(Buffer.from('soun')), 'no trace of the sound track');
  assert(findVideoMetadata(bytes).length === 0, 'metadata: ' + findVideoMetadata(bytes));
  // A clip with no sound: the Sound tool is off, and export works.
  await loadVideo(page, await makeClip(page, { audio: false, frames: 30 }), 'silent.mp4');
  assert(await page.isDisabled('[data-open-tool="sound"]'), 'Sound tool off for a silent clip');
  const silent = parseMp4((await exportVideo(page)).bytes);
  assert(silent.tracks.length === 1 && vtrack(silent).sampleCount === 30, 'silent export');
  assert((await page.evaluate(() => retouch.tools.vexport.result.where)) === 'storage', 'written to private storage');
  // Without private storage the file is built in memory, the same bytes.
  await page.evaluate(() => { navigator.storage.getDirectory = () => Promise.reject(new Error('no storage here')); });
  const mem = (await exportVideo(page)).bytes;
  assert((await page.evaluate(() => retouch.tools.vexport.result.where)) === 'memory', 'memory fallback used');
  const mv = vtrack(parseMp4(mem));
  assert(mv.sampleCount === 30 && findVideoMetadata(mem).length === 0, 'memory export');
  for (let k = 0; k < 30; k++) assert(mv.sample(k).equals(vtrack(silent).sample(k)), 'memory export frame ' + k + ' differs');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('video: location, camera, XMP and dates never reach the export', async () => {
  const { ctx, page } = await newApp();
  const src = plantVideoMetadata(await makeClip(page, { frames: 30 }));
  const before = findVideoMetadata(src);
  for (const w of ['GPS location (\xA9xyz)', 'camera make', 'camera model', 'XMP packet', 'top-level uuid box', 'udta box in moov', 'date in mvhd']) assert(before.includes(w), 'fixture should carry ' + w + ': ' + before);
  await loadVideo(page, src);
  const { bytes } = await exportVideo(page);
  assert(findVideoMetadata(bytes).length === 0, 'export carries ' + findVideoMetadata(bytes));
  const m = parseMp4(bytes);
  assert(m.mvhd.ctime === 0 && m.mvhd.mtime === 0 && m.tracks.every((t) => !t.tkhd.ctime && !t.mdhd.ctime), 'dates zeroed');
  assert(JSON.stringify(m.top) === JSON.stringify(['ftyp', 'mdat', 'moov']), 'boxes ' + m.top);
  assert(vtrack(m).sampleCount === 30 && strack(m), 'picture and sound still there');
  assert((await page.textContent('#vexport-meta').catch(() => '')) !== null, 'meta cell');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('video: HDR colour tags and rotation come through the copy', async () => {
  const { ctx, page } = await newApp();
  // A phone records portrait video as landscape frames with a 90 degree turn in the file.
  const hlg = { primaries: 'bt2020', transfer: 'hlg', matrix: 'bt2020-ncl', fullRange: false };
  const src = await makeClip(page, { rotation: 90, colorSpace: hlg, frames: 60 });
  await loadVideo(page, src);
  const info = await page.evaluate(() => retouch.app.video.clips[0].info);
  assert(info.width === 240 && info.height === 320, 'displayed upright ' + info.width + ' x ' + info.height);
  assert(info.colorSpace.transfer === 'hlg' && info.colorSpace.primaries === 'bt2020', 'colour ' + JSON.stringify(info.colorSpace));
  assert(/8-bit HDR HLG/.test(await page.evaluate(() => retouch.core.video.describe(retouch.app.video.clips[0].info))), 'facts say HDR HLG');
  await page.click('[data-open-tool="trim"]');
  await page.evaluate(() => { retouch.tools.trim.setStart(1.1, false); retouch.tools.trim.setEnd(1.8); });
  await applyTool(page, 'trim');
  const { bytes } = await exportVideo(page);
  const s = vtrack(parseMp4(src)), v = vtrack(parseMp4(bytes));
  // nclx codes: primaries 9 = BT.2020, transfer 18 = HLG, matrix 9 = BT.2020 non-constant.
  assert(JSON.stringify(v.colr) === JSON.stringify({ primaries: 9, transfer: 18, matrix: 9, fullRange: false }), 'colr ' + JSON.stringify(v.colr));
  assert(JSON.stringify(v.colr) === JSON.stringify(s.colr), 'colr as recorded');
  // 90 degrees clockwise: a = 0, b = 1, c = -1, d = 0 in 16.16.
  assert(JSON.stringify(v.matrix.slice(0, 5)) === JSON.stringify([0, 65536, 0, -65536, 0]), 'rotation matrix ' + v.matrix);
  assert(v.codedWidth === 320 && v.codedHeight === 240 && v.sampleCount === 24, 'frames as stored ' + [v.codedWidth, v.codedHeight, v.sampleCount]);
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('video: drag the trim handles; undo, redo, edit counter, hold for the original', async () => {
  const { ctx, page } = await newApp();
  await loadVideo(page, await makeClip(page, { frames: 150, gop: 15 }));
  await page.waitForFunction(() => retouch.player.readyState >= 1);
  await page.click('[data-open-tool="trim"]');
  const line = await page.locator('#trim-line').boundingBox();
  const drag = async (sel, toFrac) => {
    const h = await page.locator(sel).boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(line.x + toFrac * line.width, h.y + h.height / 2, { steps: 6 });
    await page.mouse.up();
  };
  await drag('#trim-start', 0.33);        // 1.65 s: snaps back to the keyframe at 1.5 s
  await drag('#trim-end', 0.71);          // 3.55 s: the nearest frame edge
  const d = await page.evaluate(() => retouch.tools.trim.d);
  near(d.start, 1.5, 1e-6, 'start on a keyframe');
  assert(Math.abs(d.end * 30 - Math.round(d.end * 30)) < 1e-3 && Math.abs(d.end - 3.55) < 0.05, 'end on a frame edge: ' + d.end);
  // The handle cannot pass the end.
  await drag('#trim-start', 0.99);
  const d2 = await page.evaluate(() => retouch.tools.trim.d);
  assert(d2.start < d2.end && Math.abs(d2.start * 2 - Math.round(d2.start * 2)) < 1e-6, 'start stays a keyframe before the end: ' + JSON.stringify(d2));
  await page.click('#trim-reset');
  await drag('#trim-start', 0.33);
  await drag('#trim-end', 0.71);
  // Cancel keeps nothing.
  await page.click('.sheet-panel[data-tool="trim"] [data-cancel]');
  assert((await page.evaluate(() => retouch.app.video.history.index)) === 0, 'cancel adds no step');
  await page.click('[data-open-tool="trim"]');
  await drag('#trim-start', 0.33);
  await drag('#trim-end', 0.71);
  await applyTool(page, 'trim');
  await page.click('[data-open-tool="sound"]');
  await page.click('[data-sound="remove"]');
  await applyTool(page, 'sound');
  const top = () => page.textContent('#top-code');
  assert(/^2 edits ▸ /.test(await top()), 'two edits: ' + await top());
  // Hold: the original, with sound, from its start.
  await page.evaluate(() => { retouch.player.currentTime = 0.2; });
  const hold = await page.locator('#hold-main').isVisible();
  assert(!hold, 'the photo hold button stays hidden for video');
  await page.click('#btn-export');
  const hb = await page.locator('.sheet-panel[data-tool="vexport"] [data-hold]').boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  const held = await page.evaluate(() => ({ muted: retouch.player.muted, t: retouch.player.currentTime }));
  await page.mouse.up();
  const after = await page.evaluate(() => ({ muted: retouch.player.muted, t: retouch.player.currentTime }));
  assert(!held.muted && after.muted && after.t >= 1.5 - 0.01, 'hold plays the original: ' + JSON.stringify([held, after]));
  await page.click('.sheet-panel[data-tool="vexport"] [data-cancel]');
  await page.click('#btn-undo');
  assert(/^1 edit ▸ /.test(await top()) && !/no sound/.test(await page.textContent('#dims')), 'undo the sound: ' + await page.textContent('#dims'));
  await page.click('#btn-undo');
  assert(/^0 edit ▸ /.test(await top()) && (await page.textContent('#dims')) === '320 × 240 · 0:05.00', 'undo the trim: ' + await page.textContent('#dims'));
  assert(await page.isDisabled('#btn-undo') && !(await page.isDisabled('#btn-redo')), 'undo and redo buttons');
  await page.click('#btn-redo'); await page.click('#btn-redo');
  assert(/^2 edits ▸ /.test(await top()) && /no sound$/.test(await page.textContent('#dims')), 'redo both');
  const m = parseMp4((await exportVideo(page)).bytes);
  assert(m.tracks.length === 1 && vtrack(m).sampleCount === Math.round((d.end - 1.5) * 30), 'export follows the recipe: ' + vtrack(m).sampleCount);
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('video: a broken or unknown video says so plainly and keeps what was open', async () => {
  const { ctx, page } = await newApp();
  await loadVideo(page, await makeClip(page, { frames: 30 }));
  const junk = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(3000, 9)]);
  await page.setInputFiles('#file', { name: 'broken.mp4', mimeType: 'video/mp4', buffer: junk });
  await page.waitForSelector('.notice.fail[data-id="open"]');
  const t = await page.textContent('.notice.fail[data-id="open"]');
  assert(/This video could not be opened: .*retouch opens MP4, MOV and WebM videos\./.test(t), 'message: ' + t);
  assert(await page.evaluate(() => retouch.app.video && retouch.app.video.clips[0].vpk.length === 30), 'the open clip stays');
  await page.setInputFiles('#file', { name: 'notes.mov', mimeType: 'video/quicktime', buffer: Buffer.from('not a video at all') });
  await page.waitForFunction(() => /could not be opened/.test(document.querySelector('.notice[data-id="open"]')?.textContent || '') && retouch.app.busyCount === 0);
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('video: phone layout, tap targets at least 44 px in every video sheet', async () => {
  const { ctx, page } = await newApp();
  const small = () => page.$$eval('button, input, select, a', (els) => els.filter((e) => {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || e.closest('[hidden]') || getComputedStyle(e).visibility === 'hidden' || getComputedStyle(e).display === 'none') return false;
    return r.width < 43.5 || r.height < 43.5;
  }).map((e) => (e.id || e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)));
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await loadVideo(page, await makeClip(page, { frames: 30 }));
  let s = await small(); assert(!s.length && await wide(), 'video view: ' + s);
  for (const t of ['trim', 'cut', 'sound', 'vcheck']) {
    await page.click('[data-open-tool="' + t + '"]');
    s = await small(); assert(!s.length && await wide(), t + ': ' + s);
    const stage = await page.locator('#stage').boundingBox();
    assert(stage.height > (t === 'vcheck' ? 150 : 400), t + ': video area ' + stage.height + ' px');
    await page.click('.sheet-panel[data-tool="' + t + '"] [data-cancel]');
  }
  await page.click('#btn-export');
  await page.waitForFunction(() => !document.querySelector('#vexport-download').disabled);
  s = await small(); assert(!s.length && await wide(), 'video export: ' + s);
  await ctx.close();
});

test('service worker: a video shared from another app opens, offline too', async () => {
  const { ctx, page } = await newApp({ sw: true });
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
  const clip = await makeClip(page, { frames: 30 });
  const cached = await page.evaluate(async () => !!(await caches.match('vendor/mediabunny/mediabunny.js')));
  assert(cached, 'Mediabunny cached for offline');
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.retouch && window.retouch.app);
  for (const field of ['media', 'image']) {     // 'image' is what an installed app with the old manifest sends
    await page.evaluate(([arr, field]) => {
      const f = new File([new Uint8Array(arr)], 'PXL_shared.mp4', { type: 'video/mp4' });
      const form = document.createElement('form');
      form.method = 'POST'; form.action = 'share-target'; form.enctype = 'multipart/form-data';
      const input = document.createElement('input'); input.type = 'file'; input.name = field;
      const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files;
      form.append(input); document.body.append(form); form.submit();
    }, [Array.from(clip), field]);
    await page.waitForURL(/retouch\.html$/);
    await page.waitForFunction(() => window.retouch && window.retouch.app.video && window.retouch.app.busyCount === 0, null, { timeout: 15000 });
    assert(await page.evaluate(() => retouch.app.video.clips[0].vpk.length === 30 && retouch.app.fileName === 'PXL_shared.mp4'), field + ': shared video opened');
  }
  const m = parseMp4((await exportVideo(page)).bytes);
  assert(vtrack(m).sampleCount === 30, 'exports offline');
  await ctx.setOffline(false);
  await ctx.close();
});

/* ---------- Video phase V2: cut and join ---------- */

// Put the player at t in the piece on screen and wait for it to get there.
async function seekPlayer(page, t) {
  await page.waitForFunction(() => retouch.pl.seek === null && retouch.player.readyState >= 1);
  await page.evaluate((t) => { retouch.player.currentTime = t; }, t);
  await page.waitForFunction((t) => Math.abs(retouch.player.currentTime - t) < 0.01, t);
}
// Add videos through the Cut sheet's Add tile (the sheet must be open).
async function addClips(page, list) {
  const before = await page.evaluate(() => retouch.app.video.clips.length);
  await page.setInputFiles('#file-add', list.map((buffer, i) => ({ name: 'PXL_add_' + i + '.mp4', mimeType: 'video/mp4', buffer })));
  await page.waitForFunction((n) => retouch.app.video.clips.length === n && retouch.app.busyCount === 0, before + list.length);
}
const pieces = (page, draft = true) => page.evaluate((draft) => (draft ? retouch.tools.cut.d : retouch.app.video.history.current).pieces
  .map((p) => [p.clip, Math.round(p.start * 1000) / 1000, Math.round(p.end * 1000) / 1000]), draft);
// Start a re-encode in the export sheet, wait for it, download, return the bytes.
async function reencodeVideo(page) {
  await page.click('#btn-export');
  assert(await page.isVisible('#vexport-start') && !(await page.isVisible('#vexport-download')), 'a re-encode waits for a tap');
  assert((await page.textContent('#vexport-size')) === 'not started', 'nothing done before the tap');
  await page.click('#vexport-start');
  await page.waitForFunction(() => !document.querySelector('#vexport-download').disabled || /Fail/.test(document.querySelector('#vexport-meta').textContent), null, { timeout: 60000 });
  const meta = await page.textContent('#vexport-meta');
  assert(!/Fail/.test(meta), 'export failed: ' + meta);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#vexport-download')]);
  const bytes = fs.readFileSync(await dl.path());
  const note = await page.textContent('#vexport-note');
  await page.click('.sheet-panel[data-tool="vexport"] [data-cancel]');
  return { bytes, note };
}
const probe = (page, bytes, o) => page.evaluate(([arr, o]) => window.__probe(arr, o), [Array.from(bytes), o]);

test('video core: frame rates, join and sound checks, frame grid, sound at a join, resampling, splits (independent check)', async () => {
  const { ctx, page } = await newApp();
  const r = await page.evaluate(() => {
    const v = retouch.core.video;
    const a = { name: 'clip 1', codec: 'avc', mp4: true, width: 1920, height: 1080, rotation: 0, rate: 30, hdr: null, setup: 'x' };
    const why = (...bs) => v.joinCheck([a, ...bs.map((b, i) => ({ ...a, name: 'clip ' + (i + 2), ...b }))]);
    const s = { name: 'clip 1', codec: 'aac', mp4: true, setup: 'aac 48000 2', label: 'AAC · 48 kHz · 2 ch' };
    const snd = (keep, ...bs) => v.soundCheck([s, ...bs.map((b, i) => ({ ...s, name: 'clip ' + (i + 2), ...b }))], keep);
    // A 1 kHz tone at 44.1 kHz, resampled to 48 kHz in one go and in chunks of 441.
    const n = 4410, tone = new Float32Array(n);
    for (let i = 0; i < n; i++) tone[i] = Math.sin(2 * Math.PI * 1000 * i / 44100);
    const whole = v.reshaper(44100, 48000, 1)([tone])[0];
    const sh = v.reshaper(44100, 48000, 1), parts = [];
    for (let i = 0; i < n; i += 441) parts.push(...sh([tone.subarray(i, i + 441)])[0]);
    let worst = 0;
    for (let k = 0; k < whole.length; k++) worst = Math.max(worst, Math.abs(whole[k] - Math.sin(2 * Math.PI * 1000 * k / 48000)));
    const two = v.reshaper(48000, 48000, 2)([new Float32Array([0.5, -0.25])]);
    const one = v.reshaper(48000, 48000, 1)([new Float32Array([0.5, 0.1]), new Float32Array([-0.1, 0.3])]);
    const down = v.reshaper(48000, 24000, 1)([new Float32Array([0, 1, 2, 3, 4, 5, 6, 7])])[0];
    const ps = [{ clip: 0, start: 1, end: 2.5 }, { clip: 1, start: 0, end: 1 }];
    return {
      rates: [30, 29.97, 30.04, 24.93, 59.94, 60.2, 27.333, 23.98, 120, 26, 31].map(v.standardRate),
      why: [why(), why({ codec: 'hevc' }), why({ width: 1080, height: 1920 }), why({ height: 1440 }), why({ rate: 25 }), why({ hdr: 'HLG' }), why({ setup: 'y' }), why({ rotation: 90 }),
        v.joinCheck([{ ...a, mp4: false, codec: 'vp9' }]), why({ rate: 60 }, { width: 640, height: 480, rate: 25 })],
      snd: [snd(true), snd(false), snd(true, {}), snd(true, { codec: null }), snd(true, { setup: 'opus', codec: 'opus', label: 'Opus · 48 kHz · 1 ch' }), snd(true, { setup: 'aac 44100 2', label: 'AAC · 44 kHz · 2 ch' }),
        v.soundCheck([{ name: 'clip 1', codec: null }], true), v.soundCheck([{ name: 'clip 1', codec: null }, { ...s, name: 'clip 2' }], true), v.soundCheck([{ ...s, mp4: false, codec: 'vorbis' }], true)],
      offsets: v.joinOffsets([{ from: 1, to: 2.5 }, { from: 0, to: 1.2 }, { from: 3, to: 3.5 }]),
      grid: v.frameGrid([{ start: 1, end: 2.5 }, { start: 0, end: 1.5 }, { start: 2, end: 2.00001 }], 30),
      grid25: v.frameGrid([{ start: 0, end: 1.5 }], 25).frames,
      place: v.placeSound([{ ts: 0, dur: 0.02 }, { ts: 0.02, dur: 0.02 }, { ts: 0.035, dur: 0.02 }, { ts: 0.045, dur: 0.02 }, { ts: 0.06, dur: 0.02 }, { ts: 0.1, dur: 0.02 }]),
      lens: [whole.length, parts.length], same: whole.every((x, k) => Math.abs(x - parts[k]) < 1e-6), worst,
      two: two.map((p) => Array.from(p)), one: Array.from(one[0]).map((x) => Math.round(x * 1000) / 1000), down: Array.from(down),
      bitrate: [v.encodeBitrate(1920, 1080, 30), v.encodeBitrate(3840, 2160, 60), v.encodeBitrate(320, 240, 30)],
      at: [0, 1.4, 1.5, 2.2, 2.5, 9].map((t) => v.pieceAt(ps, t)), of: [v.timeOf(ps, 0, 1), v.timeOf(ps, 0, 2), v.timeOf(ps, 1, 0.5)],
      split: [v.split([{ clip: 0, start: 0, end: 3 }, { clip: 1, start: 0, end: 2 }], 0, [0, 1, 2], 1.2), v.split([{ clip: 0, start: 0, end: 3 }, { clip: 1, start: 0, end: 2 }], 1, [0, 1], 1.6), v.split([{ clip: 1, start: 0, end: 2 }], 0, [0, 1], 0.6),
        v.split([{ clip: 0, start: 1, end: 3 }], 0, [0, 1, 2], 1), v.split([{ clip: 0, start: 0, end: 2 }], 0, [0, 1, 2], 2.5), v.split([{ clip: 0, start: 0, end: 3 }], 0, [0, 1, 2], 2)],
      splitAt: [v.splitAt([{ clip: 0, start: 0, end: 3 }, { clip: 1, start: 0, end: 2 }], 0, 1.3), v.splitAt([{ clip: 0, start: 1, end: 3 }], 0, 1), v.splitAt([{ clip: 0, start: 1, end: 3 }], 0, 3)],
      exact: [v.exactCuts([{ clip: 0, start: 0 }, { clip: 0, start: 1.3 }, { clip: 1, start: 2 }, { clip: 1, start: 0.5 + 1e-9 }], (c) => (c ? [0, 0.5, 2] : [0, 1])),
        v.exactCuts([{ clip: 0, start: 1 }], () => [0, 1])],
    };
  });
  assert(JSON.stringify(r.rates) === JSON.stringify([30, 29.97, 30, 25, 59.94, 60, 27.33, 23.976, 120, 26, 31]), 'rates ' + r.rates);
  assert(JSON.stringify(r.why) === JSON.stringify([[], ['clip 2 is HEVC, not H.264'], ['clip 2 is 1080 × 1920, not 1920 × 1080'], ['clip 2 is 1920 × 1440, not 1920 × 1080'], ['clip 2 runs at 25 fps, not 30'],
    ['clip 2 is HDR HLG, not SDR'], ['clip 2 was encoded with other settings'], ['clip 2 was encoded with other settings'],
    ['clip 1 is VP9, which cannot go into an MP4 as it is'], ['clip 2 runs at 60 fps, not 30', 'clip 3 is 640 × 480, not 1920 × 1080']]), 'join reasons ' + JSON.stringify(r.why));
  assert(JSON.stringify(r.snd) === JSON.stringify([{ mode: 'copy', why: [] }, { mode: 'none', why: [] }, { mode: 'copy', why: [] }, { mode: 'encode', why: ['clip 2 has no sound'] },
    { mode: 'encode', why: ['clip 2 has other sound (Opus · 48 kHz · 1 ch, not AAC · 48 kHz · 2 ch)'] }, { mode: 'encode', why: ['clip 2 has other sound (AAC · 44 kHz · 2 ch, not AAC · 48 kHz · 2 ch)'] }, { mode: 'none', why: [] }, { mode: 'encode', why: ['clip 1 has no sound'] },
    { mode: 'encode', why: ['Vorbis sound cannot go into an MP4 as it is'] }]), 'sound ' + JSON.stringify(r.snd));
  assert(JSON.stringify(r.offsets.at) === JSON.stringify([0, 1.5, 2.7]) && Math.abs(r.offsets.total - 3.2) < 1e-9, 'offsets ' + JSON.stringify(r.offsets));
  const g = r.grid;
  assert(g.frames === 45 + 45 + 1 && g.pieces[0].times.length === 45 && g.pieces[2].times.length === 1, 'grid counts ' + g.frames);
  near(g.pieces[0].times[0], 1, 1e-9, 'grid first'); near(g.pieces[0].times[44], 1 + 44 / 30, 1e-9, 'grid last');
  near(g.pieces[0].to, 2.5, 1e-9, 'grid piece end'); near(g.pieces[2].to - g.pieces[2].from, 1 / 30, 1e-9, 'a sliver still makes one frame');
  assert(r.grid25 === 38, 'grid at 25 fps ' + r.grid25);
  assert(JSON.stringify(r.place.map((x) => (x === null ? null : Math.round(x * 1000)))) === JSON.stringify([0, 20, 40, null, 60, 100]), 'sound at a join ' + JSON.stringify(r.place));
  assert(Math.abs(r.lens[0] - 4410 * 48000 / 44100) <= 2 && r.lens[0] === r.lens[1] && r.same, 'resampling in chunks matches one go ' + JSON.stringify(r.lens));
  assert(r.worst < 0.01, 'resampled tone off by ' + r.worst);
  assert(JSON.stringify(r.two) === JSON.stringify([[0.5, -0.25], [0.5, -0.25]]) && JSON.stringify(r.one) === JSON.stringify([0.2, 0.2]), 'channels ' + JSON.stringify([r.two, r.one]));
  assert(JSON.stringify(r.down) === JSON.stringify([0, 2, 4, 6]), 'half rate ' + r.down);
  assert(JSON.stringify(r.bitrate) === JSON.stringify([15552000, 60000000, 2000000]), 'bitrates ' + r.bitrate);
  assert(JSON.stringify(r.at) === JSON.stringify([{ i: 0, at: 1 }, { i: 0, at: 2.4 }, { i: 1, at: 0 }, { i: 1, at: 0.7000000000000002 }, { i: 1, at: 1 }, { i: 1, at: 1 }]), 'piece at ' + JSON.stringify(r.at));
  assert(JSON.stringify(r.of) === JSON.stringify([0, 1, 2]), 'time of ' + r.of);
  assert(JSON.stringify(r.split) === JSON.stringify([[{ clip: 0, start: 0, end: 1 }, { clip: 0, start: 1, end: 3 }, { clip: 1, start: 0, end: 2 }],
    [{ clip: 0, start: 0, end: 3 }, { clip: 1, start: 0, end: 1 }, { clip: 1, start: 1, end: 2 }], null, null, null, [{ clip: 0, start: 0, end: 2 }, { clip: 0, start: 2, end: 3 }]]), 'split ' + JSON.stringify(r.split));
  assert(JSON.stringify(r.splitAt) === JSON.stringify([[{ clip: 0, start: 0, end: 1.3 }, { clip: 0, start: 1.3, end: 3 }, { clip: 1, start: 0, end: 2 }], null, null]), 'exact split ' + JSON.stringify(r.splitAt));
  assert(JSON.stringify(r.exact) === JSON.stringify([[2], []]), 'pieces that start between keyframes ' + JSON.stringify(r.exact));
  await ctx.close();
}, { core: true });

test('video cut: split twice, delete the middle; the rest copies byte for byte and the sound follows', async () => {
  const { ctx, page } = await newApp();
  const src = await makeClip(page);         // 90 frames at 30 fps, keyframes at 0, 1 and 2 s
  await loadVideo(page, src);
  await page.click('[data-open-tool="cut"]');
  assert(await page.isVisible('.hint[data-for="cut"]'), 'the caption shows');
  assert((await page.textContent('#cut-out')) === '1 piece · copy, no re-encode', 'strip ' + await page.textContent('#cut-out'));
  // No keyframe inside the first second after its start: it cannot split there.
  await seekPlayer(page, 0.5);
  await page.click('#cut-split');
  assert(/No keyframe inside this piece before the playhead/.test(await page.textContent('#cut-note')), 'no split before the first keyframe');
  await seekPlayer(page, 1.2);
  await page.click('#cut-split');
  assert(/Split at 0:01\.00 in clip 1, the keyframe before 0:01\.20, so both pieces copy without re-encoding\./.test(await page.textContent('#cut-note')), 'note ' + await page.textContent('#cut-note'));
  await seekPlayer(page, 2.2);
  await page.click('#cut-split');
  assert(JSON.stringify(await pieces(page)) === JSON.stringify([[0, 0, 1], [0, 1, 2], [0, 2, 3]]), 'three pieces ' + JSON.stringify(await pieces(page)));
  // Tap the middle block to pick it, then delete it.
  const bar = await page.locator('#cut-line').boundingBox();
  await page.mouse.click(bar.x + bar.width * 0.5, bar.y + bar.height / 2);
  assert((await page.textContent('#cut-piece')) === '2 of 3' && await page.evaluate(() => retouch.tools.cut.sel === 1), 'middle piece picked');
  assert(await page.isDisabled('#cut-delete') === false && await page.isDisabled('#cut-earlier') === false, 'tiles on');
  await page.click('#cut-delete');
  assert(JSON.stringify(await pieces(page)) === JSON.stringify([[0, 0, 1], [0, 2, 3]]), 'middle gone ' + JSON.stringify(await pieces(page)));
  assert((await page.textContent('#cut-total')) === '0:02.00' && (await page.textContent('#cut-out')) === '2 pieces · copy, no re-encode', 'cells after delete');
  await applyTool(page, 'cut');
  assert((await page.textContent('#dims')) === '320 × 240 · 0:02.00' && /^1 edit ▸ /.test(await page.textContent('#top-code')), 'top bar ' + await page.textContent('#dims'));
  assert((await page.evaluate(() => retouch.app.video.history.current.label)) === 'Cut', 'step label');
  const { bytes } = await exportVideo(page);
  assert(/Copied without re-encoding/.test(await page.textContent('.notice[data-id="export"]')), 'confirmation says copied');
  const a = parseMp4(src), b = parseMp4(bytes), av = vtrack(a), bv = vtrack(b);
  assert(bv.sampleCount === 60 && JSON.stringify(bv.sync) === JSON.stringify([0, 30]), 'frames and keyframes ' + [bv.sampleCount, JSON.stringify(bv.sync)]);
  near(seconds(bv), 2, 0.002, 'video length');
  for (let k = 0; k < 30; k++) assert(bv.sample(k).equals(av.sample(k)), 'frame ' + k + ' changed');
  for (let k = 30; k < 60; k++) assert(bv.sample(k).equals(av.sample(k + 30)), 'frame ' + k + ' is not source frame ' + (k + 30));
  const cols = await decodeTrack(page, bv);
  assert(cols.length === 60 && typeof cols[0] !== 'string', 'all frames decode');
  near(cols[29][0], 78, 6, 'last frame of the first piece is source frame 29');
  near(cols[30][0], 140, 6, 'first frame after the cut is source frame 60');
  // Sound: the packets of 0 to 1 s, then those from 2 s, each unchanged and in order.
  const as_ = strack(a), bs = strack(b);
  near(seconds(bs), 2, 0.03, 'sound length');
  const src0 = Array.from({ length: as_.sampleCount }, (_, k) => as_.sample(k));
  let k = 0;
  while (k < bs.sampleCount && bs.sample(k).equals(src0[k])) k++;
  const j = src0.findIndex((x) => x.equals(bs.sample(k)));
  assert(k >= 49 && k <= 52 && j >= 98 && j <= 101, 'sound cut points ' + [k, j]);
  for (let m = k; m < bs.sampleCount; m++) assert(bs.sample(m).equals(src0[j + m - k]), 'sound packet ' + m + ' changed');
  assert(findVideoMetadata(bytes).length === 0, 'metadata: ' + findVideoMetadata(bytes));
  await page.click('#btn-undo');
  assert((await page.textContent('#dims')) === '320 × 240 · 0:03.00', 'undo brings the middle back');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
}, { core: true });

test('video cut: with keyframes far apart, Split and Start here offer an exact cut, which re-encodes', async () => {
  const { ctx, page } = await newApp();
  // Keyframes 3 s apart (at 0 and 3 s), as some re-saved videos have; 110 frames.
  const src = await makeClip(page, { frames: 110, gop: 90 });
  await loadVideo(page, src);
  await page.click('[data-open-tool="cut"]');
  // No keyframe inside the piece before 2.2 s: it offers the exact split.
  await seekPlayer(page, 2.2);
  await page.click('#cut-split');
  assert(/cannot be split there without re-encoding/.test(await page.textContent('#cut-note')), 'note ' + await page.textContent('#cut-note'));
  assert((await page.textContent('#cut-exact')) === 'Split exactly at 0:02.20 (re-encodes)', 'offer ' + await page.textContent('#cut-exact'));
  await page.click('#cut-exact');
  assert(JSON.stringify(await pieces(page)) === JSON.stringify([[0, 0, 2.2], [0, 2.2, 3.667]]), 'split exactly ' + JSON.stringify(await pieces(page)));
  assert(await page.isHidden('#cut-exact') && (await page.textContent('#cut-out')) === '2 pieces · re-encode to H.264', 'strip ' + await page.textContent('#cut-out'));
  assert(/Split exactly at 0:02\.20 in clip 1\. Export will re-encode the picture to H\.264 at 320 × 240, 30 fps: piece 2 starts between keyframes \(an exact cut\)\./.test(await page.textContent('#cut-note')), 'note ' + await page.textContent('#cut-note'));
  // Moving the exact piece first: the message follows it.
  await page.click('#cut-earlier');
  assert(/piece 1 starts between keyframes/.test(await page.textContent('#cut-note')), 'the exact piece is now piece 1');
  // Pick the piece from 0 (now second) on the bar and delete it; 2.2 s to the end stays.
  const b0 = await page.locator('#cut-line').boundingBox();
  await page.mouse.click(b0.x + b0.width * 0.9, b0.y + b0.height / 2);
  await page.click('#cut-delete');
  assert(JSON.stringify(await pieces(page)) === JSON.stringify([[0, 2.2, 3.667]]), 'kept the end ' + JSON.stringify(await pieces(page)));
  await applyTool(page, 'cut');
  const { bytes, note } = await reencodeVideo(page);
  assert(/piece 1 starts between keyframes \(an exact cut\)/.test(note), 'export note ' + note);
  const v = vtrack(parseMp4(bytes));
  assert(v.sampleCount === 44, 'frames 66 to 109: ' + v.sampleCount);
  const p = await probe(page, bytes, { at: [0.01] });
  near(p.colors[0][0][0], 152, 8, 'starts on source frame 66');
  // A snap of 0.5 s or less is not worth a re-encode: no offer.
  await page.click('#btn-undo');
  await page.click('[data-open-tool="cut"]');
  await seekPlayer(page, 3.4);
  await page.click('#cut-split');
  assert(await page.isHidden('#cut-exact') && /Split at 0:03\.00/.test(await page.textContent('#cut-note')), 'small snap: no offer');
  // A bigger snap offers; tapping a piece on the bar takes the offer away.
  await page.click('.sheet-panel[data-tool="cut"] [data-cancel]');
  await page.click('[data-open-tool="cut"]');
  await seekPlayer(page, 3.6);
  await page.click('#cut-split');
  assert(await page.isVisible('#cut-exact'), 'a 0.6 s snap offers');
  const bar = await page.locator('#cut-line').boundingBox();
  await page.mouse.click(bar.x + bar.width * 0.2, bar.y + bar.height / 2);
  assert(await page.isHidden('#cut-exact'), 'picking a piece clears the offer');
  await page.click('.sheet-panel[data-tool="cut"] [data-cancel]');
  // Trim: Start here at 3.6 s snaps back 0.6 s to 3.0, and offers the exact start.
  await page.click('[data-open-tool="trim"]');
  await seekPlayer(page, 3.6);
  await page.click('#trim-set-start');
  assert((await page.textContent('#trim-exact')) === 'Start exactly at 0:03.60 (re-encodes)', 'trim offer ' + await page.textContent('#trim-exact'));
  await page.click('#trim-exact');
  assert(await page.isHidden('#trim-exact') && /Starts exactly at 0:03\.60, between keyframes, so the export will be re-encoded to H\.264\./.test(await page.textContent('#trim-note')), 'trim note ' + await page.textContent('#trim-note'));
  near(await page.evaluate(() => retouch.tools.trim.d.start), 3.6, 1e-6, 'start on frame 108');
  await page.evaluate(() => retouch.tools.trim.setStart(3.4, false));
  assert(await page.isHidden('#trim-exact') && await page.isHidden('#trim-note'), 'a dragged start snaps again, no offer');
  near(await page.evaluate(() => retouch.tools.trim.d.start), 3, 1e-6, 'back on the keyframe');
  // Start here 0.4 s after a keyframe: no offer.
  await seekPlayer(page, 3.4);
  await page.click('#trim-set-start');
  assert(await page.isHidden('#trim-exact') && await page.isVisible('#trim-note'), 'small snap in Trim: note, no offer');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('video join: two clips recorded the same way copy end to end, in the order set', async () => {
  const { ctx, page } = await newApp();
  const a = await makeClip(page, { frames: 60 }), b = await makeClip(page, { frames: 45, blue: 200 });
  await loadVideo(page, a);
  await page.click('[data-open-tool="cut"]');
  await addClips(page, [b]);
  assert(JSON.stringify(await pieces(page)) === JSON.stringify([[0, 0, 2], [1, 0, 1.5]]), 'added after the picked piece ' + JSON.stringify(await pieces(page)));
  assert((await page.textContent('#cut-piece')) === '2 of 2' && (await page.textContent('#cut-clip')) === '2 of 2', 'the new piece is picked');
  assert((await page.textContent('#cut-out')) === '2 pieces · copy, no re-encode' && await page.isHidden('#cut-note'), 'same settings copy: ' + await page.textContent('#cut-out'));
  assert(await page.isDisabled('#cut-later'), 'last piece cannot go later');
  await page.click('#cut-earlier');
  assert(JSON.stringify(await pieces(page)) === JSON.stringify([[1, 0, 1.5], [0, 0, 2]]) && await page.isDisabled('#cut-earlier'), 'moved first');
  await applyTool(page, 'cut');
  assert((await page.evaluate(() => retouch.app.video.history.current.label)) === 'Join', 'step label');
  assert((await page.textContent('#dims')) === '320 × 240 · 0:03.50', 'top bar ' + await page.textContent('#dims'));
  const { bytes } = await exportVideo(page);
  const pa = vtrack(parseMp4(a)), pb = vtrack(parseMp4(b)), out = parseMp4(bytes), v = vtrack(out);
  assert(v.sampleCount === 105 && JSON.stringify(v.sync) === JSON.stringify([0, 30, 45, 75]), 'frames ' + v.sampleCount + ' keys ' + JSON.stringify(v.sync));
  near(seconds(v), 3.5, 0.002, 'length');
  for (let k = 0; k < 45; k++) assert(v.sample(k).equals(pb.sample(k)), 'frame ' + k + ' is not clip 2 frame ' + k);
  for (let k = 0; k < 60; k++) assert(v.sample(45 + k).equals(pa.sample(k)), 'frame ' + (45 + k) + ' is not clip 1 frame ' + k);
  assert(v.entryChild('avcC').equals(pa.entryChild('avcC')), 'codec setup as recorded');
  const s = strack(out);
  assert(s && s.codec === 'Opus', 'sound copied');
  near(seconds(s), 3.5, 0.04, 'sound length');
  const cols = await decodeTrack(page, v);
  near(cols[0][2], 200, 8, 'clip 2 first'); near(cols[45][2], 64, 8, 'then clip 1');
  assert(findVideoMetadata(bytes).length === 0, 'metadata: ' + findVideoMetadata(bytes));
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('video join: a silent clip recorded the same way still copies the picture; only the sound is encoded again', async () => {
  const { ctx, page } = await newApp();
  const a = await makeClip(page, { frames: 30, audio: false }), b = await makeClip(page, { frames: 30, blue: 200 });
  await loadVideo(page, a);
  assert(await page.isDisabled('[data-open-tool="sound"]'), 'no sound yet');
  await page.click('[data-open-tool="cut"]');
  await addClips(page, [b]);
  assert((await page.textContent('#cut-out')) === '2 pieces · copy, no re-encode', 'picture copies');
  await applyTool(page, 'cut');
  assert(!(await page.isDisabled('[data-open-tool="sound"]')) && !/no sound/.test(await page.textContent('#dims')), 'sound arrives with clip 2');
  await page.click('#btn-export');
  assert((await page.textContent('#vexport-sound')) === 're-encoded' && (await page.textContent('#vexport-copy')) === 'copied, not re-encoded', 'cells');
  assert(/The sound is re-encoded: clip 1 has no sound\./.test(await page.textContent('#vexport-note')), 'note ' + await page.textContent('#vexport-note'));
  await page.click('.sheet-panel[data-tool="vexport"] [data-cancel]');
  const { bytes } = await exportVideo(page);
  const m = parseMp4(bytes), v = vtrack(m), pa = vtrack(parseMp4(a)), pb = vtrack(parseMp4(b));
  assert(v.sampleCount === 60, 'frames ' + v.sampleCount);
  for (let k = 0; k < 30; k++) assert(v.sample(k).equals(pa.sample(k)) && v.sample(30 + k).equals(pb.sample(k)), 'frame ' + k + ' changed');
  near(seconds(strack(m)), 2, 0.05, 'sound length');
  const p = await probe(page, bytes, { windows: [[0.1, 0.9], [1.1, 1.9]] });
  assert(p.rms[0] < 0.01 && p.rms[1] > 0.1, 'silence, then the tone ' + p.rms);
  // Sound removed: nothing to encode, and the copy carries no sound track.
  await page.click('[data-open-tool="sound"]');
  await page.click('[data-sound="remove"]');
  await applyTool(page, 'sound');
  const m2 = parseMp4((await exportVideo(page)).bytes);
  assert(m2.tracks.length === 1 && vtrack(m2).sampleCount === 60, 'picture only');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('video join: a clip of another shape is re-encoded to H.264 at the first size, with black bars', async () => {
  const { ctx, page } = await newApp();
  const a = await makeClip(page, { frames: 30 }), b = await makeClip(page, { w: 160, h: 240, frames: 30, blue: 200 });
  await loadVideo(page, a);
  await page.click('[data-open-tool="cut"]');
  await addClips(page, [b]);
  assert((await page.textContent('#cut-out')) === '2 pieces · re-encode to H.264', 'strip ' + await page.textContent('#cut-out'));
  assert(/Export will re-encode the picture to H\.264 at 320 × 240, 30 fps: clip 2 is 160 × 240, not 320 × 240\./.test(await page.textContent('#cut-note')), 'note ' + await page.textContent('#cut-note'));
  await applyTool(page, 'cut');
  const t0 = Date.now();
  const { bytes, note } = await reencodeVideo(page);
  assert(/re-encoded to H\.264 at 320 × 240, 30 fps, because clip 2 is 160 × 240, not 320 × 240\. Clips of another shape get black bars\./.test(note) && !/HDR/.test(note), 'export note ' + note);
  assert(/Re-encoded to H\.264\./.test(await page.textContent('.notice[data-id="export"]')), 'confirmation says re-encoded');
  const m = parseMp4(bytes), v = vtrack(m);
  assert(v.codec === 'avc1' && v.codedWidth === 320 && v.codedHeight === 240 && v.sampleCount === 60, 'picture ' + [v.codec, v.codedWidth, v.codedHeight, v.sampleCount]);
  near(seconds(v), 2, 0.002, 'length');
  const p = await probe(page, bytes, { at: [0.5, 1.5], points: [[0.5, 0.5], [0.1, 0.5], [0.3, 0.5], [0.9, 0.5]] });
  // Clip 1 fills the frame; clip 2 (160 × 240) fits 160 wide in the middle, black either side.
  near(p.colors[0][0][0], 50, 8, 'clip 1 frame 15 red'); near(p.colors[0][1][2], 64, 8, 'clip 1 reaches the edge');
  near(p.colors[1][0][0], 50, 8, 'clip 2 frame 15 red'); near(p.colors[1][0][2], 200, 8, 'clip 2 blue');
  near(p.colors[1][2][2], 200, 8, 'clip 2 inside its width');
  for (const k of [1, 3]) assert(p.colors[1][k].every((c) => c < 12), 'black bar ' + JSON.stringify(p.colors[1][k]));
  assert(p.audio && p.audio.codec === 'opus', 'both clips have the same sound, so it is copied: ' + JSON.stringify(p.audio));
  near(seconds(strack(m)), 2, 0.05, 'sound length');
  assert(findVideoMetadata(bytes).length === 0, 'metadata: ' + findVideoMetadata(bytes));
  console.log('      60 frames re-encoded in ' + (Date.now() - t0) + ' ms');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('video join: a portrait clip stored turned 90 degrees joins an upright one the right way up', async () => {
  const { ctx, page } = await newApp();
  // The phone's way: 320 × 240 frames with a quarter turn clockwise in the file, shown 240 × 320.
  const a = await makeClip(page, { rotation: 90, frames: 30, mark: true }), b = await makeClip(page, { w: 240, h: 320, frames: 30, mark: true, blue: 200 });
  await loadVideo(page, a);
  await page.click('[data-open-tool="cut"]');
  await addClips(page, [b]);
  assert(/clip 2 was encoded with other settings/.test(await page.textContent('#cut-note')), 'same shape on screen, stored differently: ' + await page.textContent('#cut-note'));
  await applyTool(page, 'cut');
  assert((await page.textContent('#dims')) === '240 × 320 · 0:02.00', 'top bar ' + await page.textContent('#dims'));
  const { bytes } = await reencodeVideo(page);
  const v = vtrack(parseMp4(bytes));
  assert(v.codedWidth === 240 && v.codedHeight === 320 && JSON.stringify(v.matrix.slice(0, 5)) === JSON.stringify([65536, 0, 0, 0, 65536]), 'stored upright ' + [v.codedWidth, v.codedHeight, v.matrix]);
  const p = await probe(page, bytes, { at: [0.5, 1.5], points: [[0.9, 0.1], [0.1, 0.1], [0.5, 0.5]] });
  // Clip 1's stored top-left corner turns to the top right; clip 2's stays top left.
  assert(p.colors[0][0].every((c) => c > 230) && p.colors[0][1][2] < 120, 'clip 1 turned: ' + JSON.stringify(p.colors[0]));
  assert(p.colors[1][1].every((c) => c > 230) && p.colors[1][0][2] > 150, 'clip 2 as it was: ' + JSON.stringify(p.colors[1]));
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('video join: another frame rate and HDR re-encode to SDR at the first rate; a silent clip gets silence', async () => {
  const { ctx, page } = await newApp();
  const hlg = { primaries: 'bt2020', transfer: 'hlg', matrix: 'bt2020-ncl', fullRange: false };
  const a = await makeClip(page, { frames: 30 }), b = await makeClip(page, { fps: 25, frames: 25, gop: 25, audio: false, colorSpace: hlg, blue: 200 });
  await loadVideo(page, a);
  await page.click('[data-open-tool="cut"]');
  await addClips(page, [b]);
  const cn = await page.textContent('#cut-note');
  assert(/clip 2 runs at 25 fps, not 30\. HDR becomes SDR\./.test(cn), 'cut note ' + cn);
  await applyTool(page, 'cut');
  await page.click('#btn-export');
  assert((await page.textContent('#vexport-sound')) === 're-encoded' && (await page.textContent('#vexport-copy')) === 're-encoded, H.264', 'export cells');
  await page.click('.sheet-panel[data-tool="vexport"] [data-cancel]');
  const { bytes, note } = await reencodeVideo(page);
  assert(/HDR becomes SDR: this phone cannot encode 10-bit HDR video\./.test(note) && /The sound is re-encoded: clip 2 has no sound\./.test(note), 'export note ' + note);
  const m = parseMp4(bytes), v = vtrack(m), s = strack(m);
  assert(v.sampleCount === 60, 'one second of 25 fps becomes 30 frames: ' + v.sampleCount);
  near(seconds(v), 2, 0.002, 'length');
  assert(!v.colr || v.colr.transfer !== 18, 'not tagged HLG ' + JSON.stringify(v.colr));
  assert(s && s.codec === 'Opus', 'sound encoded again (Opus here; AAC where the phone has it): ' + (s && s.codec));
  near(seconds(s), 2, 0.05, 'sound as long as the picture');
  const p = await probe(page, bytes, { at: [0.5, 1.5], windows: [[0.1, 0.9], [1.1, 1.9]] });
  assert(p.rms[0] > 0.1 && p.rms[1] < 0.01, 'tone, then silence ' + p.rms);
  near(p.colors[1][0][2], 200, 12, 'clip 2 shows in the second second');
  assert(findVideoMetadata(bytes).length === 0, 'metadata: ' + findVideoMetadata(bytes));
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('video join: Trim works on the picked piece; playback runs on into the next clip; hold and undo', async () => {
  const { ctx, page } = await newApp();
  const a = await makeClip(page, { frames: 45 }), b = await makeClip(page, { frames: 60, blue: 200 });
  await loadVideo(page, a);
  await page.click('[data-open-tool="cut"]');
  await addClips(page, [b]);
  await applyTool(page, 'cut');
  await page.click('[data-open-tool="trim"]');
  assert(/^piece 2 of 2 · keyframe every 1\.00 s$/.test(await page.textContent('#trim-out')), 'strip ' + await page.textContent('#trim-out'));
  assert(await page.evaluate(() => retouch.pl.clip === 1), 'the player holds clip 2');
  await page.evaluate(() => retouch.tools.trim.setEnd(1.2));
  await applyTool(page, 'trim');
  assert(JSON.stringify(await pieces(page, false)) === JSON.stringify([[0, 0, 1.5], [1, 0, 1.2]]), 'only piece 2 trimmed ' + JSON.stringify(await pieces(page, false)));
  assert((await page.textContent('#dims')) === '320 × 240 · 0:02.70', 'top bar ' + await page.textContent('#dims'));
  // Play from the start: it moves to clip 2's file after 1.5 s and stops at the end.
  await page.evaluate(() => { const s = document.querySelector('#seek'); s.value = '0'; s.dispatchEvent(new Event('input')); });
  await page.waitForFunction(() => retouch.pl.clip === 0 && retouch.pl.seek === null && retouch.player.readyState >= 2, null, { timeout: 10000 });
  await page.click('#play');
  await page.waitForFunction(() => retouch.pl.clip === 1 && retouch.pl.i === 1 && retouch.player.currentTime > 0.2, null, { timeout: 10000 });
  assert(/^0:0[12]\.\d\d \/ 0:02\.70$/.test(await page.textContent('#clock')), 'clock runs on ' + await page.textContent('#clock'));
  await page.waitForFunction(() => retouch.player.paused && retouch.pl.i === 0, null, { timeout: 10000 });
  // Hold shows the original: clip 1 alone.
  await page.click('#btn-export');
  const hb = await page.locator('.sheet-panel[data-tool="vexport"] [data-hold]').boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  const held = await page.evaluate(() => [retouch.pl.clip, document.querySelector('#clock').textContent]);
  await page.mouse.up();
  assert(held[0] === 0 && /\/ 0:01\.50$/.test(held[1]), 'hold plays the original ' + held);
  await page.click('.sheet-panel[data-tool="vexport"] [data-cancel]');
  await page.click('#btn-undo');
  assert((await page.textContent('#dims')) === '320 × 240 · 0:03.50', 'undo the trim');
  await page.click('#btn-undo');
  assert((await page.textContent('#dims')) === '320 × 240 · 0:01.50' && await page.evaluate(() => retouch.app.video.sel === 0), 'undo the join');
  // A file that is not a video is not added, and says so.
  await page.click('[data-open-tool="cut"]');
  await page.setInputFiles('#file-add', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.waitForSelector('.notice[data-id="add"]');
  assert(/notes\.txt is not a video/.test(await page.textContent('.notice[data-id="add"]')), 'not a video');
  await page.setInputFiles('#file-add', { name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(3000, 9)]) });
  await page.waitForFunction(() => /broken\.mp4 could not be added/.test(document.querySelector('.notice[data-id="add"]').textContent) && retouch.app.busyCount === 0);
  assert(JSON.stringify(await pieces(page)) === JSON.stringify([[0, 0, 1.5]]), 'nothing added');
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

test('video join: several videos picked or shared together open as one joined clip', async () => {
  const { ctx, page } = await newApp({ sw: true });
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
  const a = await makeClip(page, { frames: 30 }), b = await makeClip(page, { frames: 15, blue: 200 });
  // Picked together.
  await page.setInputFiles('#file', [{ name: 'PXL_a.mp4', mimeType: 'video/mp4', buffer: a }, { name: 'PXL_b.mp4', mimeType: 'video/mp4', buffer: b }]);
  await page.waitForFunction(() => retouch.app.video && retouch.app.video.clips.length === 2 && retouch.app.busyCount === 0);
  assert(JSON.stringify(await pieces(page, false)) === JSON.stringify([[0, 0, 1], [1, 0, 0.5]]) && /^1 edit ▸ /.test(await page.textContent('#top-code')), 'joined as one step');
  // Shared together from another app, offline.
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.retouch && window.retouch.app);
  await page.evaluate(([x, y]) => {
    const form = document.createElement('form');
    form.method = 'POST'; form.action = 'share-target'; form.enctype = 'multipart/form-data';
    const input = document.createElement('input'); input.type = 'file'; input.name = 'media'; input.multiple = true;
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(x)], 'PXL_1.mp4', { type: 'video/mp4' }));
    dt.items.add(new File([new Uint8Array(y)], 'PXL_2.mp4', { type: 'video/mp4' }));
    input.files = dt.files;
    form.append(input); document.body.append(form); form.submit();
  }, [Array.from(a), Array.from(b)]);
  await page.waitForURL(/retouch\.html$/);
  await page.waitForFunction(() => window.retouch && window.retouch.app.video && window.retouch.app.video.clips.length === 2 && window.retouch.app.busyCount === 0, null, { timeout: 15000 });
  assert(await page.evaluate(() => retouch.app.fileName === 'PXL_1.mp4'), 'named after the first');
  const left = await page.evaluate(async () => (await (await caches.open('retouch-share')).keys()).length);
  assert(left === 0, 'share cache emptied: ' + left);
  const m = parseMp4((await exportVideo(page)).bytes);
  assert(vtrack(m).sampleCount === 45, 'exports both: ' + vtrack(m).sampleCount);
  // A photo first: only it opens, and the notice says why.
  await ctx.setOffline(false);
  await page.setInputFiles('#file', [{ name: 'a.png', mimeType: 'image/png', buffer: gradient() }, { name: 'PXL_b.mp4', mimeType: 'video/mp4', buffer: b }]);
  await page.waitForSelector('.notice[data-id="add"]');
  assert(await page.evaluate(() => !!retouch.app.edits && !retouch.app.video), 'the photo is open');
  await ctx.close();
});

test('real-photo tests (reference/test-images)', async () => {
  if (!fs.existsSync(REFERENCE)) skip('reference/test-images/ not present');
  const imgs = fs.readdirSync(REFERENCE).filter((f) => /\.(jpe?g|png|webp|avif)$/i.test(f));
  if (!imgs.length) skip('no images in reference/test-images/');
  const { ctx, page } = await newApp();
  for (const f of imgs) {
    await load(page, fs.readFileSync(path.join(REFERENCE, f)), f, 'image/' + (/png$/i.test(f) ? 'png' : /webp$/i.test(f) ? 'webp' : /avif$/i.test(f) ? 'avif' : 'jpeg'));
    const d = await dims(page);
    assert(d[0] * d[1] <= 4080 * 3072, f + ' over the ceiling');
    await page.click('#btn-export');
    await page.waitForFunction(() => !document.querySelector('#export-download').disabled);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-download')]);
    const left = findImageMetadata(fs.readFileSync(await dl.path()));
    assert(!left.length, f + ' export carries ' + left);
    await page.click('.sheet-panel[data-tool="export"] [data-cancel]');
    // Background removal with the real model: these are photos of people, so a person
    // must be found, and the cut-out exports as a clean PNG.
    await bgReady(page);
    const cov = await page.evaluate(() => retouch.tools.bg.model.found);
    assert(cov > 0.03 && cov < 0.97, f + ': person found in ' + (cov * 100).toFixed(1) + ' % of the photo');
    await applyTool(page, 'bg');
    await page.click('#btn-export');
    await page.waitForFunction(() => !document.querySelector('#export-download').disabled, null, { timeout: 30000 });
    const [cut] = await Promise.all([page.waitForEvent('download'), page.click('#export-download')]);
    const bytes = fs.readFileSync(await cut.path());
    assert(imageFormat(bytes) === 'png', f + ': cut-out should export as PNG');
    const left2 = findImageMetadata(bytes);
    assert(!left2.length, f + ' cut-out export carries ' + left2);
    await page.click('.sheet-panel[data-tool="export"] [data-cancel]');
    await page.click('#btn-undo');
    await skinReady(page);
    const skin = await page.evaluate(() => retouch.tools.skin.model.coverage);
    assert(skin > 0.005, f + ': skin found in ' + (skin * 100).toFixed(1) + ' % of the photo');
    await applyTool(page, 'skin');
    await page.click('#btn-undo');
    console.log('      ' + f + ': person ' + (cov * 100).toFixed(1) + ' %, skin ' + (skin * 100).toFixed(1) + ' %');
  }
  assert(page.errors.length === 0, page.errors.join('; '));
  await ctx.close();
});

/* ---------- Runner ---------- */

(async () => {
  const pw = loadPlaywright();
  const srv = await startServer();
  BASE = 'http://127.0.0.1:' + srv.address().port;
  browser = await pw.chromium.launch();
  let pass = 0, fail = 0, skipped = 0;
  const t0 = Date.now();
  for (const t of tests) {
    if (ONLY_CORE && !t.core) continue;
    if (GREP && !GREP.test(t.name)) continue;
    const s = Date.now();
    try {
      await t.fn();
      pass++;
      console.log('PASS ' + t.name + '  (' + (Date.now() - s) + ' ms)');
    } catch (e) {
      if (e instanceof Skip) { skipped++; console.log('SKIP ' + t.name + ': ' + e.message); continue; }
      fail++;
      console.log('FAIL ' + t.name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 3).join('\n      '));
    }
  }
  if (!ONLY_CORE && !GREP) {
    if (foreignRequests.length) { fail++; console.log('FAIL no requests to other origins\n      ' + foreignRequests.join('\n      ')); }
    else { pass++; console.log('PASS no requests to other origins during the whole run'); }
  }
  await browser.close();
  srv.close();
  console.log('\nretouch_behave: ' + pass + ' passed, ' + fail + ' failed, ' + skipped + ' skipped  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
