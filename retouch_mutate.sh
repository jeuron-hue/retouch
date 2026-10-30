#!/usr/bin/env bash
# retouch_mutate.sh: mutation run over the core image functions.
#
# The idea: plant one small, deliberate bug (a "mutant") in the CORE block of
# retouch.html, run the core behaviour tests against it, and expect them to
# fail. A mutant the tests do not notice has "survived", which means the
# fixtures are too loose and need tightening. Every mutant should be killed.
#
# Each line below is: name ||| exact text in CORE ||| replacement.
# The text must appear exactly once between "// CORE:BEGIN" and "// CORE:END".
#
# Run: bash retouch_mutate.sh          (about an hour)
#      JOBS=4 bash retouch_mutate.sh   (run four mutants at a time, about 30 minutes)

set -u
cd "$(dirname "$0")"
JOBS="${JOBS:-2}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

MUTANTS=$(cat <<'EOF'
fit: no square root ||| const s = Math.sqrt(maxPixels / (w * h)); ||| const s = maxPixels / (w * h);
fit: scale a photo already at the limit ||| if (w * h <= maxPixels) return { w, h, scaled: false }; ||| if (w * h < maxPixels * 0.9) return { w, h, scaled: false };
crop: extent uses cos twice ||| return { x: (w / 2) * c + (h / 2) * s, y: ||| return { x: (w / 2) * c + (h / 2) * c, y:
crop: max rect too big ||| const b = Math.min(hw / (ratio * c + s), hh / (ratio * s + c)); ||| const b = Math.max(hw / (ratio * c + s), hh / (ratio * s + c));
crop: max rect ratio inverted ||| return { cx: 0, cy: 0, w: 2 * b * ratio, h: 2 * b }; ||| return { cx: 0, cy: 0, w: 2 * b, h: 2 * b * ratio };
crop: validity checks height against width ||| Math.abs(v) + e.y <= h0 / 2 - margin + eps; ||| Math.abs(v) + e.y <= w0 / 2 - margin + eps;
crop: clamp pins to one side ||| u = Math.min(lu, Math.max(-lu, u)); ||| u = Math.min(lu, Math.max(lu, u));
crop: clamp rotates back the wrong way ||| return { cx: c * u - s * v, cy: s * u + c * v, ||| return { cx: c * u + s * v, cy: s * u + c * v,
crop: fit ignores the margin ||| const k = Math.min(1, (w0 / 2 - margin) / e.x, (h0 / 2 - margin) / e.y); ||| const k = Math.min(1, (w0 / 2) / e.x, (h0 / 2) / e.y);
crop: snap forgets the centre offset ||| const L = Math.min(w0 - W, Math.max(0, Math.round(rect.cx - rect.w / 2 + w0 / 2))); ||| const L = Math.min(w0 - W, Math.max(0, Math.round(rect.cx - rect.w / 2)));
crop: snap clamp lets the box hang off ||| const L = Math.min(w0 - W, Math.max(0, ||| const L = Math.min(w0, Math.max(0,
crop: rotate 90 goes anticlockwise ||| core.QUARTER = [[1, 0, 0, 1], [0, 1, -1, 0], ||| core.QUARTER = [[1, 0, 0, 1], [0, -1, 1, 0],
crop: flips swapped ||| ctx.scale(p.flipH ? -1 : 1, p.flipV ? -1 : 1); ||| ctx.scale(p.flipV ? -1 : 1, p.flipH ? -1 : 1);
crop: crop offset sign ||| ctx.translate(W / 2 - cx, H / 2 - cy); ||| ctx.translate(W / 2 + cx, H / 2 - cy);
crop: straighten turns the wrong way ||| if (p.theta) ctx.rotate(p.theta); ||| if (p.theta) ctx.rotate(-p.theta);
resize: long edge picks the short side ||| if (w >= h) return { w: v, h: Math.max(1, Math.round(h * v / w)) }; ||| if (w <= h) return { w: v, h: Math.max(1, Math.round(h * v / w)) };
resize: width mode ratio inverted ||| if (mode === 'width') return { w: v, h: Math.max(1, Math.round(h * v / w)) }; ||| if (mode === 'width') return { w: v, h: Math.max(1, Math.round(w * v / h)) };
resize: max long edge inverted ||| return Math.floor(Math.sqrt(maxPixels * long / short)); ||| return Math.floor(Math.sqrt(maxPixels * short / long));
resize: ignore the requested size ||| return createImageBitmap(src, { resizeWidth: W, resizeHeight: H, resizeQuality: 'high' }); ||| return createImageBitmap(src, { resizeWidth: W, resizeHeight: W, resizeQuality: 'high' });
pad: height uses ratio the wrong way ||| if (iw / ih >= R) return { W: iw, H: Math.max(ih, Math.round(iw / R)) }; ||| if (iw / ih >= R) return { W: iw, H: Math.max(ih, Math.round(iw * R)) };
pad: margin on one side only ||| const iw = w + 2 * margin, ih = h + 2 * margin; ||| const iw = w + margin, ih = h + 2 * margin;
pad: scale ignores the ceiling ||| if (W * H <= maxPixels) return 1; ||| if (W * H <= maxPixels * 4) return 1;
pad: offset not clamped ||| x: Math.round((W - w) * Math.min(1, Math.max(0, px))), ||| x: Math.round((W - w) * px),
pad: y offset reads px ||| y: Math.round((H - h) * Math.min(1, Math.max(0, py))), ||| y: Math.round((H - h) * Math.min(1, Math.max(0, px))),
pad: photo drawn transposed ||| if (k === 1) ctx.drawImage(src, o.x, o.y); ||| if (k === 1) ctx.drawImage(src, o.y, o.x);
pad: colour fill skipped ||| if (o.fill === 'colour') { ||| if (o.fill === 'transparent') {
pad: blur switched off ||| sctx.filter = 'blur(' + radius + 'px)'; ||| sctx.filter = 'none';
alpha: reads the red channel ||| for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true; ||| for (let i = 0; i < d.length; i += 4) if (d[i] !== 255) return true;
meta: keeps comments ||| if (m === 0xFE) return false; ||| if (m === 0xFE) return true;
meta: keeps every APP2 ||| if (m === 0xE2) return core.meta.ascii(seg, 4, 12) === 'ICC_PROFILE\0'; ||| if (m === 0xE2) return true;
meta: keeps EXIF and XMP ||| return false;                                                         // EXIF ||| return true;                                                         // EXIF
meta: keeps JFIF test loose ||| if (m === 0xE0) return core.meta.ascii(seg, 4, 5) === 'JFIF\0'; ||| if (m === 0xE0) return false;
meta: keeps data after EOI ||| if (m === 0xD9) { out.push(b.subarray(i, i + 2)); break; } ||| if (m === 0xD9) { out.push(b.subarray(i)); break; }
meta: drops the EOI marker ||| if (m === 0xD9) { out.push(b.subarray(i, i + 2)); break; } ||| if (m === 0xD9) { break; }
meta: PNG keeps text ||| core.meta.PNG_KEEP = ['IHDR', 'PLTE', ||| core.meta.PNG_KEEP = ['IHDR', 'tEXt', 'PLTE',
meta: WebP keeps the XMP flag ||| if (type === 'VP8X') chunk[8] &= ~(0x08 | 0x04); ||| if (type === 'VP8X') chunk[8] &= ~(0x08);
meta: WebP keeps XMP ||| core.meta.WEBP_KEEP = ['VP8 ', 'VP8L', 'VP8X', ||| core.meta.WEBP_KEEP = ['XMP ', 'VP8 ', 'VP8L', 'VP8X',
meta: WebP RIFF size wrong ||| const size = body.length + 4; ||| const size = body.length;
meta: GPS tag missed ||| if (u16(e) === 0x8825) return true; ||| if (u16(e) === 0x8824) return true;
history: one step short ||| while (this.stack.length > this.depth + 1) gone.push ||| while (this.stack.length > this.depth) gone.push
history: drops the original ||| gone.push(...this.stack.splice(1, 1)); ||| gone.push(...this.stack.splice(0, 1));
history: keeps part of the redo tail ||| const gone = this.stack.splice(this.index + 1); ||| const gone = this.stack.splice(this.index + 2);
history: releases a bitmap still in use ||| for (const e of gone) if (!this.stack.some((k) => k.bmp === e.bmp)) core.release(e.bmp); ||| for (const e of gone) core.release(e.bmp);
history: never releases a dropped bitmap ||| for (const e of gone) if (!this.stack.some((k) => k.bmp === e.bmp)) core.release(e.bmp); ||| for (const e of gone) if (!e.bmp) core.release(e.bmp);
history: a step forgets its text ||| this.stack.push({ bmp, texts, label, time: Date.now() }); ||| this.stack.push({ bmp, texts: [], label, time: Date.now() });
history: text always from the original ||| get texts() { return this.stack[this.index].texts; } ||| get texts() { return this.stack[0].texts; }
text: font weight dropped ||| return f.weight + ' ' + box.size + 'px "' + f.family + '"'; ||| return box.size + 'px "' + f.family + '"';
text: box width ignores the letters ||| const w = Math.max(box.size * 0.5, ...lines ||| const w = Math.min(box.size * 0.5, ...lines
text: box height is one line ||| return { lines, lh, w, h: lines.length * lh }; ||| return { lines, lh, w, h: lh };
text: line height ignores the font size ||| const lh = box.size * core.TEXT_LINE; ||| const lh = 20 * core.TEXT_LINE;
text: angle not wrapped ||| return a > Math.PI ? a - t : a; ||| return a;
text: to local frame sign ||| return { x: c * dx + s * dy, y: -s * dx + c * dy }; ||| return { x: c * dx - s * dy, y: -s * dx + c * dy };
text: to image frame sign ||| return { x: box.x + c * lx - s * ly, y: box.y + s * lx + c * ly }; ||| return { x: box.x + c * lx + s * ly, y: box.y + s * lx + c * ly };
text: hit test uses the width twice ||| return Math.abs(p.x) <= m.w / 2 + slack && Math.abs(p.y) <= m.h / 2 + slack; ||| return Math.abs(p.x) <= m.w / 2 + slack && Math.abs(p.y) <= m.w / 2 + slack;
text: hit test ignores the slack ||| return Math.abs(p.x) <= m.w / 2 + slack && ||| return Math.abs(p.x) <= m.w / 2 &&
text: pick takes the bottom box ||| for (let i = texts.length - 1; i >= 0; i--) { ||| for (let i = 0; i < texts.length; i++) {
text: pinch scale inverted ||| const k = Math.hypot(vx, vy) / (Math.hypot(ux, uy) || 1); ||| const k = Math.hypot(ux, uy) / (Math.hypot(vx, vy) || 1);
text: pinch turns the wrong way ||| const turn = Math.atan2(vy, vx) - Math.atan2(uy, ux); ||| const turn = Math.atan2(uy, ux) - Math.atan2(vy, vx);
text: pinch does not carry the centre round ||| return { ...box, x: a1.x + k * (c * rx - s * ry), ||| return { ...box, x: a1.x + k * rx,
text: pinch keeps the size ||| size: box.size * k, rotation: core.textAngle(box.rotation + turn) }; ||| size: box.size, rotation: core.textAngle(box.rotation + turn) };
text: right align drawn at the left ||| const ax = box.align === 'left' ? -m.w / 2 : box.align === 'right' ? m.w / 2 : 0; ||| const ax = box.align === 'left' ? -m.w / 2 : box.align === 'right' ? -m.w / 2 : 0;
text: left align drawn in the middle ||| const ax = box.align === 'left' ? -m.w / 2 : ||| const ax = box.align === 'left' ? 0 :
text: lines start half a line high ||| const ys = m.lines.map((l, i) => -m.h / 2 + m.lh * (i + 0.5)); ||| const ys = m.lines.map((l, i) => -m.h / 2 + m.lh * i);
text: outline half as thick ||| const outline = box.outline * box.size * 2; ||| const outline = box.outline * box.size;
text: outline painted over the letters ||| ctx.fillStyle = box.colour; ||| ctx.fillStyle = box.colour; ctx.globalCompositeOperation = 'destination-over';
text: outline in the letter colour ||| ctx.strokeStyle = box.outlineColour; ||| ctx.strokeStyle = box.colour;
text: shadow offset ignores the zoom ||| ctx.shadowOffsetX = (t0.a + t0.c) * d; ||| ctx.shadowOffsetX = d;
text: shadow falls upward ||| ctx.shadowOffsetY = (t0.b + t0.d) * d; ||| ctx.shadowOffsetY = -(t0.b + t0.d) * d;
text: shadow blur ignores the zoom ||| ctx.shadowBlur = sh.blur * box.size * zoom; ||| ctx.shadowBlur = sh.blur * box.size;
text: hard shadow too close ||| hard: { offset: 0.06, ||| hard: { offset: 0.03,
text: soft shadow not soft ||| soft: { offset: 0.04, blur: 0.12, ||| soft: { offset: 0.04, blur: 0,
text: shadow left on for the clean pass ||| ctx.shadowColor = 'rgba(0,0,0,0)'; ||| ctx.shadowColor = sh.colour;
text: export leaves the text out ||| core.drawTexts(ctx, texts); ||| /* removed */
text: only the first box drawn ||| for (const b of texts) core.drawText(ctx, b); ||| if (texts[0]) core.drawText(ctx, texts[0]);
crop frame: snapped centre off ||| return { W: s.W, H: s.H, cx: s.L + s.W / 2 - b.w / 2, ||| return { W: s.W, H: s.H, cx: s.L - b.w / 2,
crop text: quarter turn transposed ||| const x1 = fx * (q[0] * x0 + q[2] * y0), y1 = fy * (q[1] * x0 + q[3] * y0); ||| const x1 = fx * (q[0] * x0 + q[1] * y0), y1 = fy * (q[2] * x0 + q[3] * y0);
crop text: flips swapped ||| const fx = p.flipH ? -1 : 1, fy = p.flipV ? -1 : 1; ||| const fx = p.flipV ? -1 : 1, fy = p.flipH ? -1 : 1;
crop text: flip turns letters upside down ||| const turn = mirror ? p.theta - quarterTurn - b.rotation ||| const turn = mirror ? Math.PI + p.theta - quarterTurn - b.rotation
crop text: straighten not applied to the box ||| : p.theta + quarterTurn + b.rotation ||| : quarterTurn + b.rotation
crop text: double flip not a half turn ||| (p.flipH && p.flipV ? Math.PI : 0) ||| 0
crop text: straighten turns the position the wrong way ||| return { ...b, x: c * x1 - s * y1 + f.W / 2 - f.cx, ||| return { ...b, x: c * x1 + s * y1 + f.W / 2 - f.cx,
crop text: crop offset sign ||| y: s * x1 + c * y1 + f.H / 2 - f.cy, ||| y: s * x1 + c * y1 + f.H / 2 + f.cy,
resize text: y follows the width ||| ...b, x: b.x * W / w, y: b.y * H / h, ||| ...b, x: b.x * W / w, y: b.y * W / w,
resize text: size only follows the width ||| size: b.size * (W / w + H / h) / 2, ||| size: b.size * W / w,
pad text: offset not scaled ||| ...b, x: (b.x + o.x) * k, ||| ...b, x: b.x * k + o.x,
pad text: size not scaled ||| y: (b.y + o.y) * k, size: b.size * k, ||| y: (b.y + o.y) * k, size: b.size,
inside: height checked against the width ||| b.y >= 0 && b.y <= H); ||| b.y >= 0 && b.y <= W);
inside: keeps boxes off the left ||| texts.filter((b) => b.x >= 0 && ||| texts.filter((b) => b.x >= -1e9 &&
history: undo walks forward ||| undo() { if (this.canUndo) this.index--; return this.current; } ||| undo() { if (this.canUndo) this.index -= 2; if (this.index < 0) this.index = 0; return this.current; }
bg: person is the background ||| p[i] = Math.min(1, Math.max(0, 1 - bg[i])); ||| p[i] = Math.min(1, Math.max(0, bg[i]));
bg: person not clamped ||| p[i] = Math.min(1, Math.max(0, 1 - bg[i])); ||| p[i] = 1 - bg[i];
resample: pixel centres not lined up ||| const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5)); ||| const fx = Math.min(w - 1, Math.max(0, x * sx));
resample: ignores the row below ||| out[y * W + x] = top + (bot - top) * ty; ||| out[y * W + x] = top;
resample: x uses the y scale ||| const sx = w / W, sy = h / H; ||| const sx = h / H, sy = h / H;
box: border divided by the full window ||| a[o + x] = s / (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1); ||| a[o + x] = s / (2 * r + 1);
box: row sum starts one short ||| for (let x = 0; x < Math.min(r, w); x++) s += line[x]; ||| for (let x = 0; x < Math.min(r, w) - 1; x++) s += line[x];
box: column pass subtracts a blurred row ||| sum[x] -= ring[slot + x];   // row y - r - 1 ||| sum[x] -= a[(y - r - 1) * w + x];   // row y - r - 1
box: column count one short ||| const n = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1; ||| const n = Math.min(h - 1, y + r) - Math.max(0, y - r);
box: column pass skipped ||| for (let x = 0; x < w; x++) { ring[slot + x] = a[o + x]; a[o + x] = sum[x] / n; } ||| for (let x = 0; x < w; x++) { ring[slot + x] = a[o + x]; }
guided: no eps on red ||| const rr = mRR[i] - mR[i] * mR[i] + eps, ||| const rr = mRR[i] - mR[i] * mR[i],
guided: covariance forgets the means ||| const cR = mRp[i] - mR[i] * mP[i], ||| const cR = mRp[i],
guided: cofactor sign ||| i12 = rg * rb - rr * gb, ||| i12 = rr * gb - rg * rb,
guided: offset ignores the colour ||| b[i] = mP[i] - ar[i] * mR[i] - ag[i] * mG[i] - ab[i] * mB[i]; ||| b[i] = mP[i] - ar[i] * mR[i];
guided: coefficients not smoothed ||| return { ar: core.boxMean(ar, w, h, r), ag: core.boxMean(ag, w, h, r), ab: core.boxMean(ab, w, h, r), b: core.boxMean(b, w, h, r) }; ||| return { ar, ag, ab, b };
guided: product of the wrong channels ||| mRG = mean(R, G), ||| mRG = mean(R, B),
ramp: linear, not smooth ||| return t * t * (3 - 2 * t); ||| return t;
ramp: haze kept ||| core.BG_EDGE_LO = 0.2; ||| core.BG_EDGE_LO = 0.05;
guide: half the size ||| core.BG_GUIDE_LONG = 1024; ||| core.BG_GUIDE_LONG = 512;
guide: small photos enlarged ||| const k = Math.min(1, core.BG_GUIDE_LONG / Math.max(w, h)); ||| const k = core.BG_GUIDE_LONG / Math.max(w, h);
guide: one pass only ||| core.BG_GUIDE_PASSES = 2; ||| core.BG_GUIDE_PASSES = 1;
guide: window too small ||| core.BG_GUIDE_RADIUS = 0.024; ||| core.BG_GUIDE_RADIUS = 0.008;
guide: second pass ignores the first ||| if (m) { p = new Float32Array(n); core.guidedApply(d, w, h, 0, h, m, p); } ||| if (m) { core.guidedApply(d, w, h, 0, h, m, new Float32Array(n)); }
guide: coverage is a sum ||| return { ...m, coverage: sum / n, found: hit / n }; ||| return { ...m, coverage: sum / 1000, found: hit / n };
guide: found counts the haze ||| if (p[i] >= core.BG_FOUND) hit++; ||| hit += p[i];
guide: an even chance not found ||| if (p[i] >= core.BG_FOUND) hit++; ||| if (p[i] > core.BG_FOUND) hit++;
guide: found threshold lowered ||| core.BG_FOUND = 0.5; ||| core.BG_FOUND = 0.05;
key: border read at the very edge ||| const r = Math.min(Math.max(2, Math.round(core.KEY_INSET * Math.min(w, h))), ||| const r = Math.min(Math.max(0, Math.round(core.KEY_INSET * Math.min(w, h))),
key: no second median ||| const rgb = [med(close, 0), med(close, 1), med(close, 2)]; ||| const rgb = [d[close[0]], d[close[0] + 1], d[close[0] + 2]];
key: busiest bin only ||| core.KEY_BINS = 8; ||| core.KEY_BINS = 1;
key: flat test too loose ||| core.KEY_FLAT = 8; ||| core.KEY_FLAT = 40;
key: plain share too low ||| core.KEY_SHARE = 0.6; ||| core.KEY_SHARE = 0.1;
key: ramp starts at zero ||| core.KEY_IN = 30; ||| core.KEY_IN = 0;
key: flat fill keeps its holes ||| if (key.flat) for (let i = 0; i < n; i++) if (!seen[i] ||| if (false) for (let i = 0; i < n; i++) if (!seen[i]
key: walk ignores the bottom row ||| for (let x = 0; x < w; x++) { visit(x); visit((h - 1) * w + x); } ||| for (let x = 0; x < w; x++) { visit(x); }
key: walk goes through the subject ||| if (s >= limit) return; ||| if (s >= limit * 4) return;
key: flat walk as loose as a photo's ||| const limit = key.flat ? core.KEY_MATCH : core.KEY_OUT; ||| const limit = core.KEY_OUT;
key: photo border share as low as a flat fill's ||| core.KEY_SHARE_PHOTO = 0.8; ||| core.KEY_SHARE_PHOTO = 0.6;
key: empty picture still keyed ||| if (hit / n < core.KEY_MIN_KEEP) return null; ||| if (hit / n < 0) return null;
head: body skin counts as a head ||| if (conf[1][i] + conf[3][i] >= core.BG_FOUND) k++; ||| if (conf[1][i] + conf[2][i] + conf[3][i] >= core.BG_FOUND) k++;
head: hair does not count ||| if (conf[1][i] + conf[3][i] >= core.BG_FOUND) k++; ||| if (conf[3][i] >= core.BG_FOUND) k++;
mark: point is the bare centre ||| if (dd < bd && p.data[y * p.w + x] >= core.BG_FOUND) { bd = dd; ||| if (dd < bd) { bd = dd;
mark: x and y swapped ||| best = { x: (x + 0.5) / p.w, y: (y + 0.5) / p.h }; ||| best = { x: (y + 0.5) / p.h, y: (x + 0.5) / p.w };
mark: point off by half a cell ||| best = { x: (x + 0.5) / p.w, y: (y + 0.5) / p.h }; ||| best = { x: x / p.w, y: (y + 0.5) / p.h };
cut: no unmixing ||| if (al > 0 && al < 1) for (let c = 0; c < 3; c++) out[o + c] = K[c] + (d[o + c] - K[c]) / al; ||| if (false) out[o] = 0;
cut: blend alpha not projected ||| if (Math.hypot(cr - t * sr, cg - t * sg, cb - t * sb) <= core.KEY_LINE) al = Math.min(1, Math.max(0, t)); ||| if (false) al = t;
cut: any pixel counts as a blend ||| if (Math.hypot(cr - t * sr, cg - t * sg, cb - t * sb) <= core.KEY_LINE) al ||| if (true) al
cut: subject colour is the nearest, not the strongest ||| if (dist[j] > dist[best]) best = j; ||| if (dist[j] < dist[best]) best = j;
apply: half-pixel shift ||| const f = Math.min(m.w - 1, Math.max(0, (x + 0.5) * sx - 0.5)); ||| const f = Math.min(m.w - 1, Math.max(0, x * sx));
apply: strips overwrite the top ||| out[(y0 + j) * W + x] = core.bgCurve(q); ||| out[j * W + x] = core.bgCurve(q);
apply: green read as red ||| (ag[i00] * w00 + ag[i01] * w01 + ag[i10] * w10 + ag[i11] * w11) * data[o + 1] + ||| (ag[i00] * w00 + ag[i01] * w01 + ag[i10] * w10 + ag[i11] * w11) * data[o] +
apply: ramp skipped ||| out[(y0 + j) * W + x] = core.bgCurve(q); ||| out[(y0 + j) * W + x] = q;
feather: radius from the short side ||| const r = Math.round(f * Math.max(W, H) / 2); ||| const r = Math.round(f * Math.min(W, H) / 2);
feather: one pass ||| if (r > 0) { core.boxMean(a, W, H, r); core.boxMean(a, W, H, r); } ||| if (r > 0) { core.boxMean(a, W, H, r); }
brush: bounds miss the radius ||| x1: Math.min(W, Math.ceil(x1 * k + r)), ||| x1: Math.min(W, Math.ceil(x1 * k)),
brush: bounds ignore the scale ||| return { x0: Math.max(0, Math.floor(x0 * k - r)), ||| return { x0: Math.max(0, Math.floor(x0 - r)),
brush: hard edge ||| const r = st.r * k, inner = r * (1 - core.BRUSH_SOFT); ||| const r = st.r * k, inner = r;
brush: radius not scaled ||| const r = st.r * k, inner = r * (1 - core.BRUSH_SOFT); ||| const r = st.r, inner = r * (1 - core.BRUSH_SOFT);
brush: segments run past their ends ||| const t = L2 ? Math.min(1, Math.max(0, (px * dx + py * dy) / L2)) : 0; ||| const t = L2 ? (px * dx + py * dy) / L2 : 0;
brush: overlaps add up ||| if (c > cov[i]) cov[i] = c; ||| cov[i] = Math.min(1, cov[i] + c);
brush: keep replaces instead of blending ||| a[i] = keep ? a[i] + (1 - a[i]) * c : a[i] * (1 - c); ||| a[i] = keep ? c : a[i] * (1 - c);
brush: erase the wrong way ||| a[i] = keep ? a[i] + (1 - a[i]) * c : a[i] * (1 - c); ||| a[i] = keep ? a[i] + (1 - a[i]) * c : a[i] * c;
brush: a tap paints nothing ||| for (let s = 0; s < Math.max(1, pts.length - 1); s++) { ||| for (let s = 0; s < pts.length - 1; s++) {
brush: only the first stroke ||| for (const st of strokes) core.paintStroke(a, W, H, st, k); return a; ||| if (strokes[0]) core.paintStroke(a, W, H, strokes[0], k); return a;
putAlpha: box offset dropped ||| d[o + 3] = a[(y + j) * W + bx.x0 + x] * 255; ||| d[o + 3] = a[(y + j) * W + x] * 255;
putAlpha: strips stack at the top ||| ctx.putImageData(img, bx.x0, y); ||| ctx.putImageData(img, bx.x0, bx.y0);
cutout: veil left off ||| ctx.drawImage(src, 0, 0, W, H); ctx.fillStyle = core.BG_VEIL; ||| ctx.drawImage(src, 0, 0, W, H); ctx.fillStyle = 'rgba(0,0,0,0)';
cutout: mask not applied ||| fctx.globalCompositeOperation = 'source-in'; ||| fctx.globalCompositeOperation = 'source-over';
cutout: backdrop skipped ||| core.drawBackdrop(ctx, src, W, H, o); ||| /* removed */
cutout: blur backdrop is black ||| case 'blur': core.drawBlurCover(ctx, src, W, H, o.blur); break; ||| case 'blur': ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); break;
cutout: colour backdrop left out ||| case 'colour': ctx.fillStyle = o.colour; ctx.fillRect(0, 0, W, H); break; ||| case 'colour': break;
skin: face size ignores the face ||| const share = faceShare >= core.SKIN_MIN_FACE ? faceShare : skinShare; ||| const share = skinShare;
skin: face size floor off ||| return Math.max(Math.sqrt(share * W * H), 0.1 * Math.min(W, H)); ||| return Math.sqrt(share * W * H);
skin: radius not scaled ||| r: Math.max(1, Math.round(core.SKIN_RADIUS * faceSize * k)), ||| r: Math.max(1, Math.round(core.SKIN_RADIUS * faceSize)),
skin: grain radius from the window ||| g: Math.max(1, Math.round(core.SKIN_GRAIN * faceSize * k)), ||| g: Math.max(1, Math.round(core.SKIN_RADIUS * faceSize * k)),
skin: window too small ||| core.SKIN_RADIUS = 0.024; ||| core.SKIN_RADIUS = 0.008;
skin: eps too small ||| core.SKIN_EPS = 0.004; ||| core.SKIN_EPS = 0.0004;
skin: eps too big ||| core.SKIN_EPS = 0.004; ||| core.SKIN_EPS = 0.04;
skin: body skin left out ||| p[i] = Math.min(1, Math.max(0, body[i] + face[i])); ||| p[i] = Math.min(1, Math.max(0, face[i]));
skin: filter keeps nothing ||| const v = m2[i] - mI[i] * mI[i], a = v / (v + eps); ||| const v = m2[i] - mI[i] * mI[i], a = 0;
skin: filter variance wrong ||| const v = m2[i] - mI[i] * mI[i], a = v / (v + eps); ||| const v = m2[i], a = v / (v + eps);
skin: filter b ignores a ||| m2[i] = a; mI[i] = mI[i] - a * mI[i]; ||| m2[i] = a;
skin: filter a and b not smoothed ||| core.boxMean(m2, w, h, r); core.boxMean(mI, w, h, r); ||| /* removed */
skin: filter output uses the mean ||| for (let i = 0; i < n; i++) out[i] = m2[i] * I[i] + mI[i]; ||| for (let i = 0; i < n; i++) out[i] = mI[i];
skin: grain is the whole difference ||| for (let i = 0; i < n; i++) E[i] -= low[i]; ||| /* removed */
skin: grain from the original, not the difference ||| for (let i = 0; i < n; i++) E[i] = I[i] - Sc[i]; ||| for (let i = 0; i < n; i++) E[i] = I[i];
skin: green channel read as red ||| for (let i = 0; i < n; i++) I[i] = d[4 * i + c] / 255; ||| for (let i = 0; i < n; i++) I[i] = d[4 * i] / 255;
skin: mix ignores alpha ||| const i = y * w + x, m = o.strength * (a ? a[(y + ay) * aW + x + ax] : 1); ||| const i = y * w + x, m = o.strength;
skin: mix alpha offset dropped ||| const i = y * w + x, m = o.strength * (a ? a[(y + ay) * aW + x + ax] : 1); ||| const i = y * w + x, m = o.strength * (a ? a[y * aW + x] : 1);
skin: texture ignored ||| d[4 * i + c] = (I + m * (f.S[c][i] + o.texture * f.D[c][i] - I)) * 255; ||| d[4 * i + c] = (I + m * (f.S[c][i] - I)) * 255;
skin: strength ignored ||| d[4 * i + c] = (I + m * (f.S[c][i] + o.texture * f.D[c][i] - I)) * 255; ||| d[4 * i + c] = (f.S[c][i] + o.texture * f.D[c][i]) * 255;
bounds: x end exclusive missed ||| return { x0: Math.max(0, x0 - m), y0: Math.max(0, y0 - m), x1: Math.min(W, x1 + 1 + m), ||| return { x0: Math.max(0, x0 - m), y0: Math.max(0, y0 - m), x1: Math.min(W, x1 + m),
bounds: margin ignored ||| return { x0: Math.max(0, x0 - m), y0: ||| return { x0: Math.max(0, x0), y0:
smooth: tile margin too small ||| const m = 2 * o.r + o.g, T = core.SKIN_TILE; ||| const m = o.r, T = core.SKIN_TILE;
smooth: tiles written as they go ||| for (const { img, t, r } of done) ctx.putImageData(img, r.x0, r.y0, t.x0 - r.x0, t.y0 - r.y0, t.x1 - t.x0, t.y1 - t.y0); ||| for (const { img, t, r } of done) ctx.putImageData(img, r.x0, r.y0);
spot: neighbourhood too small ||| core.SPOT_EPS = 5; ||| core.SPOT_EPS = 1;
spot: eikonal one axis only ||| return (a + b + Math.sqrt(2 - (a - b) * (a - b))) / 2; ||| return Math.min(a, b) + 1;
spot: eikonal step too big ||| if (Math.abs(a - b) >= 1) return Math.min(a, b) + 1; ||| if (Math.abs(a - b) >= 1) return Math.min(a, b) + 2;
spot: direction ignored ||| const dir = Math.max(1e-6, Math.abs(dx * gx + dy * gy) / len); ||| const dir = 1;
spot: distance ignored ||| const wt = dir / r2; ||| const wt = dir;
heap: pops the largest ||| if (l < hi.length && hk[l] < hk[m]) m = l; ||| if (l < hi.length && hk[l] > hk[m]) m = l;
heap: push never sifts ||| while (c > 0) { const p = (c - 1) >> 1; if (hk[p] <= hk[c]) break; ||| while (c > 0) { const p = (c - 1) >> 1; if (true) break;
heap: right child never checked ||| if (r < hi.length && hk[r] < hk[m]) m = r; ||| /* removed */
spot: no front ||| flag[i] = BAND; push(i, 0); ||| flag[i] = BAND;
spot: no slope carried ||| const at = (c) => d[4 * q + c] + S[6 * q + 2 * c] * dx + S[6 * q + 2 * c + 1] * dy; ||| const at = (c) => d[4 * q + c];
spot: slope sign ||| const at = (c) => d[4 * q + c] + S[6 * q + 2 * c] * dx + ||| const at = (c) => d[4 * q + c] - S[6 * q + 2 * c] * dx +
spot: slope not shrunk ||| S[6 * q + j] = m * m * m / (m * m + scatter + 1e-9); ||| S[6 * q + j] = m;
heal: off, always the fallback ||| const src = core.healSource(d, w, h, mask, half); ||| const src = null;
heal: rim not compared ||| for (const i of rimS) { const v = d[4 * i + c] - d[4 * (i + off) + c]; s1 += v; s2 += v * v; } ||| /* removed */
heal: colour offset not allowed for ||| score += s2 / rimS.length - (s1 / rimS.length) ** 2; ||| score += s2 / rimS.length;
heal: marks in the source ignored ||| score += 2 * (mi / spotS.length - mr / rimS.length) ** 2; ||| score += 0;
heal: source may hang off the block ||| if (bx0 + dx < 0 || bx1 + dx >= w || by0 + dy < 0 || by1 + dy >= h) return Infinity; ||| /* removed */
heal: band too far ||| core.SPOT_HEAL_DIST = [1.3, 2.5]; ||| core.SPOT_HEAL_DIST = [3, 4];
heal: grid not refined ||| if (step > 1) { ||| if (false) {
heal: no membrane ||| core.membrane(hm, w, h, mask); ||| /* removed */
heal: copy from the wrong side ||| for (let i = 0; i < w * h; i++) if (mask[i]) for (let c = 0; c < 3; c++) d[4 * i + c] = d[4 * (i + off) + c] + hm[3 * i + c]; ||| for (let i = 0; i < w * h; i++) if (mask[i]) for (let c = 0; c < 3; c++) d[4 * i + c] = d[4 * (i - off) + c] + hm[3 * i + c];
membrane: three neighbours ||| const avg = sum / nb.length; ||| const avg = sum / 3;
membrane: stops too early ||| if (moved < 0.02) break; ||| if (moved < 50) break;
spot: writes back the wrong block ||| ctx.putImageData(img, x0, y0, ux0 - x0, uy0 - y0, ux1 - ux0, uy1 - uy0); ||| ctx.putImageData(img, x0, y0, 0, 0, ux1 - ux0, uy1 - uy0);
spot: slope window ignored ||| core.SPOT_SLOPE = 2; ||| core.SPOT_SLOPE = 0;
spot: filled pixels carry no slope ||| for (let k = 0; k < 6; k++) S[6 * i + k] = sl[k] / ws; ||| /* removed */
spot: fill not bounded ||| for (let c = 0; c < 3; c++) d[4 * i + c] = Math.min(maxC[c], Math.max(minC[c], v[c])); ||| for (let c = 0; c < 3; c++) d[4 * i + c] = v[c];
spot: bounds from one pixel ||| for (let c = 0; c < 3; c++) { minC[c] = Math.min(minC[c], d[4 * i + c]); maxC[c] = Math.max(maxC[c], d[4 * i + c]); } ||| for (let c = 0; c < 3; c++) { minC[c] = d[4 * i + c]; maxC[c] = d[4 * i + c]; }
spot: slope reads the spot ||| const l = lo && flag[q - step] !== INSIDE, r = hiN && flag[q + step] !== INSIDE; ||| const l = lo, r = hiN;
spot: ring too thin ||| core.SPOT_RING = 4; ||| core.SPOT_RING = 0;
spot: grain is the mean, not the median ||| return a[a.length >> 1] * 1.4826 * Math.sqrt(9 / 8); ||| return a.reduce((p, q) => p + q, 0) / a.length * 1.4826 * Math.sqrt(9 / 8);
spot: grain not scaled up ||| return a[a.length >> 1] * 1.4826 * Math.sqrt(9 / 8); ||| return a[a.length >> 1];
spot: grain left out ||| for (let c = 0; c < 3; c++) d[4 * i + c] += z * grain[c]; ||| /* removed */
spot: noise all one value ||| return (s - 1.5) * 2; ||| return 0.5;
spot: block margin too small ||| const m = Math.ceil(core.SPOT_HEAL_DIST[core.SPOT_HEAL_DIST.length - 1] * half + 2 * core.SPOT_HEAL_RING) + core.SPOT_EPS + core.SPOT_RING + 2; ||| const m = 2;
spot: mask from the wrong place ||| pts: st.pts.map((p) => ({ x: p.x - x0, y: p.y - y0 })) ||| pts: st.pts
video: keyframe before misses an exact hit ||| if (x <= t + core.video.EPS) k = x; else break; ||| if (x < t - core.video.EPS) k = x; else break;
video: keyframe gap is the smallest, not the median ||| return gaps[Math.floor(gaps.length / 2)]; ||| return gaps[0];
video: keyframe gap with one keyframe ||| if (keys.length < 2) return null; ||| if (keys.length < 1) return null;
video: frame snap picks the farthest edge ||| const g = Math.abs(s - t); if (g < gap) { best = s; gap = g; } ||| const g = Math.abs(s - t); if (g > gap) { best = s; gap = g; }
video: trim with no keyframes ||| if (!keys.length) return null; ||| if (!keys) return null;
video: trim keeps the frame at the end ||| if (packets[i].ts < end - E) last = i; ||| if (packets[i].ts <= end + E) last = i;
video: trim keeps leading pictures ||| if (p.ts < from - E) continue; ||| if (p.ts < from - 1) continue;
video: trim end forgets the last frame's length ||| to = Math.max(to, p.ts + p.dur); ||| to = Math.max(to, p.ts);
video: trim says moved on a keyframe ||| moved: from < start - E, ||| moved: from <= start,
video: trim never whole ||| whole: from <= keys[0] + E ||| whole: from < keys[0] - E
video: sound keeps the packet at the end ||| if (p.ts >= plan.to - E) continue; ||| if (p.ts > plan.to) continue;
video: sound drops the packet across the start ||| if (!plan.whole && p.ts + p.dur <= plan.from + E) continue; ||| if (!plan.whole && p.ts <= plan.from) continue;
video: sound drops the run-in when untrimmed ||| if (!plan.whole && p.ts + p.dur <= plan.from + E) continue; ||| if (p.ts + p.dur <= plan.from + E) continue;
video: write order breaks ties the other way ||| if (j >= b.length || (i < a.length && a[i] <= b[j])) out.push([0, i++]); ||| if (j >= b.length || (i < a.length && a[i] < b[j])) out.push([0, i++]);
video: write order drops the second track ||| else out.push([1, j++]); ||| else j++;
video: bit depth misses High 4:2:2 and 4:4:4 ||| return [110, 122, 244].includes(profile) ? 10 : 8; ||| return [110].includes(profile) ? 10 : 8;
video: bit depth reads the profile as decimal ||| const profile = parseInt(f[1].slice(0, 2), 16); ||| const profile = parseInt(f[1].slice(0, 2), 10);
video: bit depth guesses unknown HEVC profiles ||| return profile === 1 ? 8 : profile === 2 ? 10 : null; ||| return profile === 1 ? 8 : 10;
video: bit depth trips on the HEVC profile space ||| const profile = parseInt(f[1].replace(/^[A-C]/, ''), 10); ||| const profile = parseInt(f[1], 10);
video: VP9 bit depth from the level ||| if (f[0] === 'vp09' && f[3]) return parseInt(f[3], 10); ||| if (f[0] === 'vp09' && f[3]) return parseInt(f[2], 10);
video: AV1 bit depth from the level ||| if (f[0] === 'av01' && f[3]) return parseInt(f[3], 10); ||| if (f[0] === 'av01' && f[3]) return parseInt(f[2], 10);
video: HDR names swapped ||| (cs && cs.transfer === 'pq' ? 'PQ' : cs && cs.transfer === 'hlg' ? 'HLG' : null) ||| (cs && cs.transfer === 'pq' ? 'HLG' : cs && cs.transfer === 'hlg' ? 'PQ' : null)
video: time truncates instead of rounding ||| const cs = Math.max(0, Math.round(s * 100)); ||| const cs = Math.max(0, Math.floor(s * 100));
video: minutes run past 59 ||| m = Math.floor(cs / 6000) % 60, ||| m = Math.floor(cs / 6000),
video: video name test not anchored ||| core.video.VIDEO_EXT = /\.(mp4|m4v|mov|3gp|3g2|webm|mkv)$/i; ||| core.video.VIDEO_EXT = /\.(mp4|m4v|mov|3gp|3g2|webm|mkv)/i;
video: describe drops the HDR curve ||| parts.push((info.bitDepth ? info.bitDepth + '-bit ' : '') + (hdr ? 'HDR ' + hdr : 'SDR')); ||| parts.push((info.bitDepth ? info.bitDepth + '-bit ' : '') + (hdr ? 'HDR' : 'SDR'));
video: history keeps part of the redo tail |||   this.stack.splice(this.index + 1); |||   this.stack.splice(this.index + 2);
video: history step forgets the rest of the recipe ||| this.stack.push({ ...this.current, ...recipe, label }); ||| this.stack.push({ ...recipe, label });
video: history original is the current step ||| get original() { return this.stack[0]; } ||| get original() { return this.stack[this.index]; }
video: history undo walks forward ||| undo() { if (this.canUndo) this.index -= 1; return this.current; } ||| undo() { if (this.canUndo) this.index += 1; return this.current; }
video: dates zeroed only half way in version 1 ||| b.fill(0, x.body + 4, x.body + 4 + (wide ? 16 : 8)); ||| b.fill(0, x.body + 4, x.body + 4 + (wide ? 8 : 8));
video: dates zeroed nowhere ||| walk(0, b.length); ||| walk(0, 0);
video: dates zeroed only at the top ||| walk(x.body, x.end);   // the headers sit inside moov, trak and mdia ||| void x;   // the headers sit inside moov, trak and mdia
video: finder allows a top-level uuid ||| const found = top.filter((t) => !['ftyp', 'moov', 'mdat', 'free', 'skip'].includes(t)) ||| const found = top.filter((t) => !['ftyp', 'moov', 'mdat', 'free', 'skip', 'uuid'].includes(t))
video: finder misses udta ||| if (['udta', 'meta', 'uuid', 'ilst'].includes(x.type)) found.push(x.type + ' box'); ||| if (['meta', 'uuid', 'ilst'].includes(x.type)) found.push(x.type + ' box');
video: finder reads the dates from the wrong place ||| if (moov.subarray(x.body + 4, x.body + 4 + (wide ? 16 : 8)).some((v) => v)) ||| if (moov.subarray(x.body + 12, x.body + 12 + (wide ? 16 : 8)).some((v) => v))
video: finder misses the GPS tag ||| if (text.includes('\xA9xyz')) found.push('GPS location'); ||| if (text.includes('\xA9xyz ')) found.push('GPS location');
video: check verdict ignores a failed trial ||| core.video.verdict = (r) => (!r.supported ? 'fail' : r.error ? 'watch' : 'pass'); ||| core.video.verdict = (r) => (!r.supported ? 'fail' : 'pass');
video: check text shows raw fps ||| ' frames at ' + Math.round(r.ran.fps) + ' fps'; ||| ' frames at ' + r.ran.fps + ' fps';
video: check report trips on a missing row ||| if (!r) continue; ||| if (!r && false) continue;
video: check asks 4K 60 at the 4K 30 level ||| config: { codec: 'avc1.640034', width: 3840, height: 2160, framerate: 60, bitrate: 60e6 } ||| config: { codec: 'avc1.640033', width: 3840, height: 2160, framerate: 60, bitrate: 60e6 }
video: rate snap takes the first near rate, not the nearest ||| if (Math.abs(fps - r) <= r * 0.005 && (best === null || Math.abs(fps - r) < Math.abs(fps - best))) best = r; ||| if (Math.abs(fps - r) <= r * 0.005 && best === null) best = r;
video: rate snap too loose ||| if (Math.abs(fps - r) <= r * 0.005 && (best ||| if (Math.abs(fps - r) <= r * 0.05 && (best
video: rate kept unrounded ||| return best ?? Math.round(fps * 100) / 100; ||| return best ?? fps;
video: join ignores the size ||| else if (b.width !== a.width || b.height !== a.height) why.push ||| else if (b.width !== a.width) why.push
video: join ignores the frame rate ||| else if (b.rate !== a.rate) why.push ||| else if (false) why.push
video: join ignores HDR ||| else if (b.hdr !== a.hdr) why.push ||| else if (false) why.push
video: join ignores the turn ||| else if (b.rotation !== a.rotation || b.setup !== a.setup) why.push ||| else if (b.setup !== a.setup) why.push
video: join copies what MP4 cannot hold ||| if (!a.mp4) why.push(a.name ||| if (false) why.push(a.name
video: sound copied with a silent clip ||| if (!s.codec) why.push(s.name + ' has no sound'); ||| if (!s.codec) continue;
video: sound kept when removed ||| if (!keep || !a) return { mode: 'none', why: [] }; ||| if (!a) return { mode: 'none', why: [] };
video: sound setups not compared ||| else if (s.setup !== a.setup) why.push ||| else if (s.codec !== a.codec) why.push
video: join offsets start after the piece ||| const at = plans.map((p) => { const o = t; t += p.to - p.from; return o; }); ||| const at = plans.map((p) => { t += p.to - p.from; return t; });
video: frame grid drops the last part frame ||| const n = Math.max(1, Math.ceil((p.end - p.start) * rate - 1e-3)); ||| const n = Math.max(1, Math.floor((p.end - p.start) * rate));
video: frame grid lets a sliver vanish ||| const n = Math.max(1, Math.ceil( ||| const n = Math.max(0, Math.ceil(
video: frame grid piece end ignores the rate ||| return { from: p.start, to: p.start + n / rate, ||| return { from: p.start, to: p.end,
video: join sound overlap never dropped ||| if (end - t > p.dur / 2) return null; ||| if (false) return null;
video: join sound overlap always dropped ||| if (end - t > p.dur / 2) return null; ||| return null;
video: join sound time goes back ||| t = end; ||| void end;
video: resampler loses its place between chunks ||| pos = Math.max(0, pos + k * step - n); ||| pos = 1;
video: resampler interpolates the wrong way ||| res[c][j] = src[c][i] + (src[c][i + 1] - src[c][i]) * f; ||| res[c][j] = src[c][i + 1] + (src[c][i] - src[c][i + 1]) * f;
video: resampler mixes down without dividing ||| m[i] += p[i] / planes.length; ||| m[i] += p[i];
video: resampler rate upside down ||| const step = fromRate / toRate; ||| const step = toRate / fromRate;
video: bitrate cap missing ||| Math.round(Math.min(60e6, Math.max(2e6, ||| Math.round(Math.min(600e6, Math.max(2e6,
video: piece at gives the next piece at a join ||| if (t < o + len - core.video.EPS || i === pieces.length - 1) ||| if (t <= o + len + core.video.EPS || i === pieces.length - 1)
video: piece at runs past the end ||| at: pieces[i].start + Math.min(len, Math.max(0, t - o)) ||| at: pieces[i].start + Math.max(0, t - o)
video: time of counts the piece itself ||| for (let k = 0; k < i; k++) o += pieces[k].end - pieces[k].start; ||| for (let k = 0; k <= i; k++) o += pieces[k].end - pieces[k].start;
video: split at the playhead, not a keyframe ||| return [...pieces.slice(0, i), { ...p, end: k }, { ...p, start: k }, ||| return [...pieces.slice(0, i), { ...p, end: t }, { ...p, start: k },
video: split at the piece start ||| if (k <= p.start + E || k >= p.end - E) return null; ||| if (k < p.start - E || k >= p.end - E) return null;
video: split drops the pieces after ||| { ...p, start: k }, ...pieces.slice(i + 1)]; ||| { ...p, start: k }];
EOF
)

# Build one mutant file. Exit 3 if the pattern is not found exactly once.
make_mutant() {
  node -e '
    const fs = require("fs");
    const [src, out, from, to] = process.argv.slice(1);
    const s = fs.readFileSync(src, "utf8");
    const a = s.indexOf("// CORE:BEGIN"), b = s.indexOf("// CORE:END");
    if (a < 0 || b < 0) { console.error("CORE markers missing"); process.exit(3); }
    const core = s.slice(a, b);
    const n = core.split(from).length - 1;
    if (n !== 1) { console.error("pattern found " + n + " times in CORE: " + from); process.exit(3); }
    fs.writeFileSync(out, s.slice(0, a) + core.replace(from, () => to) + s.slice(b));
  ' retouch.html "$1" "$2" "$3"
}

run_one() {
  local idx="$1" line="$2"
  local name="${line%% ||| *}" rest="${line#* ||| }"
  local from="${rest%% ||| *}" to="${rest#* ||| }"
  local dir="$WORK/$idx"; mkdir -p "$dir"
  if ! make_mutant "$dir/retouch.html" "$from" "$to" 2>"$dir/err"; then
    echo "BROKEN   $name: $(cat "$dir/err")"; return
  fi
  if RETOUCH_HTML="$dir/retouch.html" RETOUCH_ONLY=core node retouch_behave.cjs >"$dir/log" 2>&1; then
    echo "SURVIVED $name"
  else
    echo "KILLED   $name"
  fi
}
export -f run_one make_mutant
export WORK

echo "Baseline: core tests on the unmodified file"
if ! RETOUCH_ONLY=core node retouch_behave.cjs >"$WORK/baseline" 2>&1; then
  cat "$WORK/baseline"; echo "Baseline fails; fix the suite before mutating."; exit 1
fi

total=$(printf '%s\n' "$MUTANTS" | grep -c '|||')
echo "Running $total mutants, $JOBS at a time"
RESULTS="$WORK/results"
i=0
printf '%s\n' "$MUTANTS" | while IFS= read -r line; do
  [ -z "$line" ] && continue
  i=$((i + 1))
  printf '%s\0%s\0' "$i" "$line"
done | xargs -0 -n 2 -P "$JOBS" bash -c 'run_one "$0" "$1"' | tee "$RESULTS"

killed=$(grep -c '^KILLED' "$RESULTS")
survived=$(grep -c '^SURVIVED' "$RESULTS")
broken=$(grep -c '^BROKEN' "$RESULTS")
echo
echo "retouch_mutate: $killed killed, $survived survived, $broken broken (of $total)"
[ "$survived" -eq 0 ] && [ "$broken" -eq 0 ]
