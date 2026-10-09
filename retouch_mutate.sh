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
# Run: bash retouch_mutate.sh          (about 5 to 10 minutes)
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
history: one step short ||| while (this.stack.length > this.depth + 1) { ||| while (this.stack.length > this.depth) {
history: drops the original ||| const [old] = this.stack.splice(1, 1); ||| const [old] = this.stack.splice(0, 1);
history: keeps part of the redo tail ||| for (const e of this.stack.splice(this.index + 1)) core.release(e.bmp); ||| for (const e of this.stack.splice(this.index + 2)) core.release(e.bmp);
history: undo walks forward ||| undo() { if (this.canUndo) this.index--; return this.current; } ||| undo() { if (this.canUndo) this.index -= 2; if (this.index < 0) this.index = 0; return this.current; }
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
