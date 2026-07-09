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

module.exports = { record, tail, backupDir, auditLog };
