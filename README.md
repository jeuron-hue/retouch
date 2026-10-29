# retouch

A small photo and video editor for an Android phone, installed from this site as an app (PWA). Built for one person's use.

Open it at jeuron-hue.github.io/retouch, then use Chrome's menu, "Add to home screen" or "Install app".

## Photos and videos never leave the phone

- Every edit runs in the browser on the phone. There is no server, no upload, no analytics.
- The page carries a Content-Security-Policy that only lets it talk to its own site, so the browser itself blocks any attempt to send data elsewhere.
- Fonts are stored in this repository (all under the SIL Open Font License; licence files sit beside them in vendor/fonts/). After the first visit the app works with no network at all.
- Background removal and skin smoothing run Google's MediaPipe (version 0.10.35) on the phone, in WebAssembly, with its selfie multiclass model and, for objects, its tap-to-select (MagicTouch) model. All of it is stored in this repository (Apache License 2.0; the licence text is in vendor/mediapipe/). Newer MediaPipe releases (1.0 onwards) carry code that sends usage logs to Google, so retouch stays on 0.10.35, and a test fails if logging code ever appears in the vendored files.
- The first visit downloads about 34 MB extra for the models and their runtime. App updates do not download it again; only a new MediaPipe version would.
- Video is read and written with Mediabunny (version 1.61.6, Mozilla Public License 2.0; the licence text is in vendor/mediabunny/, and its source is in the npm package and the Vanilagy/mediabunny repository on GitHub). It is stored in this repository too. It contains readers for web addresses and streaming playlists; retouch never uses them, a test makes sure, and the page's Content-Security-Policy would block them anyway.
- Exports are re-encoded and stripped of EXIF, XMP, IPTC, GPS and text chunks, then checked again before they are saved or shared.
- Video exports are new MP4 files that carry only the picture and the sound: no location, no camera make or model, no XMP, and every date in the file set to zero. The file is checked again before it is saved or shared.

## What it does

