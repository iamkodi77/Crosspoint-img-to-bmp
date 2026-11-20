/**
 * CrossPoint Studio — main controller.
 *
 * Owns the queue, the live preview and the export path. All pixel math lives
 * in lib/pipeline.js and all BMP bytes come from lib/bmp.js, so this file only
 * deals with UI state and canvas plumbing.
 */
import { PROFILES, getProfile } from '../lib/profiles.js';
import { BMP_FORMATS, formatById, encodeBMP, toBlob } from '../lib/bmp.js';
import { DITHER_METHODS } from '../lib/pipeline.js';
import { renderToImageData, paintScaled, loadImage } from '../lib/canvas.js';
import { loadSettings, saveSettings, destinationFor, DEFAULT_SETTINGS } from '../lib/store.js';
import { probe, uploadFile, verifyUpload, listFiles, ensureFolder } from '../lib/device.js';
import { buildZip } from '../lib/zip.js';

const $ = (id) => document.getElementById(id);

/** @type {Array<{id:string,name:string,canvas:HTMLCanvasElement,sourceWidth:number,sourceHeight:number,thumb:string,size:number}>} */
let queue = [];
let activeId = null;
let settings = { ...DEFAULT_SETTINGS };
let zoom = 1;
let panX = 0;
let panY = 0;
let renderHandle = 0;
let rendering = false;
let pending = false;
let connection = null; // { origin, status }
let browsePath = '/';

const MAX_QUEUE = 40;

/* ───────────────────────────────── helpers ───────────────────────────────── */

