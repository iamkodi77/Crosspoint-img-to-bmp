/** Popup: quick device picker, quick open, and a connection test. */
import { PROFILES, getProfile } from '../lib/profiles.js';
import { loadSettings, saveSettings } from '../lib/store.js';
import { probe } from '../lib/device.js';

const $ = (id) => document.getElementById(id);

let settings = null;

function openStudio(query = '') {
  chrome.runtime.sendMessage({ type: 'open-studio', query }, () => {
    window.close();
  });
}

function renderProfiles() {
  const grid = $('profileGrid');
  grid.textContent = '';
  for (const profile of PROFILES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(profile.id === settings.profileId));
    const label = document.createElement('span');
    label.textContent = profile.short;
    const px = document.createElement('span');
    px.className = 'px';
    px.textContent = `${profile.width}×${profile.height}`;
    btn.append(label, px);
    btn.addEventListener('click', async () => {
      settings.profileId = profile.id;
      renderProfiles();
      await saveSettings(settings);
    });
    grid.appendChild(btn);
  }
}

function quickConvert(file) {
  if (!file) return;
  // The studio owns conversion and preview; hand the file over as a data URL.
  // chrome.storage.local allows ~10 MB per item, so oversized photos fall back
  // to drag-and-drop straight into the studio.
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await chrome.storage.local.set({
        quickImage: { dataUrl: reader.result, name: file.name, type: file.type },
      });
    } catch {
      // Quota exceeded — the studio will simply ask for the image again.
    }
    openStudio('?pick=quick');
  };
  reader.onerror = () => openStudio();
  reader.readAsDataURL(file);
}

async function testConnection() {
  const host = $('host').value.trim();
  if (!host) {
    $('status').textContent = 'Enter the reader address first.';
    $('status').className = 'status is-err';
    return;
  }
  $('status').textContent = 'Reaching reader…';
  $('status').className = 'status';
  $('connect').disabled = true;
  try {
    const status = await probe(host);
    $('status').textContent = `✓ ${status.device || 'CrossPoint'} · v${status.version || '?'} · ${status.ip || status.origin}`;
    $('status').className = 'status is-ok';
    settings.lastDeviceHost = host;
    await saveSettings(settings);
  } catch {
    $('status').textContent = '✕ Not reachable. Use the IP shown on the reader, and keep File Transfer mode open.';
    $('status').className = 'status is-err';
  } finally {
    $('connect').disabled = false;
  }
}

async function boot() {
  settings = await loadSettings();
  renderProfiles();
  $('host').value = settings.lastDeviceHost || '';
  const profile = getProfile(settings.profileId);
  $('lastUsed').textContent = `${profile.short} · ${profile.width}×${profile.height}`;

  $('openStudio').addEventListener('click', () => openStudio());
  $('openGuide').addEventListener('click', () => openStudio());
  $('connect').addEventListener('click', testConnection);
  $('host').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') testConnection();
  });

  const drop = $('drop');
  const input = $('quickFile');
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => quickConvert(input.files[0]));
  ['dragenter', 'dragover'].forEach((type) =>
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add('is-over');
    })
  );
  ['dragleave', 'drop'].forEach((type) =>
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.remove('is-over');
    })
  );
  drop.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) quickConvert(file);
  });

  window.addEventListener('paste', (event) => {
    const file = event.clipboardData?.files?.[0];
    if (file) quickConvert(file);
  });
}

boot();
