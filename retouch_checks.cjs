#!/usr/bin/env node
// retouch_checks.cjs: static checks. No browser needed; runs in under a second.
//
// What it guards:
//   - the Content-Security-Policy is present and only allows this origin
//   - no other origin, CDN or network call appears anywhere in the app source
//   - every required file is present, and nothing outside the allowed set
//   - every vendored file has a pinned version in the retouch.html build notes,
//     and every sha256 recorded there matches the file
//   - the vendored MediaPipe code holds no telemetry and no other site to call
//   - the service worker cache version matches APP_VERSION
//   - CHANGELOG.md: every heading gives version, release date and time; the newest is
//     APP_VERSION; newest first; each entry has a change line
//   - the manifest has the share target and icons
//   - every image in the repo carries no EXIF, XMP, IPTC, GPS or text chunks
//   - no video files are committed at all (test clips are made inside the tests)
//   - the vendored Mediabunny (video) has no telemetry, and its only code that could
//     reach the network (a URL reader and an HLS reader) is never used by retouch
//
// Run: node retouch_checks.cjs
// The metadata parser and the MP4 reader below are exported for retouch_behave.cjs,
// and are written independently of retouch.html so the app is not checking itself.

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(ROOT, f));

// CHANGELOG.md (versioning rule, 30/10/26).
// Every heading is "## <version>, dd/mm/yy HHMM hrs" with an optional ", <label>"; the
// version is vX.Y.Z, a legacy vN, or Brief. Newest first: the top entry is the current
// APP_VERSION, x.y.z versions strictly fall, times never rise going down, and every entry
// has at least one "- " change line.
function changelogProblems(text, appVersion) {
  const probs = [];
  const heads = [];
  const lines = text.split('\n');
  lines.forEach((l, i) => { if (l.startsWith('## ')) heads.push(i); });
  if (!heads.length) return ['no entries'];
  const cmp = (a, b) => { for (let k = 0; k < 3; k++) if (a[k] !== b[k]) return a[k] - b[k]; return 0; };
  let prevVer = null, prevStamp = null;
  heads.forEach((h, n) => {
    const m = lines[h].match(/^## (v\d+\.\d+\.\d+|v\d+|Brief), (\d\d)\/(\d\d)\/(\d\d) (\d\d)(\d\d) hrs(, .+)?$/);
    if (!m) { probs.push(`heading not "## vX.Y.Z, dd/mm/yy HHMM hrs": ${lines[h]}`); return; }
    const [, label, dd, mo, yy, hh, mi] = m;
    if (+dd < 1 || +dd > 31 || +mo < 1 || +mo > 12 || +hh > 23 || +mi > 59) probs.push(`bad date or time: ${lines[h]}`);
    if (n === 0 && label !== 'v' + appVersion) probs.push(`newest entry ${label} is not the current version v${appVersion}`);
    const stamp = yy + mo + dd + hh + mi;
    if (prevStamp && stamp > prevStamp) probs.push(`${label} is later than the entry above it`);
    prevStamp = stamp;
    const xyz = label.match(/^v(\d+)\.(\d+)\.(\d+)$/);
    if (xyz) {
      const v = xyz.slice(1).map(Number);
      if (prevVer && cmp(v, prevVer) >= 0) probs.push(`${label} is not below the version above it`);
      prevVer = v;
    }
    const body = lines.slice(h + 1, heads[n + 1] ?? lines.length);
    if (!body.some((l) => l.startsWith('- '))) probs.push(`${label} has no "- " change line`);
  });
  return probs;
}

// App source: the files the browser runs.
const APP_SOURCE = ['retouch.html', 'index.html', 'sw.js', 'manifest.webmanifest'];

// Allowed files at the top level. The app itself is retouch.html plus the PWA
// minimum; the rest is docs and the test suites.
const ALLOWED_TOP = new Set([
  'retouch.html', 'index.html', 'manifest.webmanifest', 'sw.js', 'icons', 'vendor',
  'README.md', 'CLAUDE.md', 'CHANGELOG.md', '.gitignore', '.git', 'package.json', 'package-lock.json',
  'retouch_checks.cjs', 'retouch_behave.cjs', 'retouch_mutate.sh',
  'reference', 'node_modules', // both gitignored
]);

// MediaPipe, vendored. Its scripts are the only .js files allowed besides sw.js.
const MEDIAPIPE_DIR = 'vendor/mediapipe/';
const MEDIAPIPE_SCRIPTS = ['vendor/mediapipe/vision_bundle.js', 'vendor/mediapipe/vision_wasm_internal.js'];
// Web addresses in the Emscripten loader, reviewed for 0.10.35: every one sits in a
// comment or error text (docs, bug reports, a sample stack trace). None is fetched.
// An upgrade that adds an address fails here until someone has looked at it.
const MEDIAPIPE_LOADER_URLS = [
  'http://en.wikipedia.org/wiki/UTF-8#Description',
  'http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js.html',
  'http://pubs.opengroup.org/onlinepubs/009695399/functions/tzset.html',
  'http://server.com:4324:12',
  'http://unicode.org/faq/utf_bom.html#utf16-3',
  'http://www.w3.org/TR/2013/WD-cssom-view-20131217/',
  'https://bugzil.la/1328882',
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/getTimezoneOffset',
  'https://github.com/emscripten-core/emscripten/issues/13295.',
  'https://github.com/emscripten-core/emscripten/issues/23697',
  'https://github.com/emscripten-core/emscripten/pull/8236',
  'https://github.com/github/fetch/pull/92#issuecomment-140665932',
  'https://github.com/google/closure-compiler/issues/3193,',
  'https://github.com/google/closure-compiler/pull/3913',
  'https://github.com/libsdl-org/SDL/pull/6304',
  'https://github.com/nodejs/help/issues/2136#issuecomment-523649904',
  'https://tools.ietf.org/html/rfc3629',
  'https://webkit.org/b/222758',
  'https://www.ietf.org/rfc/rfc2279.txt',
  'https://www.khronos.org/registry/webgl/specs/latest/2.0/#5.15',
];

// Mediabunny, vendored for video. Reviewed for 1.61.6: these six addresses sit in the
// licence header and in error text; none is fetched. Its URL and HLS readers call
// fetch in two places (written '??fetch' in the bundle); retouch never creates them.
const MEDIABUNNY_DIR = 'vendor/mediabunny/';
const MEDIABUNNY_SCRIPTS = ['vendor/mediabunny/mediabunny.js'];
const MEDIABUNNY_URLS = [
  'https://aomediacodec.github.io/av1-isobmff/.',
  'https://mozilla.org/MPL/2.0/.',
  'https://www.w3.org/TR/webcodecs-aac-codec-registration/.',
  'https://www.w3.org/TR/webcodecs-flac-codec-registration/.',
  'https://www.w3.org/TR/webcodecs-vorbis-codec-registration/.',
  'https://www.webmproject.org/vp9/mp4/.',
];
const MEDIABUNNY_FETCH_SITES = 2;
// Mediabunny names that reach the network, or could (a playlist names other files).
const MEDIABUNNY_NETWORK_NAMES = ['UrlSource', 'HLS', 'HlsInputFormat', 'HLS_FORMATS', 'ALL_FORMATS', 'fetchFn', 'PathedSource', 'CustomPathedSource'];

const CDN_HOSTS = [
  'cdnjs', 'jsdelivr', 'unpkg', 'googleapis', 'gstatic', 'cloudflare', 'bootstrapcdn',
  'jquery.com', 'skypack', 'esm.sh', 'esm.run', 'fontawesome', 'typekit', 'rawgit',
  'githack', 'cdn.', 'storage.googleapis', 'tfhub', 'kaggle',
];

/* ---------- Independent metadata parser ---------- */

const ascii = (b, at, n) => b.subarray(at, Math.min(b.length, at + n)).toString('latin1');

function findImageMetadata(buf) {
  const b = Buffer.from(buf);
  const found = [];
  // Belt and braces: well-known metadata signatures anywhere in the file.
  for (const [sig, name] of [['Exif\0\0', 'EXIF signature'], ['ns.adobe.com/xap', 'XMP signature'],
    ['<x:xmpmeta', 'XMP packet'], ['Photoshop 3.0', 'IPTC signature'], ['8BIM\x04\x04', 'IPTC record']]) {
    if (b.indexOf(Buffer.from(sig, 'latin1')) >= 0) found.push(name);
  }
  if (b[0] === 0xFF && b[1] === 0xD8) {
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xFF) { found.push('JPEG structure broken at ' + i); break; }
      const m = b[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0xD9) break;
      if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (m === 0xE1) found.push('APP1 (EXIF or XMP)');
      else if (m === 0xED) found.push('APP13 (IPTC)');
      else if (m === 0xFE) found.push('COM (comment)');
      else if (m === 0xE2 && ascii(b, i + 4, 12) !== 'ICC_PROFILE\0') found.push('APP2 (not ICC)');
      else if (m >= 0xE3 && m <= 0xEF && m !== 0xEE) found.push('APP' + (m - 0xE0));
      if (m === 0xDA) break; // entropy data follows; metadata segments come before it
      i += 2 + len;
    }
  } else if (b.length > 8 && b.readUInt32BE(0) === 0x89504E47) {
    let i = 8;
    while (i + 8 <= b.length) {
      const len = b.readUInt32BE(i);
      const type = ascii(b, i + 4, 4);
      if (['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) found.push('PNG ' + type);
      i += 12 + len;
      if (type === 'IEND') break;
    }
  } else if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    let i = 12;
    while (i + 8 <= b.length) {
      const type = ascii(b, i, 4);
      const len = b.readUInt32LE(i + 4);
      if (type === 'EXIF' || type === 'XMP ') found.push('WebP ' + type.trim());
      if (type === 'VP8X' && (b[i + 8] & 0x0C)) found.push('WebP VP8X metadata flags');
      i += 8 + len + (len & 1);
    }
  } else {
    found.push('unrecognised image format');
  }
  return found;
}

