# CrossPoint Studio — Chrome extension for Xteink X3 · X4 · X4 Pro

A browser extension that turns any image into a **pixel-exact BMP sleep screen** for
Xteink e-readers running [CrossPoint](https://github.com/crosspoint-reader/crosspoint-reader)
firmware — no desktop app, no plugin, no command line.

CrossPoint **never rescales** a sleep image. A file that is one pixel off the panel size
is drawn with white borders; a paletted or renamed file is ignored and the reader silently
falls back to its logo. This extension writes the exact panel width and height for the
device you pick, dithered to the greys the panel can actually draw, and can send the
result straight to the reader over Wi-Fi.

| Reader | Panel | Output pixels | Greys | 24-bit file | 2-bit file |
| --- | --- | --- | --- | --- | --- |
| **Xteink X3** | 3.7″ · 259 ppi | **528 × 792** | 4 | 1,254,582 B | 104,614 B |
| **Xteink X4** | 4.3″ · 220 ppi | **480 × 800** | 4 | 1,152,054 B | 96,070 B |
| **Xteink X4 Pro** | 4.3″ · 219 ppi | **480 × 800** | 4 | 1,152,054 B | 96,070 B |

---

## Install (unpacked)

```bash
git clone <this repo>
cd Crosspoint-img-to-bmp
node tools/make-icons.mjs      # already committed, only needed if you change the icon
```

1. Open `chrome://extensions` in Chrome, Edge, Brave or any Chromium browser.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this repository folder.
4. Pin **CrossPoint Studio** to the toolbar.

After editing any file, press the ↻ reload button on the extension card.

### Packaged build

```bash
npm run build     # → dist/crosspoint-studio-1.0.0.zip
```

The ZIP contains only the runtime files (`manifest.json`, `background.js`, the two pages,
`css/`, `js/`, `lib/`, `icons/`). Tests and tooling are excluded.

---

## Using it

Click the toolbar icon → **Open Studio** (or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>).

1. **Pick the reader.** The device buttons show the exact pixel size each one exports.
2. **Drop images.** Drag files in, paste with <kbd>Ctrl</kbd>+<kbd>V</kbd>, or right-click
   any image on a web page → *Convert for CrossPoint*. Up to 40 images per queue.
3. **Frame it.** *Fill* crops to the screen, *Fit* pads with white, *Stretch* ignores the
   aspect ratio. Drag the preview to pan, scroll to zoom, double-click to reset. Framing is
   remembered per image, so a batch keeps each crop.
4. **Tune the e-ink.** Brightness, contrast, gamma, invert, and a choice of dither:
   - **Floyd–Steinberg** — default for photos, best all-round detail.
   - **Atkinson** — lighter diffusion and crisper contrast, good for ink drawings.
   - **Ordered 4×4** — regular cross-hatch, very stable, no smearing.
   - **None** — flat posterised bands, cleanest for logos and large text.
5. **Export.** *Download BMP* (single), *Download all (ZIP)* (a whole `.sleep` set), or
   *Export overlay PNG* for CrossPoint 1.6+ transparent mode.
6. **Send to reader** (optional) — see below.

The preview canvas shows the **literal output bitmap**, scaled up with
nearest-neighbour, so what you see is what the panel draws.

### Right-click shortcut

Right-click an image on any page → **Convert for CrossPoint**. The studio opens with the
image queued and the correct panel size already selected.

---

## Getting the file onto the reader

Whichever route you take, the file must end up at the panel size in the format the
firmware decodes.

**Copy to the microSD card**

- One image: `sleep.bmp` in the card **root**.
- A rotating set: any number of `.bmp` files in `/.sleep` (a plain `sleep` folder also works).
- On macOS, press <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> to see dot-folders.
- Then on the reader: **Settings → Display → Sleep Screen → Custom**.

**Send over Wi-Fi (no card reader needed)**

1. On the reader: **Home → File Transfer → Join Network** (or **Create Hotspot**).
2. The reader shows a URL such as `http://192.168.1.102/`. Enter that **IP** in the
   extension's *Send to device* tab — `crosspoint.local` only resolves on some networks.
3. Press **Connect**, choose a target:

   | Target | What it writes | Use when |
   | --- | --- | --- |
   | Card root | `/sleep.bmp` | One fixed sleep screen |
   | `.sleep` folder | `/.sleep/<name>.bmp` | Several images, one picked at random |
   | Custom folder | `<folder>/<name>.bmp` | Your own organisation |

4. **Send current image** or **Send all images**. Every upload is re-listed on the card and
   its byte count compared, so a truncated transfer is reported instead of failing silently.

Uploads use CrossPoint's documented HTTP API (`GET /api/status`, `POST /mkdir`,
`POST /upload?overwrite=1` with a multipart `file` field). Nothing is sent anywhere except
the address you typed.

---

## What the exported file actually is

- **BI_RGB, uncompressed** — `biCompression = 0`. The firmware rejects RLE and other
  compression.
- **Rows bottom-up**, padded to a 4-byte boundary (`rowBytes = (w*bpp + 31)/32*4`), exactly
  as `lib/GfxRenderer/Bitmap.cpp` computes it.