- Open JPEG, PNG, WebP and AVIF, or share a photo to retouch from Google Photos. RAW files are not supported; if Chrome cannot decode a file (some HEIC photos), retouch says so.
- Photos up to 12.5 MP (a Pixel's default 4080 × 3072) are edited at full size. Larger photos, such as 50 MP mode, are scaled down to that limit on open, with a notice.
- Crop: free or locked ratio (1:1, 4:5, 1.91:1, 9:16, 3:4, original), rotate 90°, flip, straighten.
- Resize by long edge, or the "Instagram 1080 wide" preset.
- Add canvas: pad the photo out to a ratio without cropping, filled with a colour, a blurred copy of the photo, or transparency. Drag the photo to place it in the frame.
- Text: as many text boxes as you like. Drag to move, pinch (or drag the round handle) to resize and turn. Four fonts (Source Sans 3, Playfair Display, Bebas Neue, Caveat), size, colour, alignment, outline and shadow. Text stays editable until export, including after undo and redo.
- Text follows the photo through later crops, resizes and added canvas. A box that ends up outside a crop is removed, and undo brings it back.
- Remove background: picks the subject by itself and says what it picked. A person if there is one; otherwise, if the border is mostly one colour (a logo, a banner, a product on card), that colour is taken away, holes in letters included, with no coloured fringe; otherwise the object in the middle, or the thing the model noticed (a bag, a cat). Tap the photo to pick a different subject. The cut snaps to the photo's own edges, and goes on transparency, a colour, or a blurred copy of the photo. Feather softens the edge. A Keep and Erase brush fixes the rest; red shows what will be cut away. Two fingers zoom and move while brushing. Transparent results export as PNG.
- Smooth skin: the same model finds face and body skin, and an edge-preserving filter evens out tone and small spots there while eyebrows, lashes and lip lines stay sharp. Strength sets how much; Texture puts the skin's fine grain back so it does not look plastic. An Add and Remove brush changes where it applies; blue shows the area. The filter is sized from the face, so a full-length photo is treated like a close-up.
- Spot eraser: tap a blemish or a dust spot, or brush along a scratch, and it is healed from skin nearby, the way a healing brush works. retouch looks round the spot for a patch whose surroundings match (so wrinkles line up) and that has no mark of its own, copies its texture in, and blends the colour so there is no seam. With no room for a patch (against the frame edge) it falls back to fast marching inpainting with the skin's grain added. All written for retouch; no extra library. Each spot is healed the moment you lift your finger; Undo stroke takes the last one back.
- Undo and redo (the last 10 steps; the original is always kept). Hold the half-circle button to compare with before.
- Dark only, in a darkroom style: a neutral near-black surround so colour and skin tones are judged fairly, and one amber accent. Interface fonts are Barlow Semi Condensed and IBM Plex Mono.
- Export as JPEG, PNG or WebP. Share straight to another app (Instagram) or download. Anything with transparent areas exports as PNG.

### Video

- Open MP4, MOV or WebM videos, from the Open button or by sharing a video to retouch from Google Photos. The top bar shows the size and length; Chrome's own player plays it.
- Trim: drag the start and end on the bar, or play to a point and tap Start here or End here. Undo and redo work as for photos.
- Sound: keep the sound or remove it.
- Export copies the chosen part of the video into a new MP4 without decoding it, so it is fast and the picture and sound are exactly as recorded, 10-bit HDR included. Share or download it as with photos.
- Why the start snaps: a video stores a whole picture only now and then (a keyframe, about once a second on a Pixel), and the frames in between only as changes from it. A copied clip has to begin on a keyframe, so the start moves back to the keyframe at or before the point you pick, and the Trim sheet says when it has. The end can be any frame.
- Video check: a button on the start screen (and Check in the video tools) lists what this phone's Chrome can encode and decode (H.264 at 1080p and 4K, 30 and 60 fps, HEVC, AAC, Opus), with a short trial run of each encoder, and copies a plain report.

## Known limitations

- Video trims start on a keyframe (see above), so a clip can begin up to about a second before the chosen point. Cutting exactly between keyframes would mean re-encoding the first second, which is planned for a later version.
- Right after a cut, the first fraction of a second of sound can click faintly, because sound packets lean on the one before them.
- Video exports are written to the browser's private storage on the phone first (a long 4K clip can be hundreds of MB). The copy is replaced by the next export.
- HDR10 (PQ) videos with separate brightness boxes (mdcv, clli) lose those boxes on export; the colour tags are kept. HLG video, the other HDR kind, does not use them.
- A video whose picture cannot go into an MP4 without re-encoding cannot be exported yet. If only its sound cannot (Vorbis, in some WebM files), remove the sound to export it.

- Pixel photos are Ultra HDR JPEGs. Re-encoding drops the HDR gain map, so exports look slightly flatter on HDR screens than the original does.
- Editing happens in the sRGB colour space.
- Background removal is trained on people. Other subjects may not be found at all; the Keep brush can still paint them in. Fine hair against a busy background usually needs some brushing.
- Small people far from the camera (a street scene) cut roughly: feet, hair tops and arms can go soft. The model is made for one person close up; the brush fixes the rest.
- Finding the subject or the skin takes a few seconds on the phone, longest the first time after opening the app, while the model loads.
- The spot eraser is for spots and scratches. It copies texture from nearby, so a very large area can repeat what is beside it, and retouch warns when a stroke is large. Removing whole objects is out of scope.
- Skin smoothing evens out tone and small marks. Larger spots fade but do not vanish; the skin mask can include the eyes and lips, which the filter mostly leaves alone, and the Remove brush can take them out entirely.

## Tests

The app has no build step. The tests need Node.js and Playwright:

```
npm install
npx playwright install chromium
npm test                 # static checks, then behaviour tests in Chromium
bash retouch_mutate.sh   # mutation run over the core image functions
```
