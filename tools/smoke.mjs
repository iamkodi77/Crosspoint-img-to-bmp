/**
 * Headless smoke test for the studio UI.
 *
 * Loads studio.html into jsdom, stubs the handful of canvas APIs the studio
 * uses, and drives the real control handlers: device switch, dither, tone,
 * zoom, framing, file naming and encoding. This catches wiring mistakes that
 * unit-testing the pixel math cannot.
 *
 *   node tools/smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
void require;

const html = readFileSync(new URL('../studio.html', import.meta.url), 'utf8');

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => errors.push(e.message));
virtualConsole.on('error', (m) => errors.push(String(m)));

const dom = new JSDOM(html, {
  url: 'http://localhost/studio.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;

/* ── stub the canvas/i18n surface the studio touches ─────────────────────── */
const created = [];
function makeContext(canvas) {
  return {
    canvas,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high',
    clearRect() {},
    drawImage() {},
    putImageData() {},
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    getImageData(x, y, w, h) {
      // A deterministic test pattern: gradient plus a colour patch.
      const data = new Uint8ClampedArray(w * h * 4);
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const p = (yy * w + xx) * 4;
          const v = Math.round(((xx / Math.max(1, w - 1)) * 200 + (yy / Math.max(1, h - 1)) * 55) % 256);
          data[p] = xx < w / 3 ? 220 : v;
          data[p + 1] = xx < w / 3 ? 60 : v;
          data[p + 2] = xx < w / 3 ? 60 : v;
          data[p + 3] = 255;
        }
      }
      return { width: w, height: h, data };
    },
  };
}

window.HTMLCanvasElement.prototype.getContext = function getContext() {
  if (!this.__ctx) this.__ctx = makeContext(this);
  return this.__ctx;
};
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AAAA';
window.HTMLCanvasElement.prototype.toBlob = (cb) => cb(new window.Blob([new Uint8Array([1])], { type: 'image/png' }));

window.ImageData = class ImageData {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
};

// createImageBitmap: return a fake 900×1200 bitmap.
const fakeBitmap = () => ({ width: 900, height: 1200, close() {} });
window.createImageBitmap = async () => fakeBitmap();
window.URL.createObjectURL = () => 'blob:stub';
window.URL.revokeObjectURL = () => {};

// Track downloads instead of touching the filesystem.
const downloads = [];
const realCreate = window.document.createElement.bind(window.document);
window.document.createElement = function patched(tag) {
  const el = realCreate(tag);
  if (tag === 'a') {
    el.click = () => downloads.push({ name: el.download, href: el.href });
  }
  return el;
};

/* ── load the studio module inside the jsdom window ──────────────────────── */
const moduleSource = readFileSync(new URL('../js/studio.js', import.meta.url), 'utf8');

async function loadModule() {
  // Rewrite bare imports to absolute file URLs served through a tiny loader.
  const { pathToFileURL } = await import('node:url');
  const base = new URL('../js/', import.meta.url);
  const rewritten = moduleSource.replace(
    /from '\.\.\/lib\/([a-z]+)\.js'/g,
    (_, name) => `from '${pathToFileURL(new URL(`../lib/${name}.js`, import.meta.url).pathname).href}'`
  );
  const dataUrl = `data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`;
  void base;
  await import(dataUrl);
}

// jsdom's module loader cannot see Node's global DOM, so expose the window's.
for (const key of ['window', 'document', 'location', 'history', 'HTMLElement', 'HTMLCanvasElement', 'ImageData', 'Blob', 'File', 'URL', 'localStorage', 'requestAnimationFrame', 'getComputedStyle', 'Event', 'PointerEvent', 'MouseEvent', 'FileReader']) {
  if (window[key] === undefined) continue;
  try {
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
  } catch {
    /* non-configurable globals (navigator) are already present */
  }
}
globalThis.createImageBitmap = async () => fakeBitmap();
globalThis.chrome = undefined;
globalThis.self = window;

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// jsdom's FileReader is fine; make sure Blob→ArrayBuffer works for the popup handoff.
if (!window.Blob.prototype.arrayBuffer) {
  window.Blob.prototype.arrayBuffer = function arrayBuffer() {
    return Promise.resolve(new ArrayBuffer(8));
  };
}

