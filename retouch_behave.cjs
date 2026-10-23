#!/usr/bin/env node
// retouch_behave.cjs: behavioural tests in real Chromium (Playwright).
//
// Canvas, image decoding and service workers only behave properly in a real
// browser, so this suite serves the repo on localhost and drives the app.
// Every fixture is synthetic and built here (gradients, flat colours, files
// with planted EXIF/XMP/IPTC/GPS), so results can be checked as numbers.
// Tests that need a real person (phase 3 onwards) read reference/test-images/
// and skip cleanly when it is absent.
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

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
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
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push('console: ' + m.text()); });
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
  for (const t of ['crop', 'resize', 'pad', 'text']) {
    await page.click('[data-open-tool="' + t + '"]');
    await hold('.sheet-panel[data-tool="' + t + '"] [data-hold]');
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
  for (const t of ['crop', 'resize', 'pad', 'text']) {
    await page.click('[data-open-tool="' + t + '"]');
    await checkVisible(t + ' sheet');
    const stage = await page.locator('#stage').boundingBox();
    assert(stage.height > 400, t + ': photo area only ' + stage.height + ' px tall');
    await page.click('.sheet-panel[data-tool="' + t + '"] [data-cancel]');
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
  }
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
