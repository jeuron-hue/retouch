# retouch

A small photo editor for an Android phone, installed from this site as an app (PWA). Built for one person's use.

Open it at jeuron-hue.github.io/retouch, then use Chrome's menu, "Add to home screen" or "Install app".

## Photos never leave the phone

- Every edit runs in the browser on the phone. There is no server, no upload, no analytics.
- The page carries a Content-Security-Policy that only lets it talk to its own site, so the browser itself blocks any attempt to send data elsewhere.
- Fonts are stored in this repository (all under the SIL Open Font License; licence files sit beside them in vendor/fonts/). After the first visit the app works with no network at all.
- Background removal and skin smoothing run Google's MediaPipe (version 0.10.35) on the phone, in WebAssembly, with its selfie multiclass model and, for objects, its tap-to-select (MagicTouch) model. All of it is stored in this repository (Apache License 2.0; the licence text is in vendor/mediapipe/). Newer MediaPipe releases (1.0 onwards) carry code that sends usage logs to Google, so retouch stays on 0.10.35, and a test fails if logging code ever appears in the vendored files.
- The first visit downloads about 34 MB extra for the models and their runtime. App updates do not download it again; only a new MediaPipe version would.
- Exports are re-encoded and stripped of EXIF, XMP, IPTC, GPS and text chunks, then checked again before they are saved or shared.

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

## Known limitations

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