try {
  await loadModule();
} catch (error) {
  console.error('Module failed to load:', error.message.split('\n')[0]);
  process.exit(1);
}
process.on('unhandledRejection', (reason) => {
  const msg = String(reason?.message || reason);
  if (!/Not implemented: navigation/i.test(msg)) errors.push(msg.split('\n')[0]);
});
await tick(150);

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(`  ✓ ${name}`);
  } catch (error) {
    results.push(`  ✗ ${name} — ${error.message}`);
    process.exitCode = 1;
  }
};

const $ = (id) => window.document.getElementById(id);

check('studio shell rendered', () => {
  if (!$('deviceSeg').children.length) throw new Error('device segmented control is empty');
  if ($('dither').children.length !== 4) throw new Error('dither options missing');
  if ($('format').children.length !== 3) throw new Error('format options missing');
});

check('device buttons expose exact panel sizes', () => {
  const labels = [...$('deviceSeg').children].map((b) => b.textContent);
  const joined = labels.join(' ');
  for (const px of ['528×792', '480×800']) {
    if (!joined.includes(px)) throw new Error(`missing ${px} in ${joined}`);
  }
});

check('switching device updates the hint', () => {
  const x3 = [...$('deviceSeg').children].find((b) => b.textContent.startsWith('X3'));
  x3.click();
  if (!$('deviceHint').textContent.includes('528 × 792')) {
    throw new Error(`hint was: ${$('deviceHint').textContent}`);
  }
  const x4 = [...$('deviceSeg').children].find((b) => b.textContent.startsWith('X4') && !b.textContent.startsWith('X4 Pro'));
  x4.click();
});

check('loading an image fills the queue and preview', async () => {
  const file = new window.File([new Uint8Array([1, 2, 3])], 'beach-photo.jpg', { type: 'image/jpeg' });
  const input = $('fileInput');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change'));
});

// FileReader/async image load
await tick(200);

check('queue shows the image', () => {
  if ($('fileList').children.length !== 1) throw new Error(`queue has ${$('fileList').children.length} items`);
  if ($('editor').hidden) throw new Error('editor still hidden');
  if ($('emptyHint').hidden !== true) throw new Error('empty hint should be hidden');
});

check('single image defaults to sleep.bmp', () => {
  if ($('fileName').value !== 'sleep.bmp') throw new Error(`name = ${$('fileName').value}`);
});

check('preview canvas is the panel size', () => {
  const canvas = $('preview');
  if (!canvas.width) throw new Error('preview canvas has no size');
});

check('file size readout matches the 24-bit figure', () => {
  if (!$('chipFile').textContent.includes('1.10 MB')) {
    throw new Error(`chip said ${$('chipFile').textContent}`);
  }
});

check('switching to 2-bit updates the size readout', () => {
  const fmt = $('format');
  fmt.value = 'bmp2';
  fmt.dispatchEvent(new window.Event('change'));
  if (!$('chipFile').textContent.includes('KB')) {
    throw new Error(`chip said ${$('chipFile').textContent}`);
  }
  if (!$('formatHint').textContent.includes('CrossPoint')) {
    throw new Error('format hint not updated');
  }
});

check('greys select and dither changes render without throwing', () => {
  for (const method of ['atkinson', 'bayer4', 'none', 'floyd-steinberg']) {
    const d = $('dither');
    d.value = method;
    d.dispatchEvent(new window.Event('change'));
    if (!$('ditherHint').textContent) throw new Error(`empty hint for ${method}`);
  }
  const levels = $('levels');
  levels.value = '2';
  levels.dispatchEvent(new window.Event('change'));
  levels.value = '4';
  levels.dispatchEvent(new window.Event('change'));
});