function toast(message, kind = '') {
  const stack = $('toastStack');
  const el = document.createElement('div');
  el.className = `toast${kind ? ` is-${kind}` : ''}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 260);
  }, kind === 'err' ? 6500 : 3200);
}

function setStatus(text, kind = '') {
  const el = $('draftStatus');
  el.textContent = text;
  el.className = `topbar-status${kind ? ` is-${kind}` : ''}`;
}

const activeProfile = () => getProfile(settings.profileId);
const activeItem = () => queue.find((item) => item.id === activeId) || null;
const formatInfo = () => formatById(settings.format);

function sanitizeBase(name) {
  const base = String(name || 'image')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'image';
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * The name CrossPoint looks for. A single image must be "sleep.bmp"; for a
 * batch each file keeps its own name so the reader can rotate through them.
 */
function autoFileName(item) {
  if (queue.length <= 1) return 'sleep.bmp';
  return `${sanitizeBase(item?.name)}.bmp`;
}

function bytesLabel(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function setBusy(busy) {
  $('downloadBtn').disabled = busy;
  $('downloadZipBtn').disabled = busy || queue.length === 0;
  $('downloadPngBtn').disabled = busy || !activeItem();
  $('sendBtn').disabled = busy || !connection;
  $('uploadCurrentBtn').disabled = busy || !connection || !activeItem();
  $('uploadAllBtn').disabled = busy || !connection || queue.length === 0;
}

/* ───────────────────────────────── rendering ─────────────────────────────── */

function currentRenderOptions(item = activeItem()) {
  const profile = activeProfile();
  const framing = framingFor(item);
  return {
    targetWidth: profile.width,
    targetHeight: profile.height,
    fit: settings.fit,
    zoom: framing.zoom,
    panX: framing.panX,
    panY: framing.panY,
    background: 255,
    brightness: settings.brightness,
    contrast: settings.contrast,
    gamma: settings.gamma,
    invert: settings.invert,
    levels: settings.levels,
    dither: settings.dither,
  };
}

/** Render the active image. Coalesces bursts of slider input into one pass. */
async function renderPreview() {
  const item = activeItem();
  const canvas = $('preview');
  if (!item) {
    canvas.width = 0;
    canvas.height = 0;
    return null;
  }
  if (rendering) {
    pending = true;
    return null;
  }
  rendering = true;
  const handle = ++renderHandle;
  try {
    const { imageData } = renderToImageData(item.canvas, currentRenderOptions(item));
    if (handle !== renderHandle) return null;
    const boxWidth = Math.min(320, Math.max(220, window.innerWidth * 0.26));
    paintScaled(canvas, imageData, boxWidth);
    updateMeta(imageData);
    return imageData;
  } catch (error) {
    console.error(error);
    toast(`Render failed: ${error.message}`, 'err');
    return null;
  } finally {
    rendering = false;
    if (pending) {
      pending = false;
      renderPreview();
    }
  }
}

function updateMeta(imageData) {
  const profile = activeProfile();
  const fmt = formatInfo();
  const size = estimateSize();
  const row = Math.ceil((profile.width * fmt.bits) / 8);
  const stride = (row + 3) & ~3;

  $('deviceLabel').textContent = `${profile.name} · ${profile.width} × ${profile.height}`;
  $('chipPixels').textContent = `${imageData.width} × ${imageData.height} px`;
  $('chipPixels').classList.add('is-good');
  $('chipFile').textContent = bytesLabel(size);
  $('chipFile').classList.toggle('is-good', fmt.bits === 24);
  $('chipLevels').textContent = settings.levels === 2 ? '2 tones' : '4 greys';

  const compat =
    fmt.bits === 24
      ? 'Read by stock firmware and every CrossPoint build.'
      : fmt.bits === 1
        ? 'Pure black & white — tiny file, best for logos and line art.'
        : 'CrossPoint / CrossInk only — about a twelfth of the 24-bit size.';
  $('sizeHint').textContent =
    `${profile.width} × ${profile.height} · ${fmt.name} · ${bytesLabel(size)} · ` +
    `${stride} bytes per row (4-byte aligned). ${compat}`;
}

/** File size for the current device + format, straight from the header layout. */
function estimateSize() {
  const profile = activeProfile();
  const bits = formatInfo().bits;
  const stride = (Math.ceil((profile.width * bits) / 8) + 3) & ~3;
  const palette = bits === 24 ? 0 : (bits === 1 ? 2 : 4) * 4;
  return 14 + 40 + palette + stride * profile.height;
}

/* ───────────────────────────────── queue ────────────────────────────────── */

function addImages(files) {
  const accepted = [];
  for (const file of files) {
    if (file.type && !file.type.startsWith('image/')) continue;
    if (queue.length >= MAX_QUEUE) {
      toast(`Queue is limited to ${MAX_QUEUE} images`, 'err');
      break;
    }
    accepted.push(file);
  }
  if (!accepted.length) {
    if (files.length) toast('Those files are not images', 'err');
    return;
  }
  setStatus('Loading…', 'busy');
  Promise.all(
    accepted.map(async (file) => {
      try {
        const loaded = await loadImage(file);
        return {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ...loaded,
          size: file.size,
          fileName: null,
        };
      } catch (error) {
        toast(`Could not read ${file.name}: ${error.message}`, 'err');
        return null;
      }
    })
  ).then((items) => {
    const good = items.filter(Boolean);
    queue.push(...good);
    if (good.length && !activeId) selectItem(good[0].id);
    else if (good.length) selectItem(good[good.length - 1].id);
    syncQueueUI();
    setStatus(`${queue.length} image${queue.length === 1 ? '' : 's'} loaded`);
  });
}

function syncQueueUI() {
  const hasItems = queue.length > 0;
  $('queue').hidden = !hasItems;
  $('editor').hidden = !hasItems;
  $('emptyHint').hidden = hasItems;
  $('queueCount').textContent = String(queue.length);
  $('downloadZipBtn').disabled = !hasItems;

  const list = $('fileList');
  list.textContent = '';
  for (const item of queue) {
    const li = document.createElement('li');
    li.dataset.id = item.id;
    li.classList.toggle('is-active', item.id === activeId);
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(item.id === activeId));

    const img = document.createElement('img');
    img.src = item.thumb;
    img.alt = '';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;

    const dims = document.createElement('span');
    dims.className = 'dims';
    dims.textContent = `${item.sourceWidth}×${item.sourceHeight}`;

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.type = 'button';
    remove.title = 'Remove';
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      queue = queue.filter((q) => q.id !== item.id);
      if (activeId === item.id) {
        activeId = queue[0]?.id || null;
        if (activeId) selectItem(activeId);
      }
      syncQueueUI();
      if (!queue.length) renderPreview();
    });

    li.append(img, name, dims, remove);
    li.addEventListener('click', () => selectItem(item.id));
    list.appendChild(li);
  }
}

/**
 * Select an image. Framing (zoom + pan) is remembered per image so switching
 * back and forth while working on a batch does not lose a careful crop.
 */
function selectItem(id) {
  const previous = activeItem();
  if (previous) previous.framing = { zoom, panX, panY };

  activeId = id;
  const item = activeItem();
  const framing = item?.framing || { zoom: 1, panX: 0, panY: 0 };
  zoom = framing.zoom;
  panX = framing.panX;
  panY = framing.panY;
  $('zoom').value = String(Math.round(zoom * 100));
  $('zoomOut').textContent = `${Math.round(zoom * 100)}%`;

  if (item) $('fileName').value = autoFileName(item);
  syncQueueUI();
  renderPreview();
}

/** Framing to use for an arbitrary queue item, without switching selection. */
function framingFor(item) {
  if (item.id === activeId) return { zoom, panX, panY };
  return item.framing || { zoom: 1, panX: 0, panY: 0 };
}

/* ───────────────────────────────── controls ─────────────────────────────── */

function buildDeviceSegmented() {
  const seg = $('deviceSeg');
  seg.textContent = '';
  for (const profile of PROFILES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.value = profile.id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(profile.id === settings.profileId));
    const label = document.createElement('span');
    label.textContent = profile.short;
    const px = document.createElement('span');
    px.className = 'dev-px';
    px.textContent = `${profile.width}×${profile.height}`;
    btn.append(label, px);
    btn.addEventListener('click', () => {
      if (settings.profileId === profile.id) return;
      settings.profileId = profile.id;
      applyDeviceChange();
    });
    seg.appendChild(btn);
  }
}

function applyDeviceChange() {
  buildDeviceSegmented();
  const profile = activeProfile();
  $('deviceHint').textContent = `${profile.name}: ${profile.size} panel, ${profile.width} × ${profile.height} px at ${profile.ppi} ppi. ${profile.note}`;
  const item = activeItem();
  if (item) $('fileName').value = autoFileName(item);
  renderPreview();
  persist();
}

function syncControlState() {
  document.querySelectorAll('#fitSeg button').forEach((btn) => {
    btn.setAttribute('aria-checked', String(btn.dataset.value === settings.fit));
  });
  $('brightness').value = String(settings.brightness);
  $('brightnessOut').textContent = String(settings.brightness);
  $('contrast').value = String(settings.contrast);
  $('contrastOut').textContent = String(settings.contrast);
  $('gamma').value = String(Math.round(settings.gamma * 100));
  $('gammaOut').textContent = settings.gamma.toFixed(2);
  $('invert').checked = settings.invert;
  $('dither').value = settings.dither;
  $('levels').value = String(settings.levels);
  $('format').value = settings.format;
  document.querySelectorAll('input[name="uploadMode"]').forEach((radio) => {
    radio.checked = radio.value === settings.uploadMode;
  });
  $('customFolderRow').hidden = settings.uploadMode !== 'custom';
  $('uploadFolder').value = settings.lastUploadFolder || '/';
  $('overwrite').checked = settings.overwrite;
  $('deviceHost').value = settings.lastDeviceHost || '';
  updateHintText();
}

function updateHintText() {
  const dither = DITHER_METHODS.find((d) => d.id === settings.dither);
  $('ditherHint').textContent = dither ? dither.hint : '';
  $('formatHint').textContent = formatInfo().hint;
  $('chipFile').classList.toggle('is-good', formatInfo().bits === 24);
}

function buildSelects() {
  const dither = $('dither');
  dither.textContent = '';
  for (const method of DITHER_METHODS) {
    const option = document.createElement('option');
    option.value = method.id;
    option.textContent = method.name;
    dither.appendChild(option);
  }
  const format = $('format');
  format.textContent = '';
  for (const fmt of BMP_FORMATS) {
    const option = document.createElement('option');
    option.value = fmt.id;
    option.textContent = fmt.name;
    format.appendChild(option);
  }
}

function persist() {
  saveSettings(settings);
}

/* ───────────────────────────────── export ───────────────────────────────── */

/** Encode an image at the exact panel size. */
function encodeItem(item, fileNameOverride) {
  if (!item) return null;
  const { imageData } = renderToImageData(item.canvas, currentRenderOptions(item));

  const gray = new Uint8Array(imageData.width * imageData.height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = imageData.data[p];

  const bytes = encodeBMP(gray, imageData.width, imageData.height, {
    format: settings.format,
    levels: settings.levels,
  });

  // The name field only applies to a single-image export; in a batch every file
  // needs its own name or the reader would only ever show one of them.
  const typed = queue.length <= 1 ? $('fileName').value : '';
  let name = String(fileNameOverride || typed || autoFileName(item)).trim();
  name = name.replace(/[\\/]+/g, '-');
  if (!/\.bmp$/i.test(name)) name += '.bmp';
  return { bytes, name, width: imageData.width, height: imageData.height };
}

const encodeActive = () => encodeItem(activeItem());

function download(bytes, filename) {
  const url = URL.createObjectURL(toBlob(bytes));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

async function downloadActive() {
  const item = activeItem();
  if (!item) return;
  setStatus('Encoding…', 'busy');
  setBusy(true);
  try {
    const encoded = encodeActive(item);
    download(encoded.bytes, encoded.name);
    if (encoded.bytes.length !== estimateSize()) {
      toast('Warning: encoded size differs from the expected figure', 'err');
    }
    toast(`${encoded.name} · ${bytesLabel(encoded.bytes.length)} · ${encoded.width}×${encoded.height}`, 'ok');
    setStatus('Downloaded');
  } catch (error) {
    toast(error.message, 'err');
    setStatus('Failed', 'error');
  } finally {
    setBusy(false);
  }
}

/* ── ZIP of the whole queue ──────────────────────────────────────────────── */

async function downloadZip() {
  if (!queue.length) return;
  setStatus('Building ZIP…', 'busy');
  setBusy(true);
  try {
    const entries = [];
    const used = new Set();
    for (const item of queue) {
      let name = `${sanitizeBase(item.name)}.bmp`;
      let n = 2;
      while (used.has(name)) name = `${sanitizeBase(item.name)}-${n++}.bmp`;
      used.add(name);
      const encoded = encodeItem(item, name);
      entries.push({ name, bytes: encoded.bytes });
    }
    if (!entries.length) throw new Error('Nothing to export');
    const archive = buildZip(entries);
    const url = URL.createObjectURL(new Blob([archive], { type: 'application/zip' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `crosspoint-${slug(activeProfile().name)}-${entries.length}.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`${entries.length} BMP${entries.length === 1 ? '' : 's'} in a ZIP — drop them in .sleep/`, 'ok');
    setStatus('ZIP ready');
  } catch (error) {
    toast(`ZIP failed: ${error.message}`, 'err');
    setStatus('Failed', 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * Transparent overlay export (CrossPoint 1.6+ / CrossInk "Transparent" mode).
 *
 * White pixels are left untouched on the panel, so the artwork is drawn at the
 * exact panel size with an alpha channel: fully transparent where the source
 * was white, opaque everywhere else. Dithered greys are written as black
 * pixels with partial alpha, which is what the overlay renderer blends.
 */
async function downloadOverlayPng() {
  const item = activeItem();
  if (!item) return;
  setStatus('Encoding PNG…', 'busy');
  setBusy(true);
  try {
    const profile = activeProfile();
    const { imageData } = renderToImageData(item.canvas, currentRenderOptions(item));
    const out = document.createElement('canvas');
    out.width = profile.width;
    out.height = profile.height;
    const ctx = out.getContext('2d');
    const overlay = ctx.createImageData(profile.width, profile.height);
    for (let i = 0, p = 0; i < imageData.data.length; i += 4, p += 4) {
      const v = imageData.data[i];
      // 0 (black) → fully opaque ink; 255 (white) → fully transparent.
      overlay.data[p] = 0;
      overlay.data[p + 1] = 0;
      overlay.data[p + 2] = 0;
      overlay.data[p + 3] = 255 - v;
    }
    ctx.putImageData(overlay, 0, 0);

    const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG encoding failed');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'sleep-overlay.png';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    toast('sleep-overlay.png — put it in the card root or .sleep-overlay/, then set Sleep Screen → Transparent', 'ok');
    setStatus('Overlay exported');
  } catch (error) {
    toast(`PNG export failed: ${error.message}`, 'err');
    setStatus('Failed', 'error');
  } finally {
    setBusy(false);
  }
}

/* ───────────────────────────────── device ───────────────────────────────── */

function setDeviceStatus(text, kind = '') {
  const el = $('deviceStatus');
  el.textContent = text;
  el.className = `status-line${kind ? ` is-${kind}` : ''}`;
}

function logUpload(message, kind = '') {
  const li = document.createElement('li');
  li.textContent = message;
  if (kind) li.className = `is-${kind}`;
  $('uploadLog').prepend(li);
  while ($('uploadLog').children.length > 60) $('uploadLog').lastChild.remove();
}

async function connect() {
  const host = $('deviceHost').value.trim();
  if (!host) {
    setDeviceStatus('Enter the address shown on the reader.', 'err');
    return;
  }
  setDeviceStatus('Connecting…', 'busy');
  $('connectBtn').disabled = true;
  try {
    const status = await probe(host);
    connection = { origin: status.origin, status };
    settings.lastDeviceHost = host;
    persist();

    $('deviceInfo').hidden = false;
    $('infoDevice').textContent = status.device || '—';
    $('infoVersion').textContent = status.version || '—';
    $('infoMode').textContent = status.mode === 'AP' ? 'Hotspot (AP)' : status.mode || '—';
    $('infoIp').textContent = status.ip || '—';
    $('infoHeap').textContent = status.freeHeap ? `${Math.round(status.freeHeap / 1024)} KB` : '—';

    const detected = String(status.device || '').toUpperCase();
    if (detected.startsWith('X3') && settings.profileId !== 'x3') {
      $('infoTarget').textContent = 'Reader reports X3 hardware — switch the device to X3 above to match its 528 × 792 panel.';
    } else if (detected.startsWith('X4')) {
      $('infoTarget').textContent =
        `Reader reports X4 hardware. The X4 and X4 Pro share the same 480 × 800 panel, so either profile exports correctly.`;
    } else {
      $('infoTarget').textContent = '';
    }

    setDeviceStatus(`Connected to ${status.origin}${status.version ? ` · CrossPoint ${status.version}` : ''}`, 'ok');
    $('browseDeviceBtn').hidden = false;
    $('upBtn').disabled = true;
    setBusy(false);
    await loadFolder('/');
    toast('Reader connected', 'ok');
  } catch (error) {
    connection = null;
    $('deviceInfo').hidden = true;
    $('browseDeviceBtn').hidden = true;
    setDeviceStatus(error.message, 'err');
    setBusy(false);
  } finally {
    $('connectBtn').disabled = false;
  }
}

async function loadFolder(path) {
  if (!connection) return;
  browsePath = path || '/';
  $('currentPath').textContent = browsePath;
  const list = $('browserList');
  list.textContent = '';
  try {
    const items = await listFiles(connection.origin, browsePath);
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'Empty folder (hidden folders need “Show Hidden Files” on the device).';
      list.appendChild(li);
    }
    const sorted = [...items].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
    for (const item of sorted) {
      const li = document.createElement('li');
      li.classList.toggle('is-dir', !!item.isDirectory);
      const name = document.createElement('span');
      name.textContent = item.isDirectory ? `📁 ${item.name}` : item.name;
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = item.isDirectory ? '' : bytesLabel(item.size || 0);
      li.append(name, size);
      if (item.isDirectory) {
        const child = `${browsePath.replace(/\/$/, '')}/${item.name}` || '/';
        li.addEventListener('click', () => loadFolder(child));
      }
      list.appendChild(li);
    }
    $('upBtn').disabled = browsePath === '/';
  } catch (error) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = error.message;
    list.appendChild(li);
  }
}

