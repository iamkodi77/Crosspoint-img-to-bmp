/**
 * Image → e-ink pipeline.
 *
 * Everything in this module is plain arithmetic on typed arrays, with no DOM
 * or canvas dependency, so it can be unit-tested in Node and reused from the
 * extension page, the popup and any worker.
 *
 * Stages:
 *   1. decode   : RGBA bytes → luma floats, composited over a background
 *   2. layout   : work out scale + offset so the image is placed on the panel
 *   3. resample : area-average (downscale) or bilinear (upscale) onto the panel
 *   4. tone     : gamma, contrast, brightness, invert
 *   5. render   : quantise to the panel's grey levels, with dithering
 *
 * The output is always exactly `targetWidth × targetHeight` pixels — never a
 * fraction more — because the firmware does not scale.
 */

export const DITHER_METHODS = [
  { id: 'floyd-steinberg', name: 'Floyd–Steinberg', hint: 'Classic error diffusion. Best all-round detail.' },
  { id: 'atkinson', name: 'Atkinson', hint: 'Lighter diffusion, crisper contrast. Good for line art.' },
  { id: 'bayer4', name: 'Ordered 4×4', hint: 'Regular cross-hatch pattern. No smearing, very stable.' },
  { id: 'none', name: 'None (posterise)', hint: 'Flat grey bands. Cleanest for logos and text.' },
];

/** Grey levels the panel can physically draw. */
export function paletteFor(levels) {
  if (levels === 2) return [0, 255];
  return [0, 85, 170, 255];
}

/**
 * Greyscale luminance from RGBA bytes, using the same integer weights the
 * CrossPoint firmware uses when it converts a colour BMP
 * (`(77*R + 150*G + 29*B) >> 8` in lib/GfxRenderer/Bitmap.cpp). Matching those
 * weights means a photo converted here looks like the same photo converted by
 * the device itself. Transparent pixels are blended onto `bg`.
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {number} [bg] background luma used for alpha
 * @returns {Float32Array}
 */
export function rgbaToLuma(rgba, width, height, bg = 255) {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const luma = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2]) / 256;
    const a = p + 3 < rgba.length ? rgba[p + 3] / 255 : 1;
    out[i] = a >= 1 ? luma : luma * a + bg * (1 - a);
  }
  return out;
}

/**
 * Scale + offset that places a source image on the panel.
 *
 * `fit`:
 *   cover   — fill the panel, crop the overflow (no borders)
 *   contain — whole image visible, padded with the background colour
 *   stretch — ignore aspect ratio, fill exactly
 *
 * `zoom` multiplies the fitted scale and `pan` offsets are in panel pixels.
 *
 * @returns {{sx:number,sy:number,offX:number,offY:number,drawnW:number,drawnH:number}}
 */
export function computeLayout(sw, sh, tw, th, { fit = 'cover', zoom = 1, panX = 0, panY = 0 } = {}) {
  let baseX;
  let baseY;
  if (fit === 'stretch') {
    baseX = tw / sw;
    baseY = th / sh;
  } else if (fit === 'contain') {
    baseX = baseY = Math.min(tw / sw, th / sh);
  } else {
    baseX = baseY = Math.max(tw / sw, th / sh);
  }
  const z = Math.max(0.1, Number(zoom) || 1);
  const sx = baseX * z;
  const sy = baseY * z;
  const drawnW = sw * sx;
  const drawnH = sh * sy;
  const clamped = clampPan(drawnW, drawnH, tw, th, panX, panY);
  return {
    sx,
    sy,
    offX: (tw - drawnW) / 2 + clamped.panX,
    offY: (th - drawnH) / 2 + clamped.panY,
    drawnW,
    drawnH,
  };
}

/**
 * Limit panning so the image can never be dragged off the panel: a cover fit
 * always keeps the screen covered, a contain fit keeps the image on screen.
 */
export function clampPan(drawnW, drawnH, tw, th, panX = 0, panY = 0) {
  const limitX = Math.abs(tw - drawnW) / 2;
  const limitY = Math.abs(th - drawnH) / 2;
  return {
    panX: Math.max(-limitX, Math.min(limitX, panX || 0)),
    panY: Math.max(-limitY, Math.min(limitY, panY || 0)),
  };
}

/** Prefix-sum table for O(1) box averages. */
function buildIntegral(src, w, h) {
  const stride = w + 1;
  const I = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const srcRow = y * w;
    const outRow = (y + 1) * stride;
    const prevRow = y * stride;
    for (let x = 0; x < w; x++) {
      rowSum += src[srcRow + x];
      I[outRow + x + 1] = I[prevRow + x + 1] + rowSum;
    }
  }
  return I;
}

function boxMean(I, w, x0, y0, x1, y1) {
  const stride = w + 1;
  const a = I[y0 * stride + x0];
  const b = I[y0 * stride + x1];
  const c = I[y1 * stride + x0];
  const d = I[y1 * stride + x1];
  return d - b - c + a;
}