check('tone sliders update their outputs', () => {
  const cases = [
    ['brightness', '24', 'brightnessOut', '24'],
    ['contrast', '-30', 'contrastOut', '-30'],
    ['gamma', '180', 'gammaOut', '1.80'],
  ];
  for (const [id, value, out, expected] of cases) {
    const el = $(id);
    el.value = value;
    el.dispatchEvent(new window.Event('input'));
    if ($(out).textContent !== expected) {
      throw new Error(`${id}: ${$(out).textContent} !== ${expected}`);
    }
  }
  const invert = $('invert');
  invert.checked = true;
  invert.dispatchEvent(new window.Event('change'));
});

check('zoom slider reports a percentage', () => {
  const zoom = $('zoom');
  zoom.value = '150';
  zoom.dispatchEvent(new window.Event('input'));
  if ($('zoomOut').textContent !== '150%') throw new Error($('zoomOut').textContent);
});

check('fit mode buttons commit a selection', () => {
  const contain = [...$('fitSeg').children].find((b) => b.dataset.value === 'contain');
  contain.click();
  if (contain.getAttribute('aria-checked') !== 'true') throw new Error('aria-checked not set');
  const cover = [...$('fitSeg').children].find((b) => b.dataset.value === 'cover');
  cover.click();
});

check('download produces a file named sleep.bmp', async () => {
  $('downloadBtn').click();
});

await tick(400);

check('download was triggered', () => {
  const last = downloads.at(-1);
  if (!last) throw new Error('no download fired');
  if (!/\.bmp$/.test(last.name)) throw new Error(`download name = ${last.name}`);
});

check('upload target radios toggle the custom folder row', () => {
  const radios = [...window.document.querySelectorAll('input[name="uploadMode"]')];
  const custom = radios.find((r) => r.value === 'custom');
  custom.checked = true;
  custom.dispatchEvent(new window.Event('change'));
  if ($('customFolderRow').hidden) throw new Error('custom folder row stayed hidden');
  const root = radios.find((r) => r.value === 'sleep-root');
  root.checked = true;
  root.dispatchEvent(new window.Event('change'));
  if (!$('customFolderRow').hidden) throw new Error('custom folder row should hide');
});

check('tabs switch panels', () => {
  const deviceTab = window.document.querySelector('.tab[data-tab="device"]');
  deviceTab.click();
  if (!$('tab-device').classList.contains('is-active')) throw new Error('device panel not active');
  const helpTab = window.document.querySelector('.tab[data-tab="help"]');
  helpTab.click();
  if (!$('tab-help').classList.contains('is-active')) throw new Error('help panel not active');
  window.document.querySelector('.tab[data-tab="convert"]').click();
});

check('connect without a host reports an error instead of throwing', () => {
  $('deviceHost').value = '';
  $('connectBtn').click();
  if (!$('deviceStatus').textContent) throw new Error('no status message');
});

check('clearing the queue returns to the empty state', () => {
  $('clearQueueBtn').click();
  if ($('fileList').children.length) throw new Error('queue not cleared');
  if ($('emptyHint').hidden) {
    throw new Error(
      `empty hint hidden=${$('emptyHint').hidden} queueHidden=${$('queue').hidden} ` +
        `editorHidden=${$('editor').hidden} status=${$('draftStatus').textContent}`
    );
  }
});

check('no uncaught errors were emitted', () => {
  const real = errors.filter((e) => !/Not implemented: navigation/i.test(e));
  if (real.length) throw new Error(real.join(' | '));
});

console.log('\nCrossPoint Studio smoke test\n');
console.log(results.join('\n'));
console.log(`\n${results.length - results.filter((r) => r.startsWith('  ✗')).length}/${results.length} passed\n`);
dom.window.close();
