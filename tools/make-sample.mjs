/**
 * Generates sample source artwork and exports panel-exact BMPs for every
 * device. Useful for eyeballing the dither output without a browser:
 *
 *   node tools/make-sample.mjs
 *
 * Writes samples/*.png (source art) and samples/*.bmp (device files).
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILES } from '../lib/profiles.js';
import { processImage } from '../lib/pipeline.js';
import { encodeBMP } from '../lib/bmp.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'samples');
mkdirSync(outDir, { recursive: true });

/* ── minimal PNG writer (RGBA, no filter) ─────────────────────────────────── */
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

function writePNG(rgba, width, height, file) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1
    );
  }
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ])
  );
}

/**
 * A deliberately photographic test chart: horizontal luminance ramp, radial
 * gradient, colour bars and a fine checkerboard — the four things that expose
 * resampling and dithering problems.
 */
function testChart(width, height) {
  const px = new Uint8ClampedArray(width * height * 4);
  const cx = width * 0.5;
  const cy = height * 0.42;
  const maxR = Math.min(width, height) * 0.42;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      let r;
      let g;
      let b;

      if (y < height * 0.18) {
        // colour bars
        const bar = Math.floor((x / width) * 6);
        const bars = [
          [220, 60, 60],
          [230, 160, 50],
          [230, 220, 70],
          [70, 180, 90],
          [70, 140, 220],
          [150, 90, 200],
        ];
        [r, g, b] = bars[Math.min(5, bar)];
      } else if (y > height * 0.86) {
        // fine checkerboard: 2 px, should average to mid grey
        const v = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 ? 20 : 236;
        r = g = b = v;
      } else {
        // radial gradient over a horizontal ramp
        const d = Math.hypot(x - cx, y - cy) / maxR;
        const ramp = x / width;
        const base = Math.max(0, Math.min(1, 0.65 - d * 0.45 + ramp * 0.5)) * 255;
        r = Math.min(255, base * 1.02 + 12);
        g = base;
        b = Math.min(255, base * 0.9 + 28);
      }
      px[p] = r;
      px[p + 1] = g;
      px[p + 2] = b;
      px[p + 3] = 255;
    }
  }
  return px;
}

const SRC_W = 1200;
const SRC_H = 1600;
const art = testChart(SRC_W, SRC_H);
writePNG(art, SRC_W, SRC_H, join(outDir, 'source-chart.png'));

const jobs = [
  { device: 'x4', format: 'bmp24', dither: 'floyd-steinberg', fit: 'cover', name: 'x4-sleep-24bit.bmp' },
  { device: 'x4', format: 'bmp2', dither: 'floyd-steinberg', fit: 'cover', name: 'x4-sleep-2bit.bmp' },
  { device: 'x4', format: 'bmp2', dither: 'atkinson', fit: 'contain', name: 'x4-sleep-atkinson.bmp' },
  { device: 'x4', format: 'bmp2', dither: 'bayer4', fit: 'cover', name: 'x4-sleep-ordered.bmp' },
  { device: 'x3', format: 'bmp24', dither: 'floyd-steinberg', fit: 'cover', name: 'x3-sleep-24bit.bmp' },
  { device: 'x3', format: 'bmp2', dither: 'floyd-steinberg', fit: 'cover', name: 'x3-sleep-2bit.bmp' },
  { device: 'x4pro', format: 'bmp2', dither: 'floyd-steinberg', fit: 'cover', name: 'x4pro-sleep-2bit.bmp' },
];

const started = Date.now();
for (const job of jobs) {
  const profile = PROFILES.find((p) => p.id === job.device);
  const t0 = Date.now();
  const out = processImage(art, SRC_W, SRC_H, {
    targetWidth: profile.width,
    targetHeight: profile.height,
    fit: job.fit,
    dither: job.dither,
    levels: 4,
  });
  const bytes = encodeBMP(out.gray, out.width, out.height, { format: job.format, levels: 4 });
  writeFileSync(join(outDir, job.name), Buffer.from(bytes));
  console.log(
    `${job.name.padEnd(26)} ${String(out.width).padStart(4)}×${String(out.height).padStart(4)} ` +
      `${String(bytes.length).padStart(9)} B  ${Date.now() - t0} ms`
  );

  // Also save the 1× PNG view of exactly what the panel will draw.
  const rgba = new Uint8ClampedArray(out.width * out.height * 4);
  for (let i = 0, p = 0; i < out.gray.length; i++, p += 4) {
    const v = out.gray[i];
    rgba[p] = rgba[p + 1] = rgba[p + 2] = v;
    rgba[p + 3] = 255;
  }
  writePNG(rgba, out.width, out.height, join(outDir, job.name.replace('.bmp', '.png')));
}
console.log(`done in ${Date.now() - started} ms`);