function setProgress(done, total, label) {
  $('uploadProgress').hidden = false;
  $('uploadBar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
  $('uploadLabel').textContent = label;
}

async function uploadItems(items) {
  if (!connection) {
    toast('Connect to your reader first', 'err');
    return;
  }
  if (!items.length) return;

  const folder = destinationFor(settings, 'x').folder;
  setBusy(true);
  setProgress(0, items.length, 'Starting…');
  try {
    if (folder !== '/') await ensureFolder($('deviceHost').value.trim(), folder);
    const host = $('deviceHost').value.trim();
    const used = new Set();
    let ok = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // CrossPoint always looks for "sleep.bmp" for a single sleep screen, so a
      // one-image send to / or /.sleep uses that name. Batches keep their own
      // names so the reader can rotate through them.
      let name;
      if (items.length === 1) {
        if (settings.uploadMode === 'custom') {
          name = ($('fileName').value || 'sleep.bmp').trim();
        } else {
          name = 'sleep.bmp';
        }
      } else {
        name = `${sanitizeBase(item.name)}.bmp`;
      }
      let n = 2;
      while (used.has(name)) name = `${sanitizeBase(item.name)}-${n++}.bmp`;
      used.add(name);
      if (!/\.bmp$/i.test(name)) name += '.bmp';

      const encoded = encodeItem(item, name);
      setProgress(i, items.length, `Uploading ${name} (${bytesLabel(encoded.bytes.length)})…`);

      try {
        await uploadFile(host, { folder, name, bytes: encoded.bytes }, {
          overwrite: settings.overwrite,
          onProgress: (sent, total) =>
            setProgress(i + sent / Math.max(1, total), items.length, `Uploading ${name}…`),
        });
        const check = await verifyUpload(host, { folder, name, bytes: encoded.bytes });
        logUpload(
          `${name} → ${folder} · ${bytesLabel(encoded.bytes.length)}${
            check.verified ? ' · verified on card' : ` · ${check.detail}`
          }`,
          check.verified ? 'ok' : 'err'
        );
        if (check.verified) ok++;
      } catch (error) {
        logUpload(`${name} — ${error.message}`, 'err');
      }
    }
    setProgress(items.length, items.length, `${ok}/${items.length} uploaded`);
    toast(`${ok} of ${items.length} uploaded to ${folder}`, ok === items.length ? 'ok' : 'err');
    await loadFolder(browsePath);
  } finally {
    setBusy(false);
  }
}

