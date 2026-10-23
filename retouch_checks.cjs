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
//   - the manifest has the share target and icons
//   - every image in the repo carries no EXIF, XMP, IPTC, GPS or text chunks
//
// Run: node retouch_checks.cjs
// The metadata parser at the bottom is exported for retouch_behave.cjs, and is
// written independently of the one in retouch.html so the app is not checking itself.

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(ROOT, f));

// App source: the files the browser runs.
const APP_SOURCE = ['retouch.html', 'index.html', 'sw.js', 'manifest.webmanifest'];

// Allowed files at the top level. The app itself is retouch.html plus the PWA
// minimum; the rest is docs and the test suites.
const ALLOWED_TOP = new Set([
  'retouch.html', 'index.html', 'manifest.webmanifest', 'sw.js', 'icons', 'vendor',
  'README.md', 'CLAUDE.md', '.gitignore', '.git', 'package.json', 'package-lock.json',
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
    const req = [...APP_SOURCE, 'README.md', 'CLAUDE.md', '.gitignore', 'retouch_checks.cjs', 'retouch_behave.cjs', 'retouch_mutate.sh'];
    const missing = req.filter((f) => !exists(f));
    assert(!missing.length, 'missing: ' + missing.join(', '));
  });

  check('only allowed files at top level (app logic stays in retouch.html)', () => {
    const extra = fs.readdirSync(ROOT).filter((f) => !ALLOWED_TOP.has(f));
    assert(!extra.length, 'unexpected: ' + extra.join(', '));
    const js = walk('').filter((f) => /\.(m?js|cjs)$/.test(f) && !['sw.js', 'retouch_checks.cjs', 'retouch_behave.cjs', ...MEDIAPIPE_SCRIPTS].includes(f));
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
      if (f === 'CLAUDE.md' || f === 'retouch_checks.cjs' || f.startsWith(MEDIAPIPE_DIR)) continue;   // MediaPipe: own check below
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
    const mp = walk('vendor').filter((f) => f.startsWith(MEDIAPIPE_DIR) && !/\.txt$/.test(f));
    const unhashed = mp.filter((f) => !/sha256 [0-9a-f]{64}/.test(notes.split('\n').find((l) => l.includes(f + ' ')) || ''));
    assert(!unhashed.length, 'MediaPipe files need a sha256 in the build notes: ' + unhashed.join(', '));
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

  check('service worker caches the shell and every vendored runtime file', () => {
    const sw = read('sw.js');
    const list = (name) => Array.from((sw.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];')) || ['', ''])[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
    const shell = [...list('SHELL'), ...list('VENDOR')];
    assert(list('SHELL').length, 'no SHELL list in sw.js');
    // The MediaPipe cache is named by its pin, so a new pin always downloads fresh files.
    const pin = (read('retouch.html').match(/@mediapipe\/tasks-vision (\d+\.\d+\.\d+)/) || [])[1];
    const vc = (sw.match(/const VENDOR_CACHE = '([^']+)'/) || [])[1];
    assert(pin && vc === 'retouch-mediapipe-' + pin, 'VENDOR_CACHE ' + vc + ' does not match the pinned @mediapipe/tasks-vision ' + pin);
    assert(list('VENDOR').every((f) => f.startsWith(MEDIAPIPE_DIR)), 'VENDOR lists files outside ' + MEDIAPIPE_DIR);
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

module.exports = { findImageMetadata, imageFormat };
if (require.main === module) main();
