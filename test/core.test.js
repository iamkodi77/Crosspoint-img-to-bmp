import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBMP, decodeBMP, rowStride, BMP_FORMATS } from '../lib/bmp.js';
import {
  processImage,
  computeLayout,
  clampPan,
  paletteFor,
  rgbaToLuma,
  render,
  workingSize,
} from '../lib/pipeline.js';
import { PROFILES, getProfile, encodedSize, profileFromDeviceField } from '../lib/profiles.js';

function flatGray(width, height, value) {
  return new Uint8Array(width * height).fill(value);
}

function solidRGBA(width, height, [r, g, b, a = 255]) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = a;
  }
  return out;
}

test('profiles match the firmware panel sizes', () => {
  assert.equal(getProfile('x3').width, 528);
  assert.equal(getProfile('x3').height, 792);
  assert.equal(getProfile('x4').width, 480);
  assert.equal(getProfile('x4').height, 800);
  assert.equal(getProfile('x4pro').width, 480);
  assert.equal(getProfile('x4pro').height, 800);
  // Unknown ids must never produce a bogus size.
  assert.equal(getProfile('nonsense').id, 'x4');
});

test('encodedSize matches the bytes actually written', () => {
  for (const profile of PROFILES) {
    for (const bits of [24, 2, 1]) {
      const format = BMP_FORMATS.find((f) => f.bits === bits).id;
      const gray = flatGray(profile.width, profile.height, 255);
      const bytes = encodeBMP(gray, profile.width, profile.height, { format, levels: 4 });
      assert.equal(
        bytes.length,
        encodedSize(profile.width, profile.height, format),
        `${profile.id} ${format}`
      );
    }
  }
});

test('24-bit BMP header is a valid uncompressed 480x800 file', () => {
  const { width, height } = getProfile('x4');
  const bytes = encodeBMP(flatGray(width, height, 200), width, height, { format: 'bmp24' });
  assert.equal(bytes.length, 1152054); // the figure the firmware docs quote
  const view = new DataView(bytes.buffer);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'BM');
  assert.equal(view.getUint32(2, true), bytes.length);
  assert.equal(view.getUint32(10, true), 54);
  assert.equal(view.getUint32(14, true), 40);
  assert.equal(view.getInt32(18, true), width);
  assert.equal(view.getInt32(22, true), height);
  assert.equal(view.getUint16(28, true), 24);
  assert.equal(view.getUint32(30, true), 0, 'must be BI_RGB (uncompressed)');
});

test('X3 24-bit export is 528x792 with no row padding', () => {
  const { width, height } = getProfile('x3');
  const bytes = encodeBMP(flatGray(width, height, 128), width, height, { format: 'bmp24' });
  assert.equal(rowStride(width, 24), width * 3); // 1584 exactly
  assert.equal(bytes.length, 1254582);
});

test('2-bit BMP keeps a 4-grey palette and packs 4 pixels per byte', () => {
  const width = 480;
  const height = 800;
  const gray = flatGray(width, height, 0);
  // paint a known strip: 0, 85, 170, 255 repeated
  for (let x = 0; x < width; x++) gray[x] = [0, 85, 170, 255][x % 4];
  const bytes = encodeBMP(gray, width, height, { format: 'bmp2', levels: 4 });
  assert.equal(bytes.length, 96070);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint16(28, true), 2);
  assert.equal(view.getUint32(46, true), 4, 'four palette entries');
  const offset = view.getUint32(10, true);
  assert.equal(offset, 70); // 14 + 40 + 16
  // Palette quads are 0, 85, 170, 255
  assert.deepEqual(
    [bytes[54], bytes[58], bytes[62], bytes[66]],
    [0, 85, 170, 255]
  );
  // Bottom-up: the top (last logical) row is stored last.
  const lastRow = offset + (height - 1) * rowStride(width, 2);
  assert.equal(bytes[lastRow], 0b00011011);
});

