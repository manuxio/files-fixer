'use strict';
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const backupDir = path.join(config.evidenceRoot, 'backups');
const auditLog = path.join(config.evidenceRoot, 'audit.log');

const sha256 = (buf) => (buf == null ? null : crypto.createHash('sha256').update(buf).digest('hex'));
const stamp = (d) => d.toISOString().replace(/[:.]/g, '-');

// Records one disruptive right-side operation to /evidence:
//   - a per-operation backup folder with before/after copies + meta.json
//   - an append-only line in audit.log (JSONL)
async function record({ operation, absPath, rightPath, before, after, actor, note, extra }) {
  const now = new Date();
  const safe = String(absPath).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);
  const folder = path.join(backupDir, `${stamp(now)}__${operation}__${safe}`);
  await fsp.mkdir(folder, { recursive: true });

  const ext = path.extname(String(absPath)) || '';
  const beforeFile = before != null ? path.join(folder, 'before' + ext) : null;
  const afterFile = after != null ? path.join(folder, 'after' + ext) : null;

  const rec = {
    timestamp: now.toISOString(),
    operation,
    actor: (actor || 'operator').toString().slice(0, 120),
    note: (note || '').toString().slice(0, 2000),
    absolute_path: absPath,
    right_path: rightPath,
    before: before != null ? { sha256: sha256(before), size_bytes: before.length, file: beforeFile } : null,
    after: after != null ? { sha256: sha256(after), size_bytes: after.length, file: afterFile } : null,
    backup_folder: folder,
    ...(extra || {}),
  };

  if (beforeFile) await fsp.writeFile(beforeFile, before);
  if (afterFile) await fsp.writeFile(afterFile, after);
  await fsp.writeFile(path.join(folder, 'meta.json'), JSON.stringify(rec, null, 2));
  await fsp.appendFile(auditLog, JSON.stringify(rec) + '\n');
  return rec;
}

// Lightweight audit line for non-destructive state changes (e.g. marking an
// entry fixed) — no backup folder, just an append to the trail.
async function event({ operation, absPath, actor, note, extra }) {
  const rec = {
    timestamp: new Date().toISOString(),
    operation,
    actor: (actor || 'operator').toString().slice(0, 120),
    note: (note || '').toString().slice(0, 2000),
    absolute_path: absPath,
    ...(extra || {}),
  };
  await fsp.mkdir(path.dirname(auditLog), { recursive: true });
  await fsp.appendFile(auditLog, JSON.stringify(rec) + '\n');
  return rec;
}

async function tail(limit = 200) {
  try {
    const txt = await fsp.readFile(auditLog, 'utf8');
    return txt.split(/\r?\n/).filter(Boolean).slice(-limit).reverse()
      .map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// --- backup lookup / listing (for restore/undo) ----------------------------
// Resolve a backup id — a bare folder name OR a full backup_folder path copied
// from the trail — to an absolute folder under backupDir, refusing traversal.
// The stored path may come from a different host/container, so we only ever
// trust the LAST path segment and re-anchor it to the current backupDir.
function backupPath(id) {
  const clean = String(id || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const name = clean.slice(clean.lastIndexOf('/') + 1); // accept full path or bare name
  if (!name || name === '.' || name === '..') { const e = new Error('invalid backup id'); e.status = 400; throw e; }
  const folder = path.resolve(backupDir, name);
  const root = path.resolve(backupDir);
  if (folder !== root && !folder.startsWith(root + path.sep)) { const e = new Error('invalid backup id'); e.status = 400; throw e; }
  return folder;
}

// Read one backup's meta.json. Returns { name, folder, meta } or null if absent.
async function readBackup(id) {
  const folder = backupPath(id);
  try {
    const meta = JSON.parse(await fsp.readFile(path.join(folder, 'meta.json'), 'utf8'));
    return { name: path.basename(folder), folder, meta };
  } catch (e) {
    if (e.code === 'ENOENT') return null; // no folder / no meta.json
    throw e;
  }
}

// List backup folders newest-first with a compact summary for the restore UI.
// Folder names are timestamp-prefixed, so a lexical reverse sort is chronological.
async function listBackups(limit = 500) {
  let names;
  try { names = await fsp.readdir(backupDir); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  names.sort().reverse();
  const out = [];
  for (const name of names) {
    if (out.length >= limit) break;
    let meta;
    try { meta = JSON.parse(await fsp.readFile(path.join(backupDir, name, 'meta.json'), 'utf8')); }
    catch { continue; } // not a backup folder / unreadable meta
    out.push({
      name,
      timestamp: meta.timestamp || null,
      operation: meta.operation || null,
      absolute_path: meta.absolute_path || null,
      actor: meta.actor || null,
      note: meta.note || '',
      has_before: !!meta.before,
      has_after: !!meta.after,
      // What a restore of this backup would do to the live file:
      undo: meta.before ? 'restore-content' : 'delete-file',
    });
  }
  return out;
}

module.exports = { record, event, tail, readBackup, listBackups, backupDir, auditLog };
