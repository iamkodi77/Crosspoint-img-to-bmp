/**
 * Canvas preview helpers.
 *
 * The preview is the *actual output pixels* blown up with nearest-neighbour
 * scaling, so what you see is what the panel receives — no browser smoothing,
 * no CSS filter standing in for the dither.
 */
import { processImage } from './pipeline.js';

/**
 * @typedef {object} RenderOptions
 * @property {number} targetWidth
 * @property {number} targetHeight
 * @property {'cover'|'contain'|'stretch'} [fit]
 * @property {number} [zoom]
 * @property {number} [panX]
 * @property {number} [panY]
 * @property {number} [brightness]
 * @property {number} [contrast]
 * @property {number} [gamma]
 * @property {boolean} [invert]
 * @property {number} [levels]
 * @property {string} [dither]
 */

/**
 * Run the pipeline and return the panel-sized ImageData.
 * @param {CanvasImageSource & {width:number,height:number}} source a canvas holding the photo
 * @param {RenderOptions} options
 */
export function renderToImageData(source, options) {
  const sw = source.width;
  const sh = source.height;
  const scratch = document.createElement('canvas');
  scratch.width = sw;
  scratch.height = sh;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  sctx.clearRect(0, 0, sw, sh);
  sctx.drawImage(source, 0, 0);
  const { data } = sctx.getImageData(0, 0, sw, sh);

  const result = processImage(data, sw, sh, options);

  const out = new ImageData(options.targetWidth, options.targetHeight);
  for (let i = 0, p = 0; i < result.gray.length; i++, p += 4) {
    const v = result.gray[i];
    out.data[p] = v;
    out.data[p + 1] = v;
    out.data[p + 2] = v;
    out.data[p + 3] = 255;
  }
  return { imageData: out, result };
}

/**
 * Paint the panel image onto a display canvas at an integer scale factor so
 * dither dots stay crisp.
 * @param {HTMLCanvasElement} canvas
 * @param {ImageData} imageData
 * @param {number} cssWidth target CSS width in px
 */
export function paintScaled(canvas, imageData, cssWidth) {
  const scale = Math.max(1, Math.floor(cssWidth / imageData.width));
  canvas.width = imageData.width * scale;
  canvas.height = imageData.height * scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const tmp = document.createElement('canvas');
  tmp.width = imageData.width;
  tmp.height = imageData.height;
  tmp.getContext('2d').putImageData(imageData, 0, 0);
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${Math.round((cssWidth / imageData.width) * imageData.height)}px`;
  return scale;
}

/**
 * Load an image file into a canvas, downscaling very large photos so the
 * pipeline stays fast and memory stays bounded.
 * @param {File|Blob} file
 * @param {number} [cap]
 * @returns {Promise<{canvas:HTMLCanvasElement,name:string,sourceWidth:number,sourceHeight:number,preview:string}>}
 */
export async function loadImage(file, cap = 2400) {
  const bitmap = await createImageBitmap(file);
  const longest = Math.max(bitmap.width, bitmap.height);
  const k = longest > cap ? cap / longest : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * k));
  canvas.height = Math.max(1, Math.round(bitmap.height * k));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return {
    canvas,
    name: file.name || 'pasted-image',
    sourceWidth: bitmap.width,
    sourceHeight: bitmap.height,
    preview: canvas.toDataURL('image/jpeg', 0.85),
  };
}
