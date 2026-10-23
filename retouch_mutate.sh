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
# Run: bash retouch_mutate.sh          (about 10 to 15 minutes)
#      JOBS=4 bash retouch_mutate.sh   (run four mutants at a time)

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
guide: coverage is a sum ||| return { ...m, coverage: sum / n }; ||| return { ...m, coverage: sum / 1000 };
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
