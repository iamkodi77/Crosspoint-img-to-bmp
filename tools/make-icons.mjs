/**
 * Generates the PNG icons with zero dependencies (zlib only).
 * Drawn to look like an e-ink page with a dithered photo on it: a dark frame,
 * a light panel, and a wave of dither dots.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [0x14, 0x17, 0x1c];
const PANEL = [0xf6, 0xf4, 0xef];
const ACCENT = [0x0f, 0x76, 0x6e];
const DOT = [0x12, 0x15, 0x1a];

/** 4x4 Bayer threshold map, used to fake the e-ink dither. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function draw(size) {
  const px = new Uint8Array(size * size * 4);
  const put = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  };

  const radius = size * 0.22;
  const inRounded = (x, y) => {
    const pts = [
      [radius, radius],
      [size - 1 - radius, radius],
      [radius, size - 1 - radius],
      [size - 1 - radius, size - 1 - radius],
    ];
    if (x > radius && x < size - 1 - radius) return y >= 0 && y <= size - 1;
    if (y > radius && y < size - 1 - radius) return x >= 0 && x <= size - 1;
    return pts.some(([cx, cy]) => Math.hypot(x - cx, y - cy) <= radius);
  };

  // Rounded background
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inRounded(x, y)) put(x, y, BG);
    }
  }

  // Screen area
  const padX = Math.round(size * 0.19);
  const padTop = Math.round(size * 0.15);
  const padBottom = Math.round(size * 0.29);
  const x0 = padX;
  const x1 = size - padX;
  const y0 = padTop;
  const y1 = size - padBottom;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      // A hill/valley gradient so the dither has something to describe.
      const u = (x - x0) / Math.max(1, x1 - x0);
      const v = (y - y0) / Math.max(1, y1 - y0);
      const wave = 0.5 + 0.5 * Math.sin(u * Math.PI * 1.6 + 0.6);
      const shade = Math.min(1, Math.max(0, wave * 0.85 + (1 - v) * 0.35));
      const threshold = (BAYER[y & 3][x & 3] + 0.5) / 16;
      const lit = shade > threshold;
      put(x, y, lit ? PANEL : ACCENT);
    }
  }

  // Two "page" lines under the screen for the e-reader cue
  if (size >= 32) {
    const lineY = y1 + Math.max(2, Math.round(size * 0.05));
    const thickness = Math.max(1, Math.round(size * 0.035));
    const inset = Math.round(size * 0.27);
    for (let y = lineY; y < lineY + thickness; y++) {
      for (let x = inset; x < size - inset; x++) put(x, y, DOT);
    }
    const line2 = lineY + thickness + Math.max(1, Math.round(size * 0.05));
    for (let y = line2; y < line2 + thickness; y++) {
      for (let x = inset + Math.round(size * 0.06); x < size - inset - Math.round(size * 0.12); x++) {
        put(x, y, ACCENT);
      }
    }
  }

  return px;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(draw(size), size);
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
