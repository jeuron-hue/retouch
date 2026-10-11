# retouch

A small photo editor for an Android phone, installed from this site as an app (PWA). Built for one person's use.

Open it at jeuron-hue.github.io/retouch, then use Chrome's menu, "Add to home screen" or "Install app".

## Photos never leave the phone

- Every edit runs in the browser on the phone. There is no server, no upload, no analytics.
- The page carries a Content-Security-Policy that only lets it talk to its own site, so the browser itself blocks any attempt to send data elsewhere.
- Fonts are stored in this repository (all under the SIL Open Font License; licence files sit beside them in vendor/fonts/). After the first visit the app works with no network at all.
- Exports are re-encoded and stripped of EXIF, XMP, IPTC, GPS and text chunks, then checked again before they are saved or shared.

## What it does

- Open JPEG, PNG, WebP and AVIF, or share a photo to retouch from Google Photos. RAW files are not supported; if Chrome cannot decode a file (some HEIC photos), retouch says so.
- Photos up to 12.5 MP (a Pixel's default 4080 × 3072) are edited at full size. Larger photos, such as 50 MP mode, are scaled down to that limit on open, with a notice.
- Crop: free or locked ratio (1:1, 4:5, 1.91:1, 9:16, 3:4, original), rotate 90°, flip, straighten.
- Resize by long edge, or the "Instagram 1080 wide" preset.
- Add canvas: pad the photo out to a ratio without cropping, filled with a colour, a blurred copy of the photo, or transparency. Drag the photo to place it in the frame.
- Text: as many text boxes as you like. Drag to move, pinch (or drag the round handle) to resize and turn. Four fonts (Source Sans 3, Playfair Display, Bebas Neue, Caveat), size, colour, alignment, outline and shadow. Text stays editable until export, including after undo and redo.
- Text follows the photo through later crops, resizes and added canvas. A box that ends up outside a crop is removed, and undo brings it back.
- Undo and redo (the last 10 steps; the original is always kept). Hold "before" to compare.
- Export as JPEG, PNG or WebP. Share straight to another app (Instagram) or download. Anything with transparent areas exports as PNG.

## Known limitations

- Pixel photos are Ultra HDR JPEGs. Re-encoding drops the HDR gain map, so exports look slightly flatter on HDR screens than the original does.
- Editing happens in the sRGB colour space.

## Tests

The app has no build step. The tests need Node.js and Playwright:

```
npm install
npx playwright install chromium
npm test                 # static checks, then behaviour tests in Chromium
bash retouch_mutate.sh   # mutation run over the core image functions
```
