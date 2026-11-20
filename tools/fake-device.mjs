/**
 * A stand-in for CrossPoint's web server, implementing the documented endpoints
 * the extension uses. Lets the upload path be exercised end to end without a
 * reader on the network.
 *
 *   node tools/fake-device.mjs 8099
 *
 * Then in the studio: Connect → 127.0.0.1:8099
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] || 8099);
const device = (process.argv[3] || 'X4').toUpperCase();

/** @type {Map<string, Map<string, number>>} folder → (name → size) */
const tree = new Map([['/', new Map()]]);
for (const folder of ['/.sleep', '/.sleep-overlay']) tree.set(folder, new Map());
tree.get('/').set('MyBook.epub', 1234567);

const norm = (p) => (!p || p === '' ? '/' : p.startsWith('/') ? p.replace(/\/+$/, '') || '/' : `/${p}`);
const folderOf = (p) => {
  const clean = norm(p);
  const idx = clean.lastIndexOf('/');
  return idx <= 0 ? '/' : clean.slice(0, idx);
};
const nameOf = (p) => norm(p).slice(norm(p).lastIndexOf('/') + 1);

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function text(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** Read a multipart body and return {filename, bytes}. */
function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headerEnd = body.indexOf('\r\n\r\n');
      if (headerEnd < 0) return reject(new Error('malformed multipart'));
      const header = body.subarray(0, headerEnd).toString('latin1');
      const match = /filename="([^"]*)"/.exec(header);
      const tail = body.indexOf('\r\n--', headerEnd);
      const bytes = body.subarray(headerEnd + 4, tail > 0 ? tail : body.length);
      resolve({ filename: match ? match[1] : 'upload.bin', bytes });
    });
    req.on('error', reject);
  });
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const q = url.searchParams;

  if (path === '/api/status') {
    return json(res, 200, {
      version: '1.6.0',
      firmwareFamily: 'crosspoint',
      ip: '127.0.0.1',
      mode: 'STA',
      rssi: -40,
      freeHeap: 154000,
      uptime: 42,
      device,
    });
  }

  if (path === '/api/files') {
    const dir = norm(q.get('path'));
    if (!tree.has(dir)) return json(res, 404, { error: 'no such folder' });
    const items = [...tree.get(dir).entries()].map(([name, size]) => ({
      name,
      size,
      isDirectory: false,
      isEpub: name.endsWith('.epub'),
    }));
    for (const folder of tree.keys()) {
      if (folder === '/' || folder === dir) continue;
      if (folderOf(folder) === dir) {
        items.push({ name: nameOf(folder), size: 0, isDirectory: true, isEpub: false });
      }
    }
    return json(res, 200, items);
  }

  if (path === '/mkdir' && req.method === 'POST') {
    const form = await readForm(req);
    const target = `${norm(form.get('path')).replace(/\/$/, '')}/${form.get('name')}`;
    if (tree.has(target)) return text(res, 400, 'Folder already exists');
    tree.set(target, new Map());
    return text(res, 200, 'Folder created');
  }

  if (path === '/upload' && req.method === 'POST') {
    const dir = norm(q.get('path'));
    if (!tree.has(dir)) return text(res, 400, `No such folder: ${dir}`);
    const overwrite = q.get('overwrite') === '1' || q.get('overwrite') === 'true';
    let upload;
    try {
      upload = await readMultipart(req);
    } catch (error) {
      return text(res, 400, error.message);
    }
    const folder = tree.get(dir);
    if (folder.has(upload.filename) && !overwrite) {
      return text(res, 400, `File already exists: ${upload.filename}`);
    }
    folder.set(upload.filename, upload.bytes.length);
    console.log(`  uploaded ${dir === '/' ? '' : dir}/${upload.filename} (${upload.bytes.length} bytes)`);
    return text(res, 200, `File uploaded successfully: ${upload.filename}`);
  }

  if (path === '/download') {
    const file = norm(q.get('path'));
    const folder = tree.get(folderOf(file));
    if (!folder?.has(nameOf(file))) return text(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    return res.end(Buffer.alloc(folder.get(nameOf(file))));
  }

  if (path === '/' || path === '/files') {
    return text(res, 200, 'CrossPoint fake device');
  }
  return text(res, 404, 'Not found');
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Fake CrossPoint ${device} on http://127.0.0.1:${port} (folders: ${[...tree.keys()].join(', ')})`);
});