/* ───────────────────────────────── pan / zoom ───────────────────────────── */

function bindPanZoom() {
  const canvas = $('preview');
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  const profile = () => activeProfile();

  canvas.addEventListener('pointerdown', (event) => {
    if (!activeItem()) return;
    dragging = true;
    canvas.classList.add('is-dragging');
    canvas.setPointerCapture(event.pointerId);
    startX = event.clientX;
    startY = event.clientY;
    originX = panX;
    originY = panY;
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const scale = profile().width / canvas.getBoundingClientRect().width;
    panX = originX + (event.clientX - startX) * scale;
    panY = originY + (event.clientY - startY) * scale;
    syncFraming();
    renderPreview();
  });

  const endDrag = () => {
    dragging = false;
    canvas.classList.remove('is-dragging');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', resetFraming);

  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!activeItem()) return;
      event.preventDefault();
      const next = Math.min(3, Math.max(1, zoom * (event.deltaY < 0 ? 1.08 : 0.92)));
      zoom = Math.round(next * 100) / 100;
      $('zoom').value = String(Math.round(zoom * 100));
      $('zoomOut').textContent = `${Math.round(zoom * 100)}%`;
      syncFraming();
      renderPreview();
    },
    { passive: false }
  );
}

/** Store the live zoom/pan on the active queue item. */
function syncFraming() {
  const item = activeItem();
  if (item) item.framing = { zoom, panX, panY };
}