test('1-bit BMP is usable for line art', () => {
  const width = 8;
  const height = 2;
  const gray = Uint8Array.from([0, 255, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
  const bytes = encodeBMP(gray, width, height, { format: 'bmp1', levels: 2 });
  const decoded = decodeBMP(bytes);
  assert.equal(decoded.bits, 1);
  assert.deepEqual(Array.from(decoded.gray.subarray(0, 8)), [0, 255, 0, 255, 0, 255, 0, 255]);
});

test('round-trip through the decoder returns the same pixels', () => {
  const width = 37; // deliberately not a multiple of 4
  const height = 11;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = [0, 85, 170, 255][(i * 7) % 4];

  for (const format of ['bmp2', 'bmp1']) {
    const source = format === 'bmp1' ? Uint8Array.from(gray, (v) => (v < 128 ? 0 : 255)) : gray;
    const decoded = decodeBMP(encodeBMP(source, width, height, { format, levels: 4 }));
    assert.equal(decoded.width, width);
    assert.equal(decoded.height, height);
    assert.deepEqual(Array.from(decoded.gray), Array.from(source), format);
  }

  const mono = Uint8Array.from(gray, (v) => (v < 128 ? 0 : 255));
  const d24 = decodeBMP(encodeBMP(mono, width, height, { format: 'bmp24' }));
  assert.deepEqual(Array.from(d24.gray), Array.from(mono));
});

test('an image is always resampled to the exact panel size', () => {
  const cases = [
    [4032, 3024],
    [100, 100],
    [1, 1],
    [800, 480], // landscape photo onto a portrait panel
    [480, 800],
  ];
  for (const profile of PROFILES) {
    for (const [sw, sh] of cases) {
      const rgba = solidRGBA(Math.min(sw, 64), Math.min(sh, 64), [120, 120, 120]);
      const srcW = Math.min(sw, 64);
      const srcH = Math.min(sh, 64);
      const out = processImage(rgba, srcW, srcH, {
        targetWidth: profile.width,
        targetHeight: profile.height,
        fit: 'cover',
      });
      assert.equal(out.width, profile.width);
      assert.equal(out.height, profile.height);
      assert.equal(out.gray.length, profile.width * profile.height);
    }
  }
});

test('cover fit fills every pixel, contain fit pads solid white', () => {
  // A wide 2:1 landscape image on the portrait panel.
  const sw = 200;
  const sh = 100;
  const rgba = solidRGBA(sw, sh, [0, 0, 0]);
  const target = getProfile('x4');

  const cover = processImage(rgba, sw, sh, {
    targetWidth: target.width,
    targetHeight: target.height,
    fit: 'cover',
    dither: 'none',
  });
  assert.equal(cover.gray.every((v) => v === 0), true, 'cover crops, so all pixels are image');

  const contain = processImage(rgba, sw, sh, {
    targetWidth: target.width,
    targetHeight: target.height,
    fit: 'contain',
    dither: 'none',
    background: 255,
  });
  const topRow = contain.gray.subarray(0, target.width);
  assert.equal(topRow.every((v) => v === 255), true, 'letterbox band is white');
  const middle = contain.gray.subarray(Math.floor(target.height / 2) * target.width, Math.floor(target.height / 2) * target.width + target.width);
  assert.equal(middle.every((v) => v === 0), true, 'image occupies the middle band');
});

test('contain fit keeps the whole image for extreme aspect ratios', () => {
  const canvas = new Float32Array(200 * 50).fill(0);
  const layout = computeLayout(200, 50, 480, 800, { fit: 'contain' });
  assert.equal(Math.round(layout.drawnW), 480);
  assert.equal(Math.round(layout.drawnH), 120);
  assert.equal(Math.round(layout.offY), 340);
  assert.ok(canvas.length > 0);
});

test('pan is clamped so the panel can never show a gap', () => {
  // Cover fit of a 4:3 photo on a 480x800 panel is wider than the panel,
  // so horizontal panning is allowed and vertical panning is not.
  const layout = computeLayout(400, 300, 480, 800, { fit: 'cover' });
  assert.ok(layout.drawnW > 480);
  assert.equal(Math.round(layout.drawnH), 800);
  const panned = clampPan(layout.drawnW, layout.drawnH, 480, 800, 9999, 9999);
  assert.equal(panned.panY, 0);
  assert.equal(Math.round(panned.panX), Math.round((layout.drawnW - 480) / 2));
});

test('solid colours map to the four palette greys', () => {
  const palette = paletteFor(4);
  assert.deepEqual(palette, [0, 85, 170, 255]);
  for (const value of [0, 85, 170, 255]) {
    const out = processImage(solidRGBA(8, 8, [value, value, value]), 8, 8, {
      targetWidth: 16,
      targetHeight: 16,
      dither: 'none',
      background: 255,
    });
    assert.equal(out.gray.every((v) => v === value), true, `solid ${value}`);
  }
});

test('dithering approximates mid grey instead of banding', () => {
  // 50% grey must become a mix of black and white when dithered.
  const out = render(new Float32Array(64 * 64).fill(127.5), 64, 64, {
    levels: 2,
    method: 'floyd-steinberg',
  });
  const dark = out.reduce((n, v) => n + (v === 0 ? 1 : 0), 0);
  const ratio = dark / out.length;
  assert.ok(ratio > 0.4 && ratio < 0.6, `expected ~50% dark, got ${ratio.toFixed(3)}`);
});

test('all dither methods stay inside the palette', () => {
  const palette = new Set(paletteFor(4));
  const data = new Float32Array(120 * 90);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256;
  for (const method of ['floyd-steinberg', 'atkinson', 'bayer4', 'none']) {
    const out = render(data, 120, 90, { levels: 4, method });
    assert.equal(out.every((v) => palette.has(v)), true, method);
  }
});

test('invert flips black and white', () => {
  const rgba = solidRGBA(10, 10, [0, 0, 0]);
  const normal = processImage(rgba, 10, 10, { targetWidth: 10, targetHeight: 10, dither: 'none' });
  const inverted = processImage(rgba, 10, 10, {
    targetWidth: 10,
    targetHeight: 10,
    dither: 'none',
    invert: true,
  });
  assert.equal(normal.gray[0], 0);
  assert.equal(inverted.gray[0], 255);
});

test('transparent pixels are composited over the page colour', () => {
  const transparent = solidRGBA(4, 4, [0, 0, 0, 0]);
  const white = rgbaToLuma(transparent, 4, 4, 255);
  assert.equal(white.every((v) => v === 255), true);
  const grey = rgbaToLuma(transparent, 4, 4, 128);
  assert.equal(grey.every((v) => v === 128), true);
});

test('downscaling averages detail instead of aliasing it', () => {
  // A checkerboard must average to grey, not to noise.
  const size = 200;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 4;
      const v = (x + y) % 2 === 0 ? 0 : 255;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = v;
      rgba[p + 3] = 255;
    }
  }
  const out = processImage(rgba, size, size, {
    targetWidth: 50,
    targetHeight: 50,
    dither: 'none',
  });
  const mean = out.gray.reduce((a, b) => a + b, 0) / out.gray.length;
  assert.ok(Math.abs(mean - 127.5) < 25, `expected mid grey, got ${mean}`);
});