function imageFormat(buf) {
  const b = Buffer.from(buf);
  if (b[0] === 0xFF && b[1] === 0xD8) return 'jpeg';
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504E47) return 'png';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  return null;
}

/* ---------- Independent MP4 reader ---------- */

// Walks the ISO base media boxes of an MP4 or MOV file. Enough to count samples,
// read durations, sizes, colour tags and rotation, and to find metadata.
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'mvex']);

function mp4Boxes(b, from, to) {
  const out = [];
  let i = from;
  while (i + 8 <= to) {
    let size = b.readUInt32BE(i), hdr = 8;
    const type = ascii(b, i + 4, 4);
    if (size === 1) { size = Number(b.readBigUInt64BE(i + 8)); hdr = 16; }
    else if (size === 0) size = to - i;
    if (size < hdr || i + size > to) throw new Error('MP4 box ' + JSON.stringify(type) + ' at ' + i + ' runs past its parent');
    out.push({ type, start: i, size, body: i + hdr, end: i + size });
    i += size;
  }
  return out;
}
const kid = (b, box, type) => mp4Boxes(b, box.body, box.end).find((x) => x.type === type);
const kids = (b, box, type) => mp4Boxes(b, box.body, box.end).filter((x) => x.type === type);
const boxAt = (b, box, ...types) => types.reduce((bx, t) => bx && kid(b, bx, t), box);
// Version 1 boxes use 64-bit times and durations.
const u = (b, at, wide) => (wide ? Number(b.readBigUInt64BE(at)) : b.readUInt32BE(at));