/**
 * Place `src` on a `tw × th` canvas using the supplied layout.
 * @returns {Float32Array} length tw*th, values 0..255
 */
export function resample(src, sw, sh, tw, th, layout, { background = 255 } = {}) {
  const { sx, sy, offX, offY } = layout;
  const out = new Float32Array(tw * th);
  if (!(sx > 0) || !(sy > 0)) {
    out.fill(background);
    return out;
  }

  // Downscaling uses an exact area average; upscaling uses bilinear.
  const downscale = sx <= 1 + 1e-9 && sy <= 1 + 1e-9;
  const I = downscale ? buildIntegral(src, sw, sh) : null;

  // Horizontal weights are identical for every row, so compute them once.
  const spans = new Array(tw);
  for (let x = 0; x < tw; x++) {
    const a = (x - offX) / sx;
    const b = (x + 1 - offX) / sx;
    spans[x] = buildSpan(a, b, sw);
  }

  for (let y = 0; y < th; y++) {
    const outRow = y * tw;

    if (downscale) {
      const ySpan = buildSpan((y - offY) / sy, (y + 1 - offY) / sy, sh);
      if (ySpan.coverage <= 0) {
        out.fill(background, outRow, outRow + tw);
        continue;
      }
      for (let x = 0; x < tw; x++) {
        const span = spans[x];
        let value = background;
        if (span.coverage > 0) {
          let sum = 0;
          for (let j = 0; j < ySpan.weights.length; j++) {
            const wy = ySpan.weights[j];
            const rowBase = (ySpan.start + j) * sw;
            let acc = 0;
            for (let i = 0; i < span.weights.length; i++) acc += src[rowBase + span.start + i] * span.weights[i];
            sum += acc * wy;
          }
          // Both spans normalise to 1, so `sum` is the box average already.
          const coverage = span.coverage * ySpan.coverage;
          value = sum * coverage + background * (1 - coverage);
        }
        out[outRow + x] = value;
      }
    } else {
      const v = (y + 0.5 - offY) / sy - 0.5;
      if (v < -0.5 || v > sh - 0.5) {
        out.fill(background, outRow, outRow + tw);
        continue;
      }
      const y0 = Math.max(0, Math.min(sh - 1, Math.floor(v)));
      const y1 = Math.max(0, Math.min(sh - 1, y0 + 1));
      const fy = Math.max(0, Math.min(1, v - y0));
      for (let x = 0; x < tw; x++) {
        const u = (x + 0.5 - offX) / sx - 0.5;
        if (u < -0.5 || u > sw - 0.5) {
          out[outRow + x] = background;
          continue;
        }
        const x0 = Math.max(0, Math.min(sw - 1, Math.floor(u)));
        const x1 = Math.max(0, Math.min(sw - 1, x0 + 1));
        const fx = Math.max(0, Math.min(1, u - x0));
        const top = src[y0 * sw + x0] * (1 - fx) + src[y0 * sw + x1] * fx;
        const bottom = src[y1 * sw + x0] * (1 - fx) + src[y1 * sw + x1] * fx;
        out[outRow + x] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return out;
}

/**
 * Break a source-space interval [a, b) into the source pixels it covers,
 * weighting each by how much of its length lies inside the interval. Weights
 * always sum to 1 for the covered part, so the result is a weighted average.
 *
 * @returns {{start:number, weights:number[], coverage:number}} `start` is the
 *   first source index, `coverage` is the fraction of the interval that lies
 *   inside the source (0..1).
 */
function buildSpan(a, b, length) {
  const span = Math.max(1e-9, b - a);
  const lo = Math.max(0, Math.min(length, a));
  const hi = Math.max(0, Math.min(length, b));
  const covered = Math.max(0, hi - lo);
  if (covered <= 0) return { start: 0, weights: [], coverage: 0 };

  const first = Math.floor(lo);
  const last = Math.min(length - 1, Math.ceil(hi) - 1);
  const weights = [];
  let total = 0;
  for (let i = first; i <= last; i++) {
    const overlap = Math.min(hi, i + 1) - Math.max(lo, i);
    if (overlap <= 0) {
      weights.push(0);
      continue;
    }
    weights.push(overlap);
    total += overlap;
  }
  if (total <= 0) return { start: 0, weights: [], coverage: 0 };
  for (let i = 0; i < weights.length; i++) weights[i] /= total;
  return { start: first, weights, coverage: covered / span };
}

/**
 * Tone controls, applied in a fixed order: gamma → contrast → brightness →
 * invert. `brightness` and `contrast` are -100..100, `gamma` is 0.2..3.
 */
export function applyTone(data, { brightness = 0, contrast = 0, gamma = 1, invert = false } = {}) {
  const b = Math.max(-100, Math.min(100, brightness || 0)) * 1.28;
  const c = Math.max(-100, Math.min(100, contrast || 0)) * 2.55;
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  const g = Math.max(0.2, Math.min(3, gamma || 1));
  const needsGamma = Math.abs(g - 1) > 0.001;
  const inv = 1 / g;

  for (let i = 0; i < data.length; i++) {
    let v = data[i];
    if (needsGamma) v = 255 * Math.pow(Math.max(0, Math.min(255, v)) / 255, inv);
    v = cf * (v - 128) + 128 + b;
    if (invert) v = 255 - v;
    data[i] = v;
  }
  return data;
}

/** 4×4 Bayer matrix, normalised to -0.5..0.5. */
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/**
 * Quantise to the panel's grey levels.
 * @param {Float32Array} src tone-mapped luma, length w*h
 * @param {number} w
 * @param {number} h
 * @param {{levels?:number, method?:string}} opts
 * @returns {Uint8Array} one palette grey value per pixel, row-major top-down
 */
export function render(src, w, h, { levels = 4, method = 'floyd-steinberg' } = {}) {
  const palette = paletteFor(levels);
  const steps = palette.length - 1;
  const step = 255 / steps;
  const out = new Uint8Array(w * h);
  const nearestIndex = (v) => {
    const i = Math.round(v / step);
    return i < 0 ? 0 : i > steps ? steps : i;
  };

  if (method === 'none') {
    for (let i = 0; i < src.length; i++) out[i] = palette[nearestIndex(src[i])];
    return out;
  }

  if (method === 'bayer4') {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const mask = BAYER4[y & 3];
      for (let x = 0; x < w; x++) {
        const t = (mask[x & 3] / 16 - 0.46875) * step;
        out[row + x] = palette[nearestIndex(src[row + x] + t)];
      }
    }
    return out;
  }

  // Error diffusion needs a mutable working copy.
  const buf = Float32Array.from(src);

  const diffuse = (x, y, err, nx, ny) => {
    if (ny < 0 || ny >= h || nx < 0 || nx >= w) return;
    buf[ny * w + nx] += err;
  };

  for (let y = 0; y < h; y++) {
    const row = y * w;
    const serpentine = (y & 1) === 1;
    const dir = serpentine ? -1 : 1;
    for (let n = 0; n < w; n++) {
      const x = serpentine ? w - 1 - n : n;
      const idx = row + x;
      const old = buf[idx];
      const pi = nearestIndex(old);
      const next = palette[pi];
      out[idx] = next;
      const err = old - next;

      if (method === 'atkinson') {
        const e = err / 8;
        diffuse(x, y, e, x + dir, y);
        diffuse(x, y, e, x + dir * 2, y);
        diffuse(x, y, e, x - dir, y + 1);
        diffuse(x, y, e, x, y + 1);
        diffuse(x, y, e, x + dir, y + 1);
        diffuse(x, y, e, x, y + 2);
      } else {
        // Floyd–Steinberg
        diffuse(x, y, (err * 7) / 16, x + dir, y);
        diffuse(x, y, (err * 3) / 16, x - dir, y + 1);
        diffuse(x, y, (err * 5) / 16, x, y + 1);
        diffuse(x, y, (err * 1) / 16, x + dir, y + 1);
      }
    }
  }
  return out;
}

/**
 * Full pipeline. Output is exactly targetWidth × targetHeight.
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {object} options
 * @returns {{gray:Uint8Array,width:number,height:number,levels:number,palette:number[]}}
 */
export function processImage(rgba, sourceWidth, sourceHeight, options = {}) {
  const {
    targetWidth,
    targetHeight,
    fit = 'cover',
    zoom = 1,
    panX = 0,
    panY = 0,
    background = 255,
    brightness = 0,
    contrast = 0,
    gamma = 1,
    invert = false,
    levels = 4,
    dither = 'floyd-steinberg',
  } = options;

  const luma = rgbaToLuma(rgba, sourceWidth, sourceHeight, background);
  const layout = computeLayout(sourceWidth, sourceHeight, targetWidth, targetHeight, {
    fit,
    zoom,
    panX,
    panY,
  });
  const placed = resample(luma, sourceWidth, sourceHeight, targetWidth, targetHeight, layout, {
    background,
  });
  applyTone(placed, { brightness, contrast, gamma, invert });
  const gray = render(placed, targetWidth, targetHeight, { levels, dither });
  return { gray, width: targetWidth, height: targetHeight, levels, palette: paletteFor(levels) };
}

/**
 * Downscale a decoded photo that is far larger than the panel before handing
 * it to the pipeline. Keeps memory bounded and the box filter does the rest.
 */
export function workingSize(width, height, cap = 2048) {
  const longest = Math.max(width, height);
  if (longest <= cap) return { width, height, scaled: false };
  const k = cap / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), scaled: true };
}