test('workingSize only shrinks oversized photos', () => {
  assert.deepEqual(workingSize(1200, 900), { width: 1200, height: 900, scaled: false });
  const big = workingSize(6000, 4000);
  assert.equal(big.width, 2048);
  assert.equal(big.height, Math.round((4000 * 2048) / 6000));
});

test('device field from /api/status picks the right panel', () => {
  assert.equal(profileFromDeviceField('X3').id, 'x3');
  assert.equal(profileFromDeviceField('X4').id, 'x4');
  assert.equal(profileFromDeviceField('').id, 'x4');
});

// ── ZIP ─────────────────────────────────────────────────────────────────────

test('ZIP archive is readable by standard tools', async () => {
  const { buildZip, crc32 } = await import('../lib/zip.js');
  const a = Uint8Array.from([1, 2, 3, 4, 5]);
  const b = Uint8Array.from([9, 9, 9]);
  const zip = buildZip([
    { name: 'sleep.bmp', bytes: a },
    { name: 'second.bmp', bytes: b },
  ]);

  // Local headers and central directory signatures.
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  const eocd = zip.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  assert.equal(view.getUint16(eocd + 10, true), 2, 'entry count');
  assert.equal(zip.length, view.getUint32(eocd + 16, true) + view.getUint32(eocd + 12, true) + 22);
  assert.equal(crc32(a), 0x470b99f4);
});

// ── device client ───────────────────────────────────────────────────────────

test('host input is normalised into an origin', async () => {
  const { normalizeHost } = await import('../lib/device.js');
  assert.equal(normalizeHost('crosspoint.local'), 'http://crosspoint.local');
  assert.equal(normalizeHost(' 192.168.4.1/ '), 'http://192.168.4.1');
  assert.equal(normalizeHost('http://192.168.1.102:8080/'), 'http://192.168.1.102:8080');
  assert.throws(() => normalizeHost(''), /Enter the address/);
});