function resetFraming() {
  zoom = 1;
  panX = 0;
  panY = 0;
  settings.fit = 'cover';
  $('zoom').value = '100';
  $('zoomOut').textContent = '100%';
  syncFraming();
  syncControlState();
  renderPreview();
  persist();
}

/* ───────────────────────────────── wiring ───────────────────────────────── */

function bindEvents() {
  // Tabs
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => {
        t.classList.toggle('is-active', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      document.querySelectorAll('.tab-panel').forEach((panel) => {
        panel.classList.toggle('is-active', panel.id === `tab-${tab.dataset.tab}`);
      });
    });
  });

  // Drop zone
  const dropzone = $('dropzone');
  const input = $('fileInput');
  $('browseBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    input.click();
  });
  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    addImages([...input.files]);
    input.value = '';
  });
  ['dragenter', 'dragover'].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-over');
    })
  );
  ['dragleave', 'drop'].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-over');
    })
  );
  dropzone.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) addImages(files);
  });

  // Paste anywhere
  window.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) {
      event.preventDefault();
      addImages(files);
    }
  });

  $('addMoreBtn').addEventListener('click', () => input.click());
  $('clearQueueBtn').addEventListener('click', () => {
    queue = [];
    activeId = null;
    zoom = 1;
    panX = 0;
    panY = 0;
    syncQueueUI();
    renderPreview();
    setBusy(false);
    setStatus('Ready');
  });

  // Fit segmented
  document.querySelectorAll('#fitSeg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.fit = btn.dataset.value;
      panX = 0;
      panY = 0;
      syncFraming();
      syncControlState();
      renderPreview();
      persist();
    });
  });

  // Sliders
  const slider = (id, key, transform = (v) => v, format = (v) => String(v), outId) => {
    $(id).addEventListener('input', () => {
      const raw = Number($(id).value);
      settings[key] = transform(raw);
      $(outId).textContent = format(settings[key]);
      renderPreview();
      persist();
    });
  };
  slider('brightness', 'brightness', Number, String, 'brightnessOut');
  slider('contrast', 'contrast', Number, String, 'contrastOut');
  slider('gamma', 'gamma', (v) => v / 100, (v) => v.toFixed(2), 'gammaOut');

  $('zoom').addEventListener('input', () => {
    zoom = Number($('zoom').value) / 100;
    $('zoomOut').textContent = `${$('zoom').value}%`;
    syncFraming();
    renderPreview();
  });
  $('resetFraming').addEventListener('click', resetFraming);

  $('invert').addEventListener('change', () => {
    settings.invert = $('invert').checked;
    renderPreview();
    persist();
  });
  $('dither').addEventListener('change', () => {
    settings.dither = $('dither').value;
    updateHintText();
    renderPreview();
    persist();
  });
  $('levels').addEventListener('change', () => {
    settings.levels = Number($('levels').value);
    renderPreview();
    persist();
  });
  $('format').addEventListener('change', () => {
    settings.format = $('format').value;
    updateHintText();
    const item = activeItem();
    if (item) $('fileName').value = autoFileName(item);
    renderPreview();
    persist();
  });

  // Export
  $('downloadBtn').addEventListener('click', downloadActive);
  $('downloadZipBtn').addEventListener('click', downloadZip);
  $('downloadPngBtn').addEventListener('click', downloadOverlayPng);

  // Device
  $('connectBtn').addEventListener('click', connect);
  $('deviceHost').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') connect();
  });
  $('browseDeviceBtn').addEventListener('click', () => {
    document.querySelector('.tab[data-tab="device"]').click();
    loadFolder('/');
  });
  $('upBtn').addEventListener('click', () => {
    const parent = browsePath.replace(/\/[^/]+\/?$/, '') || '/';
    loadFolder(parent || '/');
  });

  document.querySelectorAll('input[name="uploadMode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      settings.uploadMode = radio.value;
      $('customFolderRow').hidden = radio.value !== 'custom';
      persist();
    });
  });
  $('uploadFolder').addEventListener('change', () => {
    let value = $('uploadFolder').value.trim() || '/';
    if (!value.startsWith('/')) value = `/${value}`;
    $('uploadFolder').value = value;
    settings.lastUploadFolder = value;
    persist();
  });
  $('overwrite').addEventListener('change', () => {
    settings.overwrite = $('overwrite').checked;
    persist();
  });

  $('sendBtn').addEventListener('click', () => {
    document.querySelector('.tab[data-tab="device"]').click();
    if (!connection) {
      toast('Connect to your reader, then press “Send current image”.');
      $('deviceHost').focus();
      return;
    }
    uploadItems(activeItem() ? [activeItem()] : []);
  });
  $('uploadCurrentBtn').addEventListener('click', () => uploadItems(activeItem() ? [activeItem()] : []));
  $('uploadAllBtn').addEventListener('click', () => uploadItems([...queue]));
  $('retargetBtn').addEventListener('click', () => {
    toast('On the reader: Settings → Display → Sleep Screen → Custom', 'ok');
  });

  window.addEventListener('resize', () => renderPreview());
}