function parseMp4(buf) {
  const b = Buffer.from(buf);
  const top = mp4Boxes(b, 0, b.length);
  const moov = top.find((x) => x.type === 'moov');
  if (!moov) throw new Error('no moov box');
  const mvhdBox = kid(b, moov, 'mvhd');
  const v1 = b[mvhdBox.body] === 1;
  const o = mvhdBox.body + 4;
  const mvhd = { ctime: u(b, o, v1), mtime: u(b, o + (v1 ? 8 : 4), v1), timescale: b.readUInt32BE(o + (v1 ? 16 : 8)), duration: u(b, o + (v1 ? 20 : 12), v1) };
  const tracks = kids(b, moov, 'trak').map((trak) => {
    const t = {};
    const tk = kid(b, trak, 'tkhd'), tv1 = b[tk.body] === 1, to = tk.body + 4;
    t.tkhd = { ctime: u(b, to, tv1), mtime: u(b, to + (tv1 ? 8 : 4), tv1) };
    const mo = to + (tv1 ? 32 : 20) + 16;                  // after times, id, reserved, duration, then 8 reserved + layer, group, volume, reserved
    t.matrix = Array.from({ length: 9 }, (_, k) => b.readInt32BE(mo + k * 4));
    t.width = b.readUInt32BE(mo + 36) / 65536; t.height = b.readUInt32BE(mo + 40) / 65536;
    const md = boxAt(b, trak, 'mdia', 'mdhd'), mv1 = b[md.body] === 1, mdo = md.body + 4;
    t.mdhd = { ctime: u(b, mdo, mv1), mtime: u(b, mdo + (mv1 ? 8 : 4), mv1), timescale: b.readUInt32BE(mdo + (mv1 ? 16 : 8)), duration: u(b, mdo + (mv1 ? 20 : 12), mv1) };
    t.handler = ascii(b, boxAt(b, trak, 'mdia', 'hdlr').body + 8, 4);
    const elst = boxAt(b, trak, 'edts', 'elst');
    if (elst) {
      const ev1 = b[elst.body] === 1, n = b.readUInt32BE(elst.body + 4);
      t.elst = Array.from({ length: n }, (_, k) => {
        const at = elst.body + 8 + k * (ev1 ? 20 : 12);
        return { duration: u(b, at, ev1), mediaTime: ev1 ? Number(b.readBigInt64BE(at + 8)) : b.readInt32BE(at + 4) };
      });
    }
    const stbl = boxAt(b, trak, 'mdia', 'minf', 'stbl');
    const stsd = kid(b, stbl, 'stsd');
    const entry = mp4Boxes(b, stsd.body + 8, stsd.end)[0];
    t.codec = entry.type;
    const visual = t.handler === 'vide';
    // Sample entry: 8 bytes, then 70 more for video or 20 for (version 0) audio, then child boxes.
    t.entryBoxes = mp4Boxes(b, entry.body + 8 + (visual ? 70 : 20), entry.end).map((x) => x.type);
    // The codec's own setup bytes (avcC, hvcC, dOps, esds...), as a decoder needs them.
    t.entryChild = (type) => { const x = mp4Boxes(b, entry.body + 8 + (visual ? 70 : 20), entry.end).find((y) => y.type === type); return x ? b.subarray(x.body, x.end) : null; };
    if (visual) { t.codedWidth = b.readUInt16BE(entry.body + 24); t.codedHeight = b.readUInt16BE(entry.body + 26); }
    const colr = mp4Boxes(b, entry.body + 8 + (visual ? 70 : 20), entry.end).find((x) => x.type === 'colr');
    if (colr && ascii(b, colr.body, 4) === 'nclx') {
      t.colr = { primaries: b.readUInt16BE(colr.body + 4), transfer: b.readUInt16BE(colr.body + 6), matrix: b.readUInt16BE(colr.body + 8), fullRange: !!(b[colr.body + 10] & 0x80) };
    }
    const stts = kid(b, stbl, 'stts');
    t.deltas = [];
    for (let k = 0, n = b.readUInt32BE(stts.body + 4); k < n; k++) {
      const c = b.readUInt32BE(stts.body + 8 + k * 8), d = b.readUInt32BE(stts.body + 12 + k * 8);
      for (let j = 0; j < c; j++) t.deltas.push(d);
    }
    const stsz = kid(b, stbl, 'stsz');
    const fixed = b.readUInt32BE(stsz.body + 4), count = b.readUInt32BE(stsz.body + 8);
    t.sizes = Array.from({ length: count }, (_, k) => fixed || b.readUInt32BE(stsz.body + 12 + k * 4));
    t.sampleCount = count;
    t.mediaDuration = t.deltas.reduce((a, x) => a + x, 0);
    const stss = kid(b, stbl, 'stss');
    t.sync = stss ? Array.from({ length: b.readUInt32BE(stss.body + 4) }, (_, k) => b.readUInt32BE(stss.body + 8 + k * 4) - 1) : null;   // 0-based; null means every sample is a key
    t.hasCtts = !!kid(b, stbl, 'ctts');
    // Where each sample's bytes are: chunks from stco or co64, samples per chunk from stsc.
    const stco = kid(b, stbl, 'stco'), co64 = kid(b, stbl, 'co64');
    const chunks = stco ? Array.from({ length: b.readUInt32BE(stco.body + 4) }, (_, k) => b.readUInt32BE(stco.body + 8 + k * 4))
      : Array.from({ length: b.readUInt32BE(co64.body + 4) }, (_, k) => Number(b.readBigUInt64BE(co64.body + 8 + k * 8)));
    const stsc = kid(b, stbl, 'stsc');
    const runs = Array.from({ length: b.readUInt32BE(stsc.body + 4) }, (_, k) => [b.readUInt32BE(stsc.body + 8 + k * 12) - 1, b.readUInt32BE(stsc.body + 12 + k * 12)]);
    t.offsets = [];
    let s = 0;
    for (let c = 0; c < chunks.length && s < count; c++) {
      let per = 0;
      for (const [first, n] of runs) if (c >= first) per = n;
      let at = chunks[c];
      for (let j = 0; j < per && s < count; j++) { t.offsets.push(at); at += t.sizes[s++]; }
    }
    t.sample = (k) => b.subarray(t.offsets[k], t.offsets[k] + t.sizes[k]);
    return t;
  });
  return { top: top.map((x) => x.type), mvhd, tracks, bytes: b };
}