test('destinationFor maps upload modes to CrossPoint folders', async () => {
  const { destinationFor } = await import('../lib/store.js');
  assert.deepEqual(destinationFor({ uploadMode: 'sleep-root' }, 'sleep.bmp'), {
    folder: '/',
    path: '/sleep.bmp',
  });
  assert.deepEqual(destinationFor({ uploadMode: 'sleep-folder' }, 'sleep.bmp'), {
    folder: '/.sleep',
    path: '/.sleep/sleep.bmp',
  });
  assert.deepEqual(
    destinationFor({ uploadMode: 'custom', lastUploadFolder: '/Sleep/' }, 'a.bmp'),
    { folder: '/Sleep/', path: '/Sleep/a.bmp' }
  );
});

// ── firmware compatibility ──────────────────────────────────────────────────

/**
 * Re-implements CrossPoint's Bitmap.cpp row decoder (bpp 1/2/24) as literally
 * as possible. If this agrees with the encoder, the device will read our files
 * pixel for pixel.
 *
 *   rowBytes = (width * bpp + 31) / 32 * 4
 *   bpp 2: idx = (row[x >> 2] >> (6 - ((x & 3) * 2))) & 0x03
 *   bpp 1: idx = (row[x >> 3] & (0x80 >> (x & 7))) ? 1 : 0
 *   bpp 24/32: lum = (77*p[2] + 150*p[1] + 29*p[0]) >> 8
 *   palette lum = (77*R + 150*G + 29*B) >> 8
 */
function firmwareDecode(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bfOffBits = view.getUint32(10, true);
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  const bpp = view.getUint16(28, true);
  const comp = view.getUint32(30, true);
  assert.equal(comp, 0, 'BI_RGB only');
  assert.ok([1, 2, 4, 8, 24, 32].includes(bpp), 'firmware-supported bpp');

  let colorsUsed = view.getUint32(46, true);
  if (colorsUsed === 0 && bpp <= 8) colorsUsed = 1 << bpp;

  const paletteLum = new Uint8Array(256);
  for (let i = 0; i < 256; i++) paletteLum[i] = i;
  for (let i = 0; i < colorsUsed; i++) {
    const p = 54 + i * 4;
    paletteLum[i] = (77 * bytes[p + 2] + 150 * bytes[p + 1] + 29 * bytes[p]) >> 8;
  }

  const rowBytes = (((width * bpp + 31) / 32) | 0) * 4;
  const gray = new Uint8Array(width * height);
  const row = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const fileRow = topDown ? y : height - 1 - y;
    const base = bfOffBits + fileRow * rowBytes;
    row.set(bytes.subarray(base, base + rowBytes));
    for (let x = 0; x < width; x++) {
      let lum;
      if (bpp === 24) lum = (77 * row[x * 3 + 2] + 150 * row[x * 3 + 1] + 29 * row[x * 3]) >> 8;
      else if (bpp === 2) lum = paletteLum[(row[x >> 2] >> (6 - ((x & 3) * 2))) & 0x03];
      else if (bpp === 1) lum = paletteLum[row[x >> 3] & (0x80 >> (x & 7)) ? 1 : 0];
      else throw new Error(`unhandled bpp ${bpp}`);
      gray[y * width + x] = lum;
    }
  }
  return { width, height, bpp, gray, nativePalette: bpp <= 2 };
}

test('firmware decoder reads our files back identically', () => {
  const width = 37; // not a multiple of 4: exercises bit flushing and padding
  const height = 9;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = [0, 85, 170, 255][(i * 5) % 4];

  for (const format of ['bmp2', 'bmp24']) {
    const decoded = firmwareDecode(encodeBMP(gray, width, height, { format, levels: 4 }));
    assert.equal(decoded.width, width);
    assert.equal(decoded.height, height);
    assert.deepEqual(Array.from(decoded.gray), Array.from(gray), format);
  }

  const mono = Uint8Array.from(gray, (v) => (v < 128 ? 0 : 255));
  const d1 = firmwareDecode(encodeBMP(mono, width, height, { format: 'bmp1', levels: 2 }));
  assert.deepEqual(Array.from(d1.gray), Array.from(mono), 'bmp1');
  assert.equal(d1.nativePalette, true, '1/2-bit bypasses the device ditherer');
});

