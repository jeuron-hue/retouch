#!/usr/bin/env node
// retouch_behave.cjs: behavioural tests in real Chromium (Playwright).
//
// Canvas, image decoding and service workers only behave properly in a real
// browser, so this suite serves the repo on localhost and drives the app.
// Every fixture is synthetic and built here (gradients, flat colours, files
// with planted EXIF/XMP/IPTC/GPS), so results can be checked as numbers.
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
const { findImageMetadata, imageFormat } = require('./retouch_checks.cjs');

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
  for (const t of ['crop', 'resize', 'pad', 'text', 'bg', 'skin']) {
    await page.click('[data-open-tool="' + t + '"]');
    await hold('.sheet-panel[data-tool="' + t + '"] [data-hold]');
    await idle(page);
    await page.click('.sheet-panel[data-tool="' + t + '"] [data-cancel]');
  }
  await page.click('#btn-export');
  await hold('.sheet-panel[data-tool="export"] [data-hold]');
  const panels = await page.$$eval('.sheet-panel', (ps) => ps.map((p) => [p.dataset.tool, !!p.querySelector('[data-hold]')]));
  assert(panels.every(([, h]) => h), 'every tool needs a hold button: ' + JSON.stringify(panels));
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
  for (const t of ['crop', 'resize', 'pad', 'text', 'bg', 'bg-brush', 'skin', 'skin-brush']) {
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
  assert(fonts.some((f) => /Source Sans 3/.test(f)) && fonts.some((f) => /JetBrains Mono/.test(f)), 'fonts offline: ' + fonts);
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
  await page.click('#text-fonts [data-font="' + (o.font || 'sans') + '"]');
  await page.fill('#text-size', String(o.size || 40));
  await page.dispatchEvent('#text-size', 'input');
  await page.click('[data-target="fill"]');
  await page.fill('#text-colour', o.colour || '#ff00ff');
  await page.fill('#text-outline', String(o.outline || 0));
  await page.dispatchEvent('#text-outline', 'input');
  if (o.outlineColour) { await page.click('[data-target="outline"]'); await page.fill('#text-colour', o.outlineColour); await page.click('[data-target="fill"]'); }
  await page.click('[data-shadow="' + (o.shadow || 'none') + '"]');
  await page.click('[data-align="' + (o.align || 'center') + '"]');
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
  await page.click('#text-fonts [data-font="hand"]');
  await page.click('[data-align="right"]');
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
    // putAlpha over a box writes only that box, from the matching part of the map.
    const pc = core.makeCanvas(30, 20), pctx = pc.getContext('2d', { willReadFrequently: true });
    const amap = new Float32Array(600).map((_, i) => (i % 30) / 29);
    core.STRIP_PIXELS = 7;                                              // force many strips
    core.putAlpha(pctx, amap, 30, 20, { x0: 10, y0: 5, x1: 25, y1: 15 });
    core.STRIP_PIXELS = 1000000;
    const pa = (x, y) => pctx.getImageData(x, y, 1, 1).data[3];
    const put = [pa(9, 8), pa(10, 8), pa(24, 14), pa(25, 14), pa(17, 4), pa(17, 5), pa(17, 15), pa(20, 10)];
    const guideDims = [core.bgGuideDims(4080, 3072), core.bgGuideDims(3072, 4080), core.bgGuideDims(300, 200)];
    return { boxErr, up, ramp, same, uneven, person, curve, lo, hi, guideDims, guideLong: core.BG_GUIDE_LONG, haze, coverage, put };
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
  samePx(f.veil[1], [117, 40, 155, 255], 3, 'veil: cut part tinted');
  samePx(f.half, [228, 178, 153, 255], 2, 'half alpha over white');
  await ctx.close();
}, { core: true });

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
  samePx(await page.evaluate(() => window.__px(retouch.app.preview.src, 20, 20)), [127, 65, 145, 255], 4, 'sky under the red veil');
  samePx(await page.evaluate(() => window.__px(retouch.app.preview.src, 150, 120)), SKIN.concat(255), 1, 'person clear in the brush view');
  await page.fill('#bg-brush', '30');
  await page.dispatchEvent('#bg-brush', 'input');
  await brush(page, [[120, 120], [180, 120]]);
  let st = await page.evaluate(() => retouch.tools.bg.strokes.map((s) => [s.mode, s.pts.length, +(s.r * retouch.view.scale).toFixed(2)]));
  assert(st.length === 1 && st[0][0] === 'erase' && st[0][1] > 4 && st[0][2] === 15, 'erase stroke ' + JSON.stringify(st));
  assert(await page.isEnabled('#bg-undo-stroke'), 'undo stroke enabled');
  samePx(await page.evaluate(() => window.__px(retouch.app.preview.src, 150, 120)), [212, 100, 110, 255], 4, 'erased skin shows under the veil in the preview');
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

test('background: the real model runs from vendor/, offline, and nothing else is asked for', async () => {
  const { ctx, page } = await newApp({ sw: true });
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 });
  const cached = await page.evaluate(async () => {
    const names = await caches.keys(), mp = names.find((n) => n.startsWith('retouch-mediapipe-'));
    return { names, files: mp ? (await (await caches.open(mp)).keys()).map((r) => new URL(r.url).pathname.split('/').pop()).sort() : [] };
  });
  assert(cached.files.join() === 'selfie_multiclass_256x256.tflite,vision_bundle.js,vision_wasm_internal.js,vision_wasm_internal.wasm', 'MediaPipe cache: ' + JSON.stringify(cached));
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.retouch && window.retouch.app);
  await load(page, personPng());
  const labels = [];
  await page.exposeFunction('__busyLabel', (t) => labels.push(t));
  await page.evaluate(() => new MutationObserver(() => window.__busyLabel(document.querySelector('#busy').textContent)).observe(document.querySelector('#busy'), { childList: true, characterData: true, subtree: true }));
  await bgReady(page);
  const m = await page.evaluate(() => { const t = retouch.tools.bg; return { w: t.model.w, h: t.model.h, cov: t.model.coverage, n: t.model.ar.length, override: retouch.segmenter.override }; });
  assert(m.w === 300 && m.h === 200 && m.n === 60000, 'model on the guide grid: ' + JSON.stringify(m));
  assert(m.cov >= 0 && m.cov <= 1 && m.override === null, 'person share from the real model ' + m.cov);
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
  assert(r.tileDiff <= 1, 'tiles must join without a seam: differs by ' + r.tileDiff);
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
    const cov = await page.evaluate(() => retouch.tools.bg.model.coverage);
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