// Everything in an MP4 that could say where, when or with what a video was made.
function findVideoMetadata(buf) {
  const b = Buffer.from(buf);
  const found = [];
  const top = mp4Boxes(b, 0, b.length);
  for (const x of top) if (!['ftyp', 'moov', 'mdat', 'free', 'skip'].includes(x.type)) found.push('top-level ' + x.type + ' box');
  const moov = top.find((x) => x.type === 'moov');
  if (!moov) return found.concat('no moov box');
  const walk = (box, where) => {
    for (const x of mp4Boxes(b, box.body, box.end)) {
      if (['udta', 'meta', 'uuid', 'ilst', 'keys', 'XMP_', 'cprt', 'loci'].includes(x.type)) found.push(x.type + ' box in ' + where);
      if (CONTAINERS.has(x.type) && x.type !== 'udta') walk(x, where + '/' + x.type);
    }
  };
  walk(moov, 'moov');
  // Signatures are looked for in every box but the media data itself.
  const m = Buffer.concat(top.filter((x) => x.type !== 'mdat').map((x) => b.subarray(x.start, x.end)));
  for (const [sig, name] of [['\xA9xyz', 'GPS location (\xA9xyz)'], ['<x:xmpmeta', 'XMP packet'], ['ns.adobe.com/xap', 'XMP signature'], ['Exif\0\0', 'EXIF signature'], ['\xA9mak', 'camera make'], ['\xA9mod', 'camera model'], ['\xA9day', 'date tag']]) {
    if (m.indexOf(Buffer.from(sig, 'latin1')) >= 0) found.push(name);
  }
  const p = parseMp4(b);
  if (p.mvhd.ctime || p.mvhd.mtime) found.push('date in mvhd');
  for (const t of p.tracks) {
    if (t.tkhd.ctime || t.tkhd.mtime || t.mdhd.ctime || t.mdhd.mtime) found.push('date in the ' + t.handler + ' track');
    if (!['vide', 'soun'].includes(t.handler)) found.push('extra ' + t.handler + ' track');
  }
  return found;
}

