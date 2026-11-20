/**
 * Packages the unpacked extension into dist/crosspoint-studio-<version>.zip
 * with only the files Chrome needs.
 *
 *   npm run build
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from '../lib/zip.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

/** Everything the extension needs at runtime; tests and tooling stay out. */
const INCLUDE = ['manifest.json', 'background.js', 'studio.html', 'popup.html', 'css', 'js', 'lib', 'icons'];

function walk(target, acc = []) {
  const info = statSync(target);
  if (info.isDirectory()) {
    for (const entry of readdirSync(target)) walk(join(target, entry), acc);
  } else {
    acc.push(target);
  }
  return acc;
}

const files = INCLUDE.flatMap((entry) => {
  const full = join(root, entry);
  try {
    return walk(full);
  } catch {
    return [];
  }
});

const entries = files.map((file) => ({
  name: relative(root, file).split('\\').join('/'),
  bytes: new Uint8Array(readFileSync(file)),
}));

const archive = buildZip(entries);
const outDir = join(root, 'dist');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `crosspoint-studio-${manifest.version}.zip`);
writeFileSync(out, archive);

// A quick self-check on the manifest before shipping.
const problems = [];
if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
for (const key of ['name', 'version', 'description', 'action', 'icons', 'background']) {
  if (!manifest[key]) problems.push(`missing "${key}"`);
}
for (const size of ['16', '32', '48', '128']) {
  if (!manifest.icons?.[size]) problems.push(`missing icon ${size}`);
}
if (manifest.background?.type !== 'module') problems.push('service worker must be a module');

const totalBytes = entries.reduce((n, e) => n + e.bytes.length, 0);
console.log(`\nCrossPoint Studio ${manifest.version}`);
console.log(`${entries.length} files · ${(totalBytes / 1024).toFixed(0)} KB raw · ${(archive.length / 1024).toFixed(0)} KB zipped`);
console.log(`→ ${relative(root, out)}\n`);
for (const e of entries) console.log(`  ${String(e.bytes.length).padStart(8)}  ${e.name}`);
if (problems.length) {
  console.error(`\nManifest problems:\n  - ${problems.join('\n  - ')}`);
  process.exitCode = 1;
} else {
  console.log('\nManifest checks passed.');
}
