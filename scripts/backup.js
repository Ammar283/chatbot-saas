#!/usr/bin/env node
// Nightly backup. Flat files are fine until one bad deploy erases every
// client's leads — then they are the reason you no longer have a business.
//
// The data is already JSON, so this bundles it into one gzipped file. Node's
// zlib does the work; no tar, no zip library, no SDK.
//
//   node scripts/backup.js            create a local snapshot
//   node scripts/backup.js --upload   snapshot and send it off the server
//   node scripts/backup.js --restore backups/backup-....json.gz

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import 'dotenv/config';

const DATA_DIR = process.env.DATA_DIR || './data';
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';
const KEEP = Number(process.env.BACKUP_KEEP || 14);

function create() {
  const files = {};
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith('.json')) continue;
    files[f] = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
  }
  const archiveDir = path.join(DATA_DIR, '_archive');
  if (fs.existsSync(archiveDir)) {
    for (const f of fs.readdirSync(archiveDir)) {
      if (f.endsWith('.json')) files['_archive/' + f] = fs.readFileSync(path.join(archiveDir, f), 'utf8');
    }
  }

  const payload = JSON.stringify({ createdAt: new Date().toISOString(), files });
  const gz = zlib.gzipSync(Buffer.from(payload), { level: 9 });

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`;
  const dest = path.join(BACKUP_DIR, name);
  fs.writeFileSync(dest, gz);

  prune();
  return { dest, name, bytes: gz.length, count: Object.keys(files).length };
}

function prune() {
  const all = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('backup-')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP))) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
  }
}

// --- off-server copy ---------------------------------------------------
// A backup on the same disk as the data is not a backup.

async function uploadB2(file, name) {
  const keyId = process.env.B2_KEY_ID;
  const appKey = process.env.B2_APP_KEY;
  const bucketId = process.env.B2_BUCKET_ID;
  if (!keyId || !appKey || !bucketId) return null;

  const authRes = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + Buffer.from(`${keyId}:${appKey}`).toString('base64') },
  });
  if (!authRes.ok) throw new Error(`B2 auth failed (${authRes.status})`);
  const auth = await authRes.json();
  const apiUrl = auth.apiInfo?.storageApi?.apiUrl || auth.apiUrl;

  const urlRes = await fetch(`${apiUrl}/b2api/v3/b2_get_upload_url?bucketId=${bucketId}`, {
    headers: { Authorization: auth.authorizationToken },
  });
  if (!urlRes.ok) throw new Error(`B2 upload URL failed (${urlRes.status})`);
  const up = await urlRes.json();

  const body = fs.readFileSync(file);
  const sha1 = await crypto.subtle.digest('SHA-1', body)
    .then((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''));

  const putRes = await fetch(up.uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: up.authorizationToken,
      'X-Bz-File-Name': encodeURIComponent(name),
      'Content-Type': 'application/gzip',
      'Content-Length': String(body.length),
      'X-Bz-Content-Sha1': sha1,
    },
    body,
  });
  if (!putRes.ok) throw new Error(`B2 upload failed (${putRes.status}): ${(await putRes.text()).slice(0, 200)}`);
  return 'Backblaze B2';
}

// Works with any presigned PUT URL — S3, Cloudflare R2, Google Cloud Storage.
async function uploadPresigned(file) {
  const url = process.env.BACKUP_PUT_URL;
  if (!url) return null;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/gzip' },
    body: fs.readFileSync(file),
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  return 'presigned URL';
}

function restore(file) {
  const raw = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  const { createdAt, files } = JSON.parse(raw);
  fs.mkdirSync(path.join(DATA_DIR, '_archive'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(DATA_DIR, name), content);
  }
  console.log(`Restored ${Object.keys(files).length} files from ${createdAt}`);
}

// --- run ---------------------------------------------------------------
// Only when invoked directly. server.js imports create(), and without this
// guard that import would fire a backup on every boot.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('backup.js');
const args = process.argv.slice(2);

if (!invokedDirectly) {
  // imported as a module — expose create() and do nothing else
} else if (args[0] === '--restore') {
  if (!args[1]) { console.error('Usage: node scripts/backup.js --restore <file>'); process.exit(1); }
  restore(args[1]);
} else {
  const r = create();
  console.log(`Backed up ${r.count} files → ${r.dest} (${(r.bytes / 1024).toFixed(1)} KB)`);
  if (args.includes('--upload')) {
    const where = await uploadB2(r.dest, r.name).catch((e) => { console.error(e.message); return null; })
      || await uploadPresigned(r.dest).catch((e) => { console.error(e.message); return null; });
    console.log(where ? `Copied off-server to ${where}.` : 'No off-server target configured — snapshot is local only.');
  }
}

export { create };
