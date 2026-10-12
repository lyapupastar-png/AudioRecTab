// Package for manual loading in Firefox (about:debugging -> Load Temporary Add-on): release/<name-from-manifest>-<version>.xpi.
// Always the same file: each build overwrites it (temp file, then rename), so the Reload button in about:debugging is enough.
// Reload the add-on after a build: Firefox keeps old copies of the file open.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3tab-pack-'));
execFileSync('npx', ['web-ext', 'build', '--source-dir', 'dist', '--artifacts-dir', tmp, '--overwrite-dest'], { stdio: 'ignore' });
const zip = fs.readdirSync(tmp).find((f) => f.endsWith('.zip'));
fs.mkdirSync('release', { recursive: true });
const out = path.join('release', zip.replace(/\.zip$/, '.xpi')), part = out + '.part';
fs.copyFileSync(path.join(tmp, zip), part);
fs.renameSync(part, out);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('packed ' + path.resolve(out));
