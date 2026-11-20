/**
 * Client for CrossPoint's built-in web server.
 *
 * Available while the reader is in File Transfer or Calibre Wireless mode:
 *   GET  /api/status            → firmware + hardware info
 *   GET  /api/files?path=/      → folder listing
 *   POST /upload?path=/&overwrite=1   (multipart form, field "file")
 *   POST /mkdir                (name, path)
 *
 * There is no authentication; the extension only ever talks to the host the
 * user typed in.
 */

/** Normalise what people paste ("crosspoint.local", "192.168.4.1/", "http://x/") into an origin. */
export function normalizeHost(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new Error('Enter the address shown on your reader, e.g. crosspoint.local');
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${input}" is not a valid address`);
  }
  if (!url.hostname) throw new Error('Missing host name');
  return `${url.protocol}//${url.host}`;
}

function describeNetworkError(host) {
  const tips = [
    `Could not reach ${host}.`,
    'Check that the reader is on File Transfer (or Calibre Wireless) mode with the web server running.',
    'On Windows, Android or iOS, "crosspoint.local" (mDNS) often does not resolve — paste the IP address shown on the reader instead.',
    'Both devices must be on the same network. In hotspot mode, join the "CrossPoint-Reader" Wi-Fi first.',
  ];
  return tips.join(' ');
}

async function request(origin, path, init = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(origin + path, { ...init, signal: controller.signal, cache: 'no-store' });
    return response;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Timed out talking to ${origin}. ${describeNetworkError(origin)}`);
    throw new Error(describeNetworkError(origin));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a device and report what it is.
 * @param {string} host raw address, e.g. "crosspoint.local"
 */
export async function probe(host) {
  const origin = normalizeHost(host);
  const response = await request(origin, '/api/status', { method: 'GET' });
  if (!response.ok) {
    throw new Error(
      `${origin}/api/status returned ${response.status}. Is this a CrossPoint reader in File Transfer mode?`
    );
  }
  let status;
  try {
    status = await response.json();
  } catch {
    throw new Error(`${origin} answered, but did not return CrossPoint's status JSON.`);
  }
  return { origin, ...status };
}

/** List a directory. Hidden folders are only listed when the device setting allows it. */
export async function listFiles(host, path = '/') {
  const origin = normalizeHost(host);
  const response = await request(origin, `/api/files?path=${encodeURIComponent(path)}`, { method: 'GET' });
  if (!response.ok) throw new Error(`Listing ${path} failed (HTTP ${response.status}).`);
  const items = await response.json();
  return Array.isArray(items) ? items : [];
}

/** True when the destination folder already holds a file with this name. */
export async function fileExists(host, folder, name) {
  try {
    const items = await listFiles(host, folder);
    return items.some((item) => !item.isDirectory && item.name === name);
  } catch {
    return false;
  }
}

export async function ensureFolder(host, folder) {
  if (!folder || folder === '/') return true;
  const origin = normalizeHost(host);
  const parent = folder.slice(0, folder.lastIndexOf('/')) || '/';
  const name = folder.slice(folder.lastIndexOf('/') + 1);
  if (!name) return true;
  try {
    const items = await listFiles(host, parent);
    if (items.some((item) => item.isDirectory && item.name === name)) return true;
  } catch {
    // Fall through and try to create it anyway.
  }
  const body = new URLSearchParams({ name, path: parent });
  const response = await request(origin, '/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  // 400 simply means it was already there.
  return response.ok || response.status === 400;
}

/**
 * Upload one BMP to the reader.
 * @param {string} host
 * @param {{folder:string,name:string,bytes:Uint8Array}} file
 * @param {{overwrite?:boolean,onProgress?:(sent:number,total:number)=>void}} [opts]
 */
export async function uploadFile(host, file, opts = {}) {
  const origin = normalizeHost(host);
  const overwrite = opts.overwrite !== false;
  const form = new FormData();
  const blob = new Blob([file.bytes], { type: 'image/bmp' });
  form.append('file', blob, file.name);

  const query = `?path=${encodeURIComponent(file.folder || '/')}${overwrite ? '&overwrite=1' : ''}`;
  opts.onProgress?.(0, file.bytes.length);

  const response = await request(
    origin,
    `/upload${query}`,
    { method: 'POST', body: form },
    60000
  );
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    if (/already exists/i.test(text)) {
      throw new Error(`A file named ${file.name} already exists in ${file.folder}. Enable "Replace existing files" to overwrite it.`);
    }
    throw new Error(`Upload failed (HTTP ${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  opts.onProgress?.(file.bytes.length, file.bytes.length);
  return { ok: true, message: text.trim() || `Uploaded ${file.name}` };
}

/**
 * Round-trip check: upload, list the folder, and confirm size and dimensions.
 * @returns {Promise<{verified:boolean, detail:string}>}
 */
export async function verifyUpload(host, file) {
  try {
    const items = await listFiles(host, file.folder);
    const found = items.find((item) => !item.isDirectory && item.name === file.name);
    if (!found) return { verified: false, detail: 'File was not listed after upload.' };
    if (typeof found.size === 'number' && found.size !== file.bytes.length) {
      return {
        verified: false,
        detail: `Device reports ${found.size} bytes, expected ${file.bytes.length}. The upload may be truncated.`,
      };
    }
    return { verified: true, detail: `${file.name} is on the card at ${file.folder}.` };
  } catch (error) {
    return { verified: false, detail: String(error.message || error) };
  }
}
