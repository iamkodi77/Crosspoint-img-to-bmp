/**
 * Bitmap writer for CrossPoint sleep screens.
 *
 * CrossPoint's decoder needs a *real, uncompressed* BMP at exactly the panel
 * size. Three encodings are offered:
 *
 *   bmp24 — 24-bit BI_RGB. The most compatible: stock firmware and every
 *           CrossPoint build read it. 480×800 = 1,152,054 bytes.
 *   bmp2  — 2 bits per pixel, 4-entry palette. CrossPoint and CrossInk only.
 *           Same picture, a twelfth of the size (96,070 bytes at 480×800).
 *   bmp1  — 1 bit per pixel, pure black/white. Smallest, for line art.
 *
 * Rows are written bottom-up (as the BMP spec requires) and padded to a
 * 4-byte boundary.
 */

export const BMP_FORMATS = [
  {
    id: 'bmp24',
    name: '24-bit BMP',
    short: '24-bit',
    bits: 24,
    hint: 'Full compatibility — stock firmware and all CrossPoint builds.',
  },
  {
    id: 'bmp2',
    name: '2-bit BMP (4 greys)',
    short: '2-bit',
    bits: 2,
    hint: 'CrossPoint / CrossInk only. ~12× smaller, opens faster on the device.',
  },
  {
    id: 'bmp1',
    name: '1-bit BMP (2 tones)',
    short: '1-bit',
    bits: 1,
    hint: 'Pure black & white. Tiny files, best for logos and line art.',
  },
];

export function formatById(id) {
  return BMP_FORMATS.find((f) => f.id === id) || BMP_FORMATS[0];
}

/** Bytes per row including the 4-byte alignment pad. */
export function rowStride(width, bits) {
  const raw = Math.ceil((width * bits) / 8);
  return (raw + 3) & ~3;
}

/**
 * Palette for the paletted formats. The 2-bit palette is always the panel's
 * four native greys — CrossPoint checks that every entry sits within ±21 of
 * n*85 and skips its own ditherer when that holds, so a fixed native palette
 * keeps the file exactly as authored. A two-tone image simply uses indices 0
 * and 3.
 */
function paletteEntries(format) {
  if (format === 'bmp1') return [0, 255];
  if (format === 'bmp2') return [0, 85, 170, 255];
  return [];
}

/**
 * Encode an indexed-grey buffer as a BMP.
 *
 * @param {Uint8Array} gray one grey value per pixel (0..255), row-major top-down
 * @param {number} width
 * @param {number} height
 * @param {{format?: 'bmp24'|'bmp2'|'bmp1', levels?: number}} [options]
 * @returns {Uint8Array}
 */
export function encodeBMP(gray, width, height, options = {}) {
  const format = options.format || 'bmp24';
  if (gray.length !== width * height) {
    throw new Error(`Pixel buffer is ${gray.length} bytes, expected ${width * height}`);
  }
  const bits = formatById(format).bits;
  const stride = rowStride(width, bits);
  const pixels = stride * height;
  const palette = paletteEntries(format);
  const paletteBytes = palette.length * 4;
  const offset = 14 + 40 + paletteBytes;
  const total = offset + pixels;

  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  // BITMAPFILEHEADER
  buf[0] = 0x42; // 'B'
  buf[1] = 0x4d; // 'M'
  view.setUint32(2, total, true); // file size
  view.setUint32(6, 0, true); // reserved
  view.setUint32(10, offset, true); // pixel data offset

  // BITMAPINFOHEADER
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positive → bottom-up
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, bits, true);
  view.setUint32(30, 0, true); // BI_RGB, uncompressed
  view.setUint32(34, pixels, true);
  view.setInt32(38, 2835, true); // 72 DPI
  view.setInt32(42, 2835, true);
  view.setUint32(46, palette.length, true);
  view.setUint32(50, 0, true);

  // Palette (BGRA quads)
  palette.forEach((value, i) => {
    const p = 54 + i * 4;
    buf[p] = value;
    buf[p + 1] = value;
    buf[p + 2] = value;
    buf[p + 3] = 0;
  });

  // Pixels, bottom-up
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width;
    const dst = offset + y * stride;
    if (bits === 24) {
      for (let x = 0; x < width; x++) {
        const v = gray[srcRow + x];
        const p = dst + x * 3;
        buf[p] = v;
        buf[p + 1] = v;
        buf[p + 2] = v;
      }
    } else if (bits === 2) {
      const per = width > 0 ? Math.ceil((width * 2) / 8) : 0;
      for (let i = 0; i < per; i++) buf[dst + i] = 0;
      for (let x = 0; x < width; x++) {
        const idx = nearestPaletteIndex(gray[srcRow + x], palette);
        const byte = dst + (x >> 2);
        const shift = 6 - (x & 3) * 2;
        buf[byte] |= idx << shift;
      }
    } else {
      const per = width > 0 ? Math.ceil(width / 8) : 0;
      for (let i = 0; i < per; i++) buf[dst + i] = 0;
      for (let x = 0; x < width; x++) {
        // BMP 1-bit convention: a set bit is palette index 1, i.e. white.
        if (gray[srcRow + x] >= 128) buf[dst + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  return buf;
}

function nearestPaletteIndex(value, palette) {
  let best = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = Math.abs(palette[i] - value);
    if (d < bestDelta) {
      bestDelta = d;
      best = i;
    }
  }
  return best;
}

/**
 * Minimal reader used by the self-test and by "verify this file" tooling.
 * @param {Uint8Array} buf
 */
export function decodeBMP(buf) {
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) throw new Error('Not a BMP (bad magic)');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const offset = view.getUint32(10, true);
  const headerSize = view.getUint32(14, true);
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const bits = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const stride = rowStride(width, bits);
  const paletteCount = view.getUint32(46, true) || (bits <= 8 ? 1 << bits : 0);
  const palette = [];
  for (let i = 0; i < paletteCount; i++) palette.push(buf[54 + i * 4]);

  const gray = new Uint8Array(width * height);
  const indexAt = (x, y) => {
    const row = topDown ? y : height - 1 - y;
    const base = offset + row * stride;
    if (bits === 24) return buf[base + x * 3 + 1];
    if (bits === 2) return (buf[base + (x >> 2)] >> (6 - (x & 3) * 2)) & 0x03;
    return (buf[base + (x >> 3)] >> (7 - (x & 7))) & 0x01;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = indexAt(x, y);
      gray[y * width + x] = bits === 24 ? idx : palette[idx];
    }
  }
  return { width, height, bits, compression, headerSize, palette, gray, fileSize: view.getUint32(2, true) };
}

/** Wrap encoded bytes in a Blob for download. */
export function toBlob(bytes, type = 'image/bmp') {
  return new Blob([bytes], { type });
}
