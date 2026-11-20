/**
 * Exercises the CrossPoint client against a local stand-in for the reader's
 * web server, so the upload path is covered without real hardware.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { probe, uploadFile, verifyUpload, listFiles, ensureFolder } from '../lib/device.js';
import { processImage } from '../lib/pipeline.js';
import { encodeBMP } from '../lib/bmp.js';
import { getProfile } from '../lib/profiles.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8123;
const HOST = `127.0.0.1:${PORT}`;

/** Start the fake device and wait for it to accept connections. */
async function startFake() {
  const child = spawn(process.execPath, [join(root, 'tools/fake-device.mjs'), String(PORT), 'X3'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake device did not start')), 8000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Fake CrossPoint')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
  });
  return child;
}

/** A real, panel-exact 2-bit BMP to ship over the wire. */
function makeBmp() {
  const profile = getProfile('x3');
  const rgba = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    const v = (i / 4) % 256;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
    rgba[i + 3] = 255;
  }
  const out = processImage(rgba, 64, 64, {
    targetWidth: profile.width,
    targetHeight: profile.height,
    fit: 'cover',
  });
  return encodeBMP(out.gray, out.width, out.height, { format: 'bmp2', levels: 4 });
}

test('device client talks to CrossPoint correctly', async (t) => {
  const server = await startFake();
  t.after(() => server.kill());

  await t.test('status identifies the hardware', async () => {
    const status = await probe(HOST);
    assert.equal(status.device, 'X3');
    assert.equal(status.firmwareFamily, 'crosspoint');
    assert.match(status.origin, /^http:\/\/127\.0\.0\.1:8123$/);
  });

  await t.test('folders can be listed and created', async () => {
    const rootItems = await listFiles(HOST, '/');
    assert.ok(rootItems.some((i) => i.name === 'MyBook.epub'));
    assert.ok(rootItems.some((i) => i.isDirectory && i.name === '.sleep'));
    assert.equal(await ensureFolder(HOST, '/NewFolder'), true);
    assert.equal(await ensureFolder(HOST, '/NewFolder'), true, 'creating twice is not an error');
  });

  await t.test('a BMP uploads, verifies and matches byte for byte', async () => {
    const bytes = makeBmp();
    const progress = [];
    const result = await uploadFile(
      HOST,
      { folder: '/', name: 'sleep.bmp', bytes },
      { overwrite: true, onProgress: (sent, total) => progress.push([sent, total]) }
    );
    assert.equal(result.ok, true);
    assert.ok(progress.length >= 2);

    const check = await verifyUpload(HOST, { folder: '/', name: 'sleep.bmp', bytes });
    assert.equal(check.verified, true, check.detail);

    const items = await listFiles(HOST, '/');
    const found = items.find((i) => i.name === 'sleep.bmp');
    assert.equal(found.size, bytes.length);
  });

  await t.test('a batch lands in .sleep with distinct names', async () => {
    const bytes = makeBmp();
    await uploadFile(HOST, { folder: '/.sleep', name: 'one.bmp', bytes }, { overwrite: true });
    await uploadFile(HOST, { folder: '/.sleep', name: 'two.bmp', bytes }, { overwrite: true });
    const items = await listFiles(HOST, '/.sleep');
    assert.deepEqual(items.map((i) => i.name).sort(), ['one.bmp', 'two.bmp']);
  });

  await t.test('refusing to overwrite produces an actionable error', async () => {
    const bytes = makeBmp();
    await assert.rejects(
      () => uploadFile(HOST, { folder: '/', name: 'sleep.bmp', bytes }, { overwrite: false }),
      /already exists/i
    );
  });

  await t.test('an unreachable host gives a network hint, not a stack trace', async () => {
    await assert.rejects(() => probe('127.0.0.1:9'),
      /Could not reach|crosspoint\.local|same network/i);
  });

  await delay(10);
});