/* ---------- Checks ---------- */

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (['.git', 'node_modules', 'reference'].includes(e.name)) continue;
    const rel = dir ? dir + '/' + e.name : e.name;
    if (e.isDirectory()) walk(rel, out); else out.push(rel);
  }
  return out;
}

function stripComments(js) {
  // Rough but adequate: drop /* */ and // comments that are not inside strings we use.
  return js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

function scriptOf(html) {
  return Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)).map((m) => m[1]).join('\n');
}

function runChecks() {
  const results = [];
  const check = (name, fn) => {
    try { const r = fn(); results.push({ name, ok: true, note: r || '' }); }
    catch (e) { results.push({ name, ok: false, note: e.message }); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  check('required files present', () => {
    const req = [...APP_SOURCE, 'README.md', 'CLAUDE.md', 'CHANGELOG.md', '.gitignore', 'retouch_checks.cjs', 'retouch_behave.cjs', 'retouch_mutate.sh'];
    const missing = req.filter((f) => !exists(f));
    assert(!missing.length, 'missing: ' + missing.join(', '));
  });

  check('only allowed files at top level (app logic stays in retouch.html)', () => {
    const extra = fs.readdirSync(ROOT).filter((f) => !ALLOWED_TOP.has(f));
    assert(!extra.length, 'unexpected: ' + extra.join(', '));
    const js = walk('').filter((f) => /\.(m?js|cjs)$/.test(f) && !['sw.js', 'retouch_checks.cjs', 'retouch_behave.cjs', ...MEDIAPIPE_SCRIPTS, ...MEDIABUNNY_SCRIPTS].includes(f));
    assert(!js.length, 'extra script files: ' + js.join(', '));
  });

  check('reference/ is gitignored', () => {
    const gi = read('.gitignore');
    assert(/^\/?reference\/?\s*$/m.test(gi), '.gitignore must list reference/');
  });

  check('CSP meta tag in every HTML file, connect-src self only', () => {
    for (const f of ['retouch.html', 'index.html']) {
      const html = read(f);
      const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
      assert(m, f + ': no CSP meta tag');
      const csp = m[1];
      const dirs = Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
        const [k, ...v] = d.split(/\s+/); return [k, v];
      }));
      assert(dirs['default-src'] && dirs['default-src'].join(' ') === "'self'", f + ": default-src must be 'self'");
      assert(dirs['connect-src'] && dirs['connect-src'].join(' ') === "'self'", f + ": connect-src must be exactly 'self'");
      for (const [k, v] of Object.entries(dirs)) {
        for (const src of v) {
          assert(/^'[a-z-]+'$/.test(src) || src === 'blob:' || src === 'data:', f + ': ' + k + ' allows ' + src);
        }
      }
      // The CSP must come before any script so it governs everything.
      assert(html.indexOf('Content-Security-Policy') < html.search(/<script\b/i) || html.search(/<script\b/i) < 0, f + ': CSP after a script');
    }
  });

  check('no external origins anywhere in the app source', () => {
    const bad = [];
    for (const f of APP_SOURCE) {
      const src = read(f);
      for (const m of src.matchAll(/\b(?:https?|wss?|ftp):\/\/[^\s"'<>)]*/gi)) bad.push(f + ': ' + m[0]);
      for (const m of src.matchAll(/(?:src|href|action)\s*=\s*["']\s*\/\/[^"']*/gi)) bad.push(f + ': ' + m[0]);
      for (const m of src.matchAll(/url\(\s*["']?\s*\/\/[^)]*/gi)) bad.push(f + ': ' + m[0]);
      for (const m of src.matchAll(/@import\b[^;]*/gi)) bad.push(f + ': ' + m[0]);
    }
    assert(!bad.length, bad.join('\n      '));
  });

  check('no CDN references in any source file', () => {
    const bad = [];
    for (const f of walk('').filter((x) => /\.(html|js|cjs|json|webmanifest|css|md|sh)$/.test(x))) {
      if (f === 'CLAUDE.md' || f === 'retouch_checks.cjs' || f.startsWith(MEDIAPIPE_DIR) || f.startsWith(MEDIABUNNY_DIR)) continue;   // vendored code: own checks below
      const src = read(f).toLowerCase();
      for (const h of CDN_HOSTS) if (src.includes(h)) bad.push(f + ': ' + h);
    }
    assert(!bad.length, bad.join(', '));
  });

  check('no network calls to other origins (fetch, XHR, WebSocket, sendBeacon)', () => {
    const page = stripComments(scriptOf(read('retouch.html')));
    const banned = [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /sendBeacon/, /\bEventSource\b/, /importScripts/, /RTCPeerConnection/, /\bnew\s+Worker\s*\(\s*['"`][a-z]+:/i];
    const hits = banned.filter((re) => re.test(page)).map(String);
    assert(!hits.length, 'retouch.html uses: ' + hits.join(', '));
    // Code may only be imported from vendor/, by a fixed relative path.
    const imports = Array.from(page.matchAll(/\bimport\s*\(([^)]*)\)/g)).map((m) => m[1].trim());
    const badImports = imports.filter((a) => !/^'\.\/vendor\/[\w./-]+\.js'$/.test(a));
    assert(!badImports.length, 'retouch.html imports: ' + badImports.join(', '));
    const sw = stripComments(read('sw.js'));
    const swBanned = [/XMLHttpRequest/, /\bWebSocket\b/, /sendBeacon/, /\bEventSource\b/, /importScripts/];
    const swHits = swBanned.filter((re) => re.test(sw)).map(String);
    assert(!swHits.length, 'sw.js uses: ' + swHits.join(', '));
    // The worker may only fetch the request it was handed, after the same-origin guard.
    const calls = Array.from(sw.matchAll(/\bfetch\s*\(([^)]*)\)/g)).map((m) => m[1].trim());
    assert(calls.every((a) => a === 'req'), 'sw.js fetch calls: ' + calls.join(', '));
    const guard = sw.indexOf('if (url.origin !== self.location.origin) return');
    assert(guard > 0 && guard < sw.indexOf('fetch(req)'), 'sw.js must return early for other origins before any fetch');
  });

  check('vendored files have pinned versions in the build notes', () => {
    const html = read('retouch.html');
    const notes = (html.match(/Build notes:[\s\S]*?-->/) || [''])[0];
    assert(notes, 'no "Build notes:" block in the retouch.html header');
    const vendored = walk('vendor');
    assert(vendored.length, 'vendor/ is empty');
    const missing = [], drifted = [];
    for (const f of vendored) {
      const line = notes.split('\n').find((l) => l.includes(f + ' '));
      const sha = line && (line.match(/sha256 ([0-9a-f]{64})\b/) || [])[1];
      if (!line || !(/\b\d+\.\d+\.\d+\b/.test(line) || sha)) missing.push(f);
      if (sha && require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex') !== sha) drifted.push(f);
    }
    assert(!missing.length, 'no pinned version recorded for: ' + missing.join(', '));
    assert(!drifted.length, 'file differs from the sha256 in the build notes: ' + drifted.join(', '));
    const mp = walk('vendor').filter((f) => (f.startsWith(MEDIAPIPE_DIR) || f.startsWith(MEDIABUNNY_DIR)) && !/\.txt$/.test(f));
    const unhashed = mp.filter((f) => !/sha256 [0-9a-f]{64}/.test(notes.split('\n').find((l) => l.includes(f + ' ')) || ''));
    assert(!unhashed.length, 'MediaPipe and Mediabunny files need a sha256 in the build notes: ' + unhashed.join(', '));
    const listed = Array.from(notes.matchAll(/vendor\/\S+/g)).map((m) => m[0]);
    const ghost = listed.filter((f) => !exists(f));
    assert(!ghost.length, 'build notes list files that do not exist: ' + ghost.join(', '));
  });

  check('vendored MediaPipe: no telemetry, no other site it could call', () => {
    const bundle = read('vendor/mediapipe/vision_bundle.js');
    const loader = read('vendor/mediapipe/vision_wasm_internal.js');
    const urlRe = /(?:https?|wss?|ftp):\/\/[^\s"'<>)`]*/g;
    const inBundle = bundle.match(urlRe) || [];
    assert(!inBundle.length, 'web addresses in the bundle: ' + inBundle.join(', '));
    // Protobuf type names look like addresses but are never fetched.
    const google = (bundle.match(/[\w.-]*googleapis[\w./-]*/g) || []).filter((h) => !/^type\.googleapis\.com\/mediapipe\./.test(h));
    assert(!google.length, 'googleapis in the bundle: ' + google.join(', '));
    for (const [name, src] of [['bundle', bundle], ['loader', loader]]) {
      for (const sig of ['odml', 'v1/log', 'x-goog-api-key', 'sendBeacon', 'google-analytics', 'firebase', 'clearcut']) {
        assert(!src.includes(sig), name + ' contains "' + sig + '" (telemetry?)');
      }
    }
    const extra = [...new Set(loader.match(urlRe) || [])].filter((u) => !MEDIAPIPE_LOADER_URLS.includes(u));
    assert(!extra.length, 'new web addresses in the loader, review them: ' + extra.join(', '));
    return MEDIAPIPE_LOADER_URLS.length + ' reviewed comment links in the loader';
  });

  check('vendored Mediabunny: no telemetry, network readers reviewed and never used', () => {
    const src = read('vendor/mediabunny/mediabunny.js');
    const urls = [...new Set(src.match(/(?:https?|wss?|ftp):\/\/[^\s"'<>)`]*/g) || [])];
    const extra = urls.filter((x) => !MEDIABUNNY_URLS.includes(x));
    assert(!extra.length, 'new web addresses in Mediabunny, review them: ' + extra.join(', '));
    for (const sig of ['XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'importScripts', 'google-analytics', 'firebase', 'clearcut', 'x-goog-api-key', 'telemetry', 'posthog', 'sentry']) {
      assert(!src.includes(sig), 'Mediabunny contains "' + sig + '"');
    }
    const sites = (src.match(/\?\?fetch\b/g) || []).length;
    assert(sites === MEDIABUNNY_FETCH_SITES, 'Mediabunny calls fetch in ' + sites + ' places, reviewed ' + MEDIABUNNY_FETCH_SITES + ': review the change');
    assert(!/\bfetch\s*\(/.test(src), 'Mediabunny calls fetch( directly: review it');
    const page = stripComments(scriptOf(read('retouch.html')));
    const used = MEDIABUNNY_NETWORK_NAMES.filter((n) => new RegExp('\\b' + n + '\\b').test(page));
    assert(!used.length, 'retouch.html uses Mediabunny network readers: ' + used.join(', '));
    return MEDIABUNNY_URLS.length + ' reviewed addresses, ' + sites + ' fetch sites in readers retouch never uses';
  });

  check('service worker caches the shell and every vendored runtime file', () => {
    const sw = read('sw.js');
    const list = (name) => Array.from((sw.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];')) || ['', ''])[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
    const shell = [...list('SHELL'), ...list('VENDOR'), ...list('VIDEO_VENDOR')];
    assert(list('SHELL').length, 'no SHELL list in sw.js');
    // The MediaPipe cache is named by its pin, so a new pin always downloads fresh files.
    const pin = (read('retouch.html').match(/@mediapipe\/tasks-vision (\d+\.\d+\.\d+)/) || [])[1];
    const vc = (sw.match(/const VENDOR_CACHE = '([^']+)'/) || [])[1];
    assert(pin && vc === 'retouch-mediapipe-' + pin, 'VENDOR_CACHE ' + vc + ' does not match the pinned @mediapipe/tasks-vision ' + pin);
    assert(list('VENDOR').every((f) => f.startsWith(MEDIAPIPE_DIR)), 'VENDOR lists files outside ' + MEDIAPIPE_DIR);
    const mbPin = (read('retouch.html').match(/mediabunny (\d+\.\d+\.\d+)/) || [])[1];
    const mbc = (sw.match(/const VIDEO_CACHE = '([^']+)'/) || [])[1];
    assert(mbPin && mbc === 'retouch-mediabunny-' + mbPin, 'VIDEO_CACHE ' + mbc + ' does not match the pinned mediabunny ' + mbPin);
    assert(list('VIDEO_VENDOR').length && list('VIDEO_VENDOR').every((f) => f.startsWith(MEDIABUNNY_DIR)), 'VIDEO_VENDOR must list only ' + MEDIABUNNY_DIR);
    const missing = shell.filter((f) => f !== './' && !exists(f));
    assert(!missing.length, 'SHELL lists missing files: ' + missing.join(', '));
    const runtime = walk('vendor').filter((f) => !/\.txt$/.test(f)).concat(walk('icons'));
    const uncached = runtime.filter((f) => !shell.includes(f));
    assert(!uncached.length, 'not cached for offline: ' + uncached.join(', '));
    for (const f of ['retouch.html', 'index.html', 'manifest.webmanifest']) assert(shell.includes(f), f + ' not in SHELL');
  });

  check('cache version matches APP_VERSION', () => {
    const app = (read('retouch.html').match(/const APP_VERSION = '([^']+)'/) || [])[1];
    const sw = (read('sw.js').match(/const CACHE_VERSION = '([^']+)'/) || [])[1];
    const header = (read('retouch.html').match(/APP_VERSION (\d+\.\d+\.\d+)/) || [])[1];
    assert(app && sw, 'version constants not found');
    assert(app === sw, 'retouch.html APP_VERSION ' + app + ' but sw.js CACHE_VERSION ' + sw);
    assert(header === app, 'header comment says ' + header + ', code says ' + app);
    const pkg = JSON.parse(read('package.json'));
    assert(pkg.version === app, 'package.json version ' + pkg.version + ' differs from ' + app);
    return 'v' + app;
  });

  // Every release adds its entry to CHANGELOG.md in the same commit as the
  // version bump: the newest entry must be the version the app says it is.
  check('CHANGELOG.md: version, release date and time, change; newest first', () => {
    const app = (read('retouch.html').match(/const APP_VERSION = '([^']+)'/) || [])[1];
    const probs = changelogProblems(read('CHANGELOG.md'), app);
    assert(!probs.length, probs.join('; '));
    return (read('CHANGELOG.md').match(/^## /gm) || []).length + ' entries';
  });

  check('working-size ceiling is one named constant', () => {
    const js = stripComments(scriptOf(read('retouch.html')));
    const defs = js.match(/const MAX_WORKING_PIXELS = [^;]+;/g) || [];
    assert(defs.length === 1, 'expected one MAX_WORKING_PIXELS definition, found ' + defs.length);
    const literals = js.replace(defs[0], '').match(/\b(4080|3072|12533760|12\.5e6)\b/g);
    assert(!literals, 'ceiling values used outside the constant: ' + (literals || []).join(', '));
  });

  check('createImageBitmap applies EXIF orientation on load', () => {
    const js = scriptOf(read('retouch.html'));
    assert(/createImageBitmap\(file,\s*\{\s*imageOrientation:\s*'from-image'/.test(js), "open must use imageOrientation: 'from-image'");
  });

  check('manifest: standalone, icons, share target', () => {
    const m = JSON.parse(read('manifest.webmanifest'));
    assert(m.display === 'standalone', 'display must be standalone');
    assert(m.start_url && !/^[a-z]+:/i.test(m.start_url), 'start_url must be relative');
    const st = m.share_target;
    assert(st && st.method === 'POST' && st.enctype === 'multipart/form-data', 'share_target must POST multipart/form-data');
    const files = (st.params && st.params.files) || [];
    assert(files.some((f) => f.accept.includes('image/*')), 'share_target must accept image/*');
    assert(files.some((f) => f.accept.includes('video/*')), 'share_target must accept video/*');
    const name = files[0].name;
    assert(read('sw.js').includes("getAll('" + name + "')"), 'sw.js does not read the shared field "' + name + '"');
    assert(read('sw.js').includes("endsWith('/share-target')") && st.action.endsWith('share-target'), 'share action and sw.js disagree');
    for (const ic of m.icons) {
      assert(exists(ic.src), 'missing icon ' + ic.src);
      const b = fs.readFileSync(path.join(ROOT, ic.src));
      const [w, h] = [b.readUInt32BE(16), b.readUInt32BE(20)];
      assert(ic.sizes === w + 'x' + h, ic.src + ' is ' + w + 'x' + h + ', manifest says ' + ic.sizes);
    }
    assert(m.icons.some((i) => i.purpose === 'maskable'), 'no maskable icon');
    assert(m.icons.some((i) => i.sizes === '512x512') && m.icons.some((i) => i.sizes === '192x192'), 'need 192 and 512 icons');
  });

  check('every committed image carries no metadata', () => {
    const imgs = walk('').filter((f) => /\.(png|jpe?g|webp|gif|avif|heic)$/i.test(f));
    const bad = [];
    for (const f of imgs) {
      const found = findImageMetadata(fs.readFileSync(path.join(ROOT, f)));
      if (found.length) bad.push(f + ': ' + found.join(', '));
    }
    assert(!bad.length, bad.join('; '));
    return imgs.length + ' images';
  });

  check('no video files in the repo (test clips are made in the tests)', () => {
    const vids = walk('').filter((f) => /\.(mp4|m4v|mov|3gp|3g2|webm|mkv|avi|hevc|h264|264|265)$/i.test(f));
    assert(!vids.length, 'video files committed: ' + vids.join(', '));
  });

  check('README states the Ultra HDR limitation', () => {
    const r = read('README.md');
    assert(/Ultra HDR/i.test(r) && /gain map/i.test(r), 'README must explain the Ultra HDR gain map limitation');
  });

  check('no em dashes in docs or UI text', () => {
    const bad = ['README.md', 'retouch.html', 'manifest.webmanifest'].filter((f) => read(f).includes('\u2014'));
    assert(!bad.length, 'em dash in: ' + bad.join(', '));
  });

  return results;
}

function main() {
  const results = runChecks();
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.note ? '\n      ' + r.note : ''));
  }
  console.log('\nretouch_checks: ' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

module.exports = { findImageMetadata, imageFormat, parseMp4, findVideoMetadata };
if (require.main === module) main();
