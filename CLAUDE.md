# CLAUDE.md: retouch

## What this is
retouch is Gary's personal photo editor for his Pixel 9 Pro XL, installed as a PWA from GitHub Pages (jeuron-hue/retouch, public). Private working tool, not a portfolio piece. Most edits are photos of people. The 4:5 and 1080 presets are just handy sizes; Gary does not post to Instagram.

## Hard rule: photos never leave the phone
- All image processing runs on the device, in the browser. No uploads, no cloud APIs, no analytics, no telemetry.
- Enforce it, don't just promise it: a Content-Security-Policy meta tag with connect-src 'self', and a test that fails if the code contains fetch/XHR/WebSocket/sendBeacon to any other origin.
- No libraries, models or fonts from CDNs. Vendor everything into the repo so the app works fully offline after first load.
- No real photos of people in the repo. Test images that need a real person live in reference/test-images/ (gitignored). Tests that need them skip cleanly when the folder is absent.
- Every image committed to the repo (icons, synthetic fixtures) must carry no EXIF/XMP/GPS. A test checks this.

## Architecture
- Vanilla JS and CSS. No framework, no build step, no bundler, no server.
- retouch.html holds the whole app. Allowed extra files, and only these: manifest.webmanifest, sw.js, icons/, vendor/ (MediaPipe wasm and model, fonts), and index.html as a no-script redirect stub so jeuron-hue.github.io/retouch/ opens the app. This is the minimum a PWA needs; do not split the app logic into more files. Test tooling (package.json pinning Playwright, the three test files) sits beside it; retouch_checks.cjs enforces the allowed set.
- sw.js caches the app shell and vendor/ on install so retouch works offline.
- Manifest share_target: retouch must appear in Android's share sheet, so Gary can share a photo from Google Photos straight in. Handle it in the service worker.
- Output goes out two ways: navigator.share with the file (straight to Instagram) and a plain download.
- Edit model: keep the original bitmap untouched. Each pixel operation produces a new bitmap on an undo/redo stack (cap the depth to protect memory). Text stays as editable overlay objects until export.
- Text and the history: every history step carries the list of text boxes as they stood after it. Applying the Text tool adds one step that reuses the previous bitmap (no new pixels, no extra memory), so undo and redo cover text like any other edit. A bitmap is released only when no step still uses it.
- Text through Crop, Resize and Add canvas: each box is carried through the same geometry as the pixels under its centre (position, size, and the turn from rotate or straighten), so it stays on the same spot of the photo at the same relative size. Flips move a box but never mirror its letters. A box whose centre falls outside the new frame is dropped from that step, with a notice; undo brings it back. Export draws the boxes into a copy of the image just before encoding, then strips and re-checks metadata as before.
- Working size: Pixel default photos are about 12 MP. Work at full resolution up to that. Larger images (50 MP mode) are downscaled to that ceiling on load with a visible notice. Keep the ceiling as one named constant.
- Load with createImageBitmap using imageOrientation 'from-image' so EXIF rotation is applied before the metadata is dropped.
- Record the pinned version of every vendored library in the file header build notes. Never upgrade one silently.