/* ───────────────────────────────── boot ─────────────────────────────────── */

async function boot() {
  settings = await loadSettings();
  buildSelects();
  buildDeviceSegmented();
  syncControlState();
  bindEvents();
  bindPanZoom();
  setBusy(false);
  applyDeviceChange();
  syncQueueUI();

  const params = new URLSearchParams(location.search);

  // Handoff from the popup: a picked image stored as a data URL.
  if (params.get('pick') === 'quick') {
    try {
      const stored = await chrome.storage.local.get('quickImage');
      const quick = stored?.quickImage;
      if (quick?.dataUrl) {
        const blob = await (await fetch(quick.dataUrl)).blob();
        addImages([new File([blob], quick.name || 'image', { type: quick.type || blob.type })]);
      }
      await chrome.storage.local.remove('quickImage');
    } catch {
      /* nothing to import */
    }
    history.replaceState(null, '', location.pathname);
  }

  // Deep links: ?src=<image url> from the context menu.
  const src = params.get('src');
  if (src) {
    try {
      const response = await fetch(src, { credentials: 'omit' });
      const blob = await response.blob();
      const name = decodeURIComponent(new URL(src).pathname.split('/').pop() || 'image');
      const file = new File([blob], name, { type: blob.type });
      addImages([file]);
    } catch {
      toast('Could not load that image (the page may block cross-site reads). Drop it here instead.', 'err');
    }
    history.replaceState(null, '', location.pathname);
  }

  if (!queue.length) setStatus('Ready');
}

boot();