test('2-bit output is a native palette, so the device does not re-dither it', () => {
  // Every grey we emit is exactly 0, 85, 170 or 255 — CrossPoint's nativePalette
  // check requires each palette luminance to be within ±21 of n*85.
  for (const levels of [4, 2]) {
    const out = processImage(solidRGBA(40, 40, [137, 137, 137]), 40, 40, {
      targetWidth: 24,
      targetHeight: 32,
      levels,
      dither: 'floyd-steinberg',
    });
    const allowed = new Set(paletteFor(levels));
    assert.equal(out.gray.every((v) => allowed.has(v)), true);
    const encoded = encodeBMP(out.gray, out.width, out.height, {
      format: levels === 2 ? 'bmp1' : 'bmp2',
      levels,
    });
    const decoded = firmwareDecode(encoded);
    assert.equal(decoded.nativePalette, true);
    assert.deepEqual(Array.from(decoded.gray), Array.from(out.gray));
  }
});

test('luma weights match the firmware', () => {
  // Pure colours must produce the same grey the device computes.
  const cases = [
    [[255, 0, 0], (77 * 255) >> 8],
    [[0, 255, 0], (150 * 255) >> 8],
    [[0, 0, 255], (29 * 255) >> 8],
  ];
  for (const [rgb, expected] of cases) {
    const luma = rgbaToLuma(solidRGBA(2, 2, rgb), 2, 2, 255);
    assert.ok(Math.abs(luma[0] - expected) <= 1, `rgb(${rgb}) → ${luma[0]} vs ${expected}`);
  }
});

// ── resampling regression ───────────────────────────────────────────────────

test('downscaling never bleeds background into a covered panel', () => {
  // Regression: the old box filter clamped the sample box to the integer grid
  // and then multiplied by a coverage term, which dropped area whenever the
  // scale was not exactly 1/n. On a 528x792 panel (scale 0.495) that turned
  // most of the screen white.
  const sw = 1200;
  const sh = 1600;
  const rgba = solidRGBA(sw, sh, [100, 100, 100]);

  for (const profile of PROFILES) {
    const out = processImage(rgba, sw, sh, {
      targetWidth: profile.width,
      targetHeight: profile.height,
      fit: 'cover',
      dither: 'none',
    });
    const white = out.gray.filter((v) => v === 255).length / out.gray.length;
    const mean = out.gray.reduce((a, b) => a + b, 0) / out.gray.length;
    assert.equal(white, 0, `${profile.id}: ${(white * 100).toFixed(1)}% of the panel went white`);
    assert.ok(Math.abs(mean - 100) < 1, `${profile.id}: mean ${mean.toFixed(2)} should be ~100`);
  }
});

test('area average preserves the mean for awkward scale factors', () => {
  const sw = 1000;
  const sh = 999;
  const rgba = solidRGBA(sw, sh, [173, 173, 173]);
  // Deliverable sizes are smaller than the source in both axes, so every
  // destination pixel is a genuine average of several source pixels.
  for (const [tw, th] of [[528, 792], [480, 800], [37, 41], [499, 333]]) {
    const out = processImage(rgba, sw, sh, {
      targetWidth: tw,
      targetHeight: th,
      fit: 'stretch',
      dither: 'none',
    });
    const mean = out.gray.reduce((a, b) => a + b, 0) / out.gray.length;
    assert.ok(Math.abs(mean - 173) < 2, `${tw}x${th}: mean ${mean.toFixed(2)}`);
  }
});

test('cover fit has no white gaps at the panel edges', () => {
  // A photo aspect ratio that does not divide evenly into 528x792.
  const sw = 1201;
  const sh = 1597;
  const rgba = solidRGBA(sw, sh, [60, 60, 60]);
  const profile = getProfile('x3');
  const out = processImage(rgba, sw, sh, {
    targetWidth: profile.width,
    targetHeight: profile.height,
    fit: 'cover',
    dither: 'none',
  });
  // Check the four edge rows/columns explicitly.
  const { width: w, height: h, gray } = out;
  for (let x = 0; x < w; x++) {
    assert.notEqual(gray[x], 255, `top row x=${x}`);
    assert.notEqual(gray[(h - 1) * w + x], 255, `bottom row x=${x}`);
  }
  for (let y = 0; y < h; y++) {
    assert.notEqual(gray[y * w], 255, `left column y=${y}`);
    assert.notEqual(gray[y * w + w - 1], 255, `right column y=${y}`);
  }
});