## Design
retouch has its own darkroom style. It does not use Lab Book (Gary's general design system); this section is the reference instead. Approved from a mockup on 24/10/26.
- Dark only. A neutral near-black surround so colour and skin tones are judged fairly; the photo is the brightest thing on screen. No light theme.
- Tokens (CSS custom properties at the top of retouch.html): stage #0B0B0B, chrome #141312, raised #1D1B19, pressed #2E2B27, lines #2C2925 / #3A3631, ink #EEE8DE, muted #A59E92, faint #8A8377. One accent, the amber safelight #F2A33A (text on it #1B1205). Pass #7DBE8A, watch #E0A84A, fail #E57360. The cut-out brush veil is darkroom red; the skin veil stays blue.
- Type: Barlow Semi Condensed 400/600 for labels and buttons (labels in spaced capitals), IBM Plex Mono 400/500 for numbers and edit codes, vendored in vendor/fonts/. The Text tool's own fonts are separate.
- Motifs: film-edge edit codes in amber mono (RT-003 ▸ ...), sprocket holes along the tool bar and the empty screen, crop-mark corners on the empty screen and the icon.
- Phone first: portrait, one-handed. Tool bar at the bottom (icon and word), image fills the rest. Pinch to zoom, drag to pan. Tap targets at least 44 px.
- Uncluttered sheets: header row is cancel (✕), title, hold-before (half circle) and apply (amber ✓); no footer buttons. Status lines go in the thin strip that replaces the top bar while a tool is open. How-to text is a short caption on the photo, shown only when it applies. Figures sit in a row of cells, not a table. Text settings are split into Font, Colour and Style tabs.
- Self-host every font in vendor/ (offline requirement).

## v1 features
1. Open: JPEG, PNG, WebP, plus anything else Chrome decodes (AVIF). If decoding fails (e.g. some HEIC), say so plainly. No RAW.
2. Crop and transform: free crop, locked ratios (1:1, 4:5, 1.91:1, 9:16, 3:4, original), rotate 90, straighten slider, flip.
3. Resize: by long edge in px, with an "Instagram 1080 wide" preset.
4. Add canvas: pad the image out to a target ratio (same presets as crop) without cropping. Fill: solid colour, blurred stretch of the photo itself, or transparent. Image position adjustable inside the frame.
5. Remove background (people): MediaPipe Tasks Vision ImageSegmenter with the selfie multiclass model, vendored. Upscale the mask with edge-aware refinement and a feather slider. Add a refine brush (keep / erase) because hair edges will need hand fixes. Result can go on transparent, solid colour or blurred original.
6. Skin smoothing: edge-preserving filter (bilateral or guided) applied inside a skin mask built from the multiclass model's face-skin and body-skin classes. Strength slider. Blend back some original texture so it doesn't go plastic. Brush to add or remove areas from the mask.
7. Spot eraser: tap or brush over a blemish or dust spot; fill it from the surroundings. Hand-written: healing from a nearby source patch (searched by how well its surroundings match, blended in with a membrane so there is no seam), with Telea fast marching as the fallback where no source fits. Telea alone left smooth, seamed fills on skin (found on the Pixel, 24/10/26). Do not pull in OpenCV.js unless the hand-written version fails its tests. Small spots only; object removal is out of scope.
8. Text: multiple text boxes, each draggable, pinch to scale and rotate, editable until export. Font (a few vendored ones), size, colour, alignment, outline, shadow.
9. Export: JPEG (quality slider), PNG (required whenever there is transparency), WebP. Metadata is always stripped; show a one-line confirmation on export. A test parses exported JPEG/PNG/WebP bytes and fails on any EXIF, XMP, IPTC, GPS or text chunk.

Known limitation to state in the README: Pixel photos are Ultra HDR JPEGs; re-encoding drops the HDR gain map, so exports look slightly flatter on HDR screens.

## Out of scope for v1
Video, object removal, any AI feature needing a network call, HEIC/RAW export, preserving Ultra HDR, batch editing, layers beyond text.

## Build order
Phase 1: shell, PWA install, share target, open/export, metadata strip, crop/transform, resize, add canvas.
Phase 2: text.
Phase 3: background removal plus refine brush.
Phase 4: skin smoothing.
Phase 5: spot eraser.
Gate at the end of each phase: each phase is built on its own branch (phase-1, phase-2, ...) and pushed to GitHub with all suites green. Gary reviews and merges to main, GitHub Pages deploys, Gary tests on the Pixel at jeuron-hue.github.io/retouch and confirms before the next phase starts. Nothing reaches main with a failing suite. No partial builds.
Builds may run in cloud sessions (claude.ai/code) or locally on the rig; both follow the same gate.
After Phase 5: the darkroom UI redesign (v0.6.0, 24/10/26). Gary then uses retouch day to day for a few months before deciding whether it becomes the final 1.0 release; fixes in that period follow the same gate.

## Testing
- retouch_checks.cjs (static): CSP present, no external origins anywhere in the source, no CDN URLs, required files present, vendored versions recorded.
- retouch_behave.cjs (behavioural): real Chromium via Playwright, since canvas and wasm need a real browser. Use synthetic fixtures generated in the test (gradients, shapes, a fake "spot") so results can be asserted numerically: crop dimensions, padding ratios, metadata absence, undo/redo, inpainting fills the spot within a colour tolerance.
- Segmentation and smoothing tests run against reference/test-images/ when present and skip otherwise.
- retouch_mutate.sh: mutation runner over the core image functions. Survivors mean the fixtures get tightened.
- Everything green before any commit.
- Phone testing: after each merge, Gary opens jeuron-hue.github.io/retouch on the Pixel. Optional earlier check from the rig: serve locally, connect the Pixel by USB and use adb reverse so the phone opens it as localhost (a secure context for the service worker).
- Service worker updates: version the cache name in sw.js and bump it with every release, and show an "update available, reload" prompt, so the installed app on the phone never sits on a stale copy.

## Working with Gary
- Gary is a process chemist learning to code. Explain each layer in plain words as you build it: what it does and why, not just the code.
- Dates dd/mm/yy, 24-hour times, SI units, no em dashes in docs or UI text.
- README is public and plain. reference/ is gitignored and never pushed.
- Plans and this file are updated in place; no addenda.
- Findings get written down, not scheduled, unless they are hurting something now.