- **Greys at 0 / 85 / 170 / 255** — CrossPoint's four native levels. Because every palette
  entry in a 2-bit file sits within ±21 of `n × 85`, the firmware treats it as a *native
  palette* and maps it directly, without re-dithering on the device. The file you author is
  the file that is drawn.
- **Luma weights `(77·R + 150·G + 29·B) >> 8`** — the same integer weights the firmware
  uses, so colours convert identically.
- **1-bit convention** — a set bit is white (palette index 1), matching the firmware's
  `palRow[x >> 3] & (0x80 >> (x & 7)) ? 1 : 0`.

Format choice:

| Format | Decoded by | 480 × 800 size | Notes |
| --- | --- | --- | --- |
| 24-bit BMP | stock firmware **and** every CrossPoint build | 1.10 MiB | safest |
| 2-bit BMP | CrossPoint / CrossInk | 96 KB | 12× smaller, faster to open, no re-dither |
| 1-bit BMP | CrossPoint / CrossInk | 54 KB | pure black & white, logos and line art |

JPG and PNG are **not** valid custom sleep screens. Renaming one to `.bmp` will not work.

---

## Transparency (CrossPoint 1.6+ / CrossInk)

*Export overlay PNG* writes `sleep-overlay.png` at the panel size with an alpha channel:
white areas become fully transparent so the page underneath shows through. Put it in the
card root or in `/.sleep-overlay`, then set **Sleep Screen → Transparent**. A BMP cannot
carry alpha, so a PNG (or a 32-bit BGRA BMP) is required for per-pixel transparency.

---

## Development

```bash
npm test          # 35 tests: pipeline, BMP encoder, ZIP, firmware decoder parity, device client
npm run smoke     # 20 UI wiring checks in jsdom (needs jsdom installed)
npm run server    # studio.html on http://localhost:5173
npm run build     # packaged ZIP in dist/
node tools/make-sample.mjs   # write sample BMPs + preview PNGs to samples/
node tools/fake-device.mjs 8099   # stand-in CrossPoint server for upload testing
```

The extension degrades gracefully outside Chrome: `lib/store.js` falls back to
`localStorage`, so `npm run server` gives you the full studio in a normal tab.

### Layout

```
manifest.json        MV3 manifest
background.js        service worker: context menus, opening the studio
studio.html          the converter page
popup.html           toolbar popup
css/                 styles (studio + popup)
js/studio.js         UI controller: queue, preview, export, upload
js/popup.js          popup logic
lib/profiles.js      device table + file-size maths
lib/pipeline.js      luma → layout → resample → tone → dither (pure, no DOM)
lib/bmp.js           BMP writer + reader (bmp24 / bmp2 / bmp1)
lib/canvas.js        canvas helpers for the preview
lib/store.js         settings persistence
lib/device.js        CrossPoint web-server client
lib/zip.js           stored ZIP writer
test/core.test.js    unit tests, incl. a port of the firmware's row decoder
test/device.test.js  upload/download tests against tools/fake-device.mjs
tools/               dev server, build, icons, samples, smoke test, fake device
```

`lib/pipeline.js` and `lib/bmp.js` have no DOM dependency at all, which is why they can be
tested in Node and would drop straight into a worker if conversion ever needs to move off
the main thread.

### Correctness

`test/core.test.js` includes a line-by-line port of CrossPoint's `Bitmap.cpp` row decoder
(`rowBytes`, the 2-bit `(row[x>>2] >> (6 - (x&3)*2)) & 3` unpacking, the 1-bit MSB-first
convention, palette luma, and the native-palette detection). Every encoding the extension
writes is decoded with that port and compared pixel for pixel, so encoder regressions show
up as test failures rather than as white borders on a reader.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Reader still shows the CrossPoint logo | Sleep Screen is not on Custom, or the file is not `sleep.bmp` in the root / `.sleep` | Rename and set **Settings → Display → Sleep Screen → Custom** |
| White borders on all four sides | Wrong panel — usually a 480 × 800 X4 file on a 528 × 792 X3 | Pick the right device and re-export |
| Muddy or blotchy photo | Busy mid-tones collapsing into four levels | Raise contrast, try *Ordered 4×4*, or *Atkinson* for line art |
| Ghosting after sleep | Smooth grey gradients refreshing poorly | Dithered output refreshes more cleanly than flat gradients — keep dithering on |
| “Could not reach …” | `crosspoint.local` does not resolve on this network, or File Transfer mode closed | Use the IP address shown on the reader |
| “File already exists” | Uploads never overwrite unless asked | Enable *Replace files with the same name* |
| `.sleep` missing in Finder | macOS hides dot-folders | <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> |

---

## Privacy

Conversion happens entirely on your machine. Images leave the browser only when you press
**Send to reader**, and then only to the address you entered. No analytics, no accounts, no
remote servers. Permissions are `storage` (settings), `downloads` (saving files) and
`contextMenus` (right-click); the broad host permission exists solely because the reader's
address can be any private-network IP.

## Licence

MIT.
