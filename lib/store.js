/**
 * Persisted preferences (chrome.storage.local) with safe defaults.
 * Nothing here touches network state; only settings survive a restart.
 */
import { DEFAULT_PROFILE_ID, PROFILES } from './profiles.js';

export const DEFAULT_SETTINGS = {
  profileId: DEFAULT_PROFILE_ID,
  format: 'bmp24',
  fit: 'cover',
  dither: 'floyd-steinberg',
  levels: 4,
  brightness: 0,
  contrast: 0,
  gamma: 1,
  invert: false,
  quality: 'balanced',
  autoOpenBatch: false,
  lastDeviceHost: 'crosspoint.local',
  lastUploadFolder: '/',
  uploadMode: 'sleep-root',
  overwrite: true,
};

const KEY = 'crosspointStudio';

/**
 * chrome.storage when running as an extension, localStorage otherwise (so the
 * studio can be opened from a plain file server for development).
 */
const hasChromeStorage = typeof chrome !== 'undefined' && !!chrome?.storage?.local;

async function readRaw() {
  if (hasChromeStorage) {
    const stored = await chrome.storage.local.get(KEY);
    return stored?.[KEY] || null;
  }
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

async function writeRaw(value) {
  if (hasChromeStorage) {
    await chrome.storage.local.set({ [KEY]: value });
    return;
  }
  localStorage.setItem(KEY, JSON.stringify(value));
}

export async function loadSettings() {
  try {
    const merged = { ...DEFAULT_SETTINGS, ...((await readRaw()) || {}) };
    if (!PROFILES.some((p) => p.id === merged.profileId)) merged.profileId = DEFAULT_PROFILE_ID;
    if (!['cover', 'contain', 'stretch'].includes(merged.fit)) merged.fit = 'cover';
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings) {
  try {
    await writeRaw({ ...DEFAULT_SETTINGS, ...settings });
    return true;
  } catch {
    return false;
  }
}

/** Device profile → the folder CrossPoint reads custom sleep images from. */
export function destinationFor(s, filename) {
  switch (s.uploadMode) {
    case 'sleep-folder':
      return { folder: '/.sleep', path: `/.sleep/${filename}` };
    case 'custom':
      return {
        folder: s.lastUploadFolder || '/',
        path: `${(s.lastUploadFolder || '/').replace(/\/$/, '')}/${filename}`,
      };
    case 'sleep-root':
    default:
      return { folder: '/', path: `/${filename}` };
  }
}
