'use strict';
// Shared remediation actions. These are the exact bodies the HTTP routes in
// index.js used to inline (delete / overwrite / save / mark-fixed): perform the
// mutation, record evidence (audit + backups), and broadcast the same live
// event — so the automation agents (agents.js) and the routes stay perfectly
// in sync. `clientId` is the originating browser (null for server-side agents).
const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { resolveSide, websiteOf } = require('./paths');
const { applyFixed, findFile } = require('./diff');
const audit = require('./audit');
const fixedStore = require('./fixed');
const events = require('./events');

// Delete a right-side file (logged + backed up).
async function deleteRight(abs, actor, { note, clientId } = {}) {
  const full = resolveSide('right', abs);
  let before;
  try { before = await fsp.readFile(full); }
  catch { const e = new Error('right file not found'); e.status = 404; throw e; }
  await fsp.rm(full);
  const record = await audit.record({ operation: 'delete', absPath: abs, rightPath: full, before, after: null, actor, note });
  events.broadcast('mutated', { path: abs, website: websiteOf(abs), operation: 'delete', by: actor, at: record.timestamp, clientId: clientId || null });
  return record;
}

// Overwrite (or restore) a right-side file with the left-side source (logged + backed up).
async function overwriteFromLeft(abs, actor, { note, clientId } = {}) {
  const lp = resolveSide('left', abs);
  const rp = resolveSide('right', abs);
  let after;
  try { after = await fsp.readFile(lp); }
  catch { const e = new Error('left source not found'); e.status = 404; throw e; }
  let before = null;
  try { before = await fsp.readFile(rp); } catch { /* right may not exist (restore) */ }
  await fsp.mkdir(path.dirname(rp), { recursive: true });
  await fsp.writeFile(rp, after);
  const record = await audit.record({ operation: 'overwrite', absPath: abs, rightPath: rp, before, after, actor, note, extra: { source_left_path: lp } });
  events.broadcast('mutated', { path: abs, website: websiteOf(abs), operation: 'overwrite', by: actor, at: record.timestamp, clientId: clientId || null });
  return record;
}

// Save edited content to a right-side file (logged + backed up).
async function saveRight(abs, content, actor, { note, clientId } = {}) {
  const rp = resolveSide('right', abs);
  let before = null;
  try { before = await fsp.readFile(rp); } catch { /* new file */ }
  const after = Buffer.from(content, 'utf8');
  await fsp.mkdir(path.dirname(rp), { recursive: true });
  await fsp.writeFile(rp, after);
  const record = await audit.record({ operation: 'edit', absPath: abs, rightPath: rp, before, after, actor, note });
  events.broadcast('mutated', { path: abs, website: websiteOf(abs), operation: 'edit', by: actor, at: record.timestamp, clientId: clientId || null });
  return record;
}

// Mark/unmark an entry as fixed (sidecar + right-CSV column + audit + broadcast).
async function setFixed(abs, fixed, actor, { note, clientId } = {}) {
  const at = new Date().toISOString();
  const val = await fixedStore.set(abs, !!fixed, actor, at);
  applyFixed(abs, val);
  await audit.event({ operation: fixed ? 'mark-fixed' : 'unmark-fixed', absPath: abs, actor, note });
  // `status` (added|modified|deleted) lets clients move the file between counters
  // live; applyFixed above doesn't change it. Null when the path isn't in the diff.
  const f = findFile(abs);
  events.broadcast('fixed', { path: abs, website: websiteOf(abs), status: f ? f.status : null, fixed: !!fixed, at: fixed ? at : null, by: fixed ? actor : null, clientId: clientId || null });
  return { fixed: !!fixed, at: fixed ? at : null, by: fixed ? actor : null };
}

// Undo a prior delete/overwrite/edit by restoring its backup snapshot. Reverts
// the recorded operation to the file's state BEFORE it ran:
//   - before != null -> write that snapshot back to the right-side file
//   - before == null -> the op CREATED the file, so undo = delete it
// The restore is itself recorded (operation:'restore') with a fresh before/after
// backup, so it is fully reversible and shows up in the trail. The live target
// is recomputed from absolute_path via resolveSide — never the stored right_path,
// which may belong to a different host/container.
async function restoreFromBackup(backupId, actor, { note, clientId } = {}) {
  const b = await audit.readBackup(backupId); // throws on a bad/traversing id
  if (!b) { const e = new Error('backup not found'); e.status = 404; throw e; }
  const meta = b.meta;
  if (!meta || !meta.absolute_path) { const e = new Error('backup meta is missing or corrupt'); e.status = 422; throw e; }

  const abs = meta.absolute_path;
  const rp = resolveSide('right', abs); // path-traversal guarded

  // The snapshot to put back = the file's pre-operation ("before") state.
  let restored = null; // null => undo means DELETE the current file
  if (meta.before) {
    const ext = path.extname(String(abs)) || ''; // same naming record() used
    const beforeFile = path.join(b.folder, 'before' + ext);
    try { restored = await fsp.readFile(beforeFile); }
    catch { const e = new Error(`backup snapshot (before${ext}) is missing`); e.status = 422; throw e; }
    // Integrity gate: the snapshot must match the hash captured at record time.
    if (meta.before.sha256) {
      const got = crypto.createHash('sha256').update(restored).digest('hex');
      if (got !== meta.before.sha256) { const e = new Error('backup snapshot is corrupt (sha256 mismatch)'); e.status = 422; throw e; }
    }
  }

  // Capture the CURRENT right-side content so this restore can itself be undone.
  let current = null;
  try { current = await fsp.readFile(rp); } catch { /* target may not exist */ }

  if (restored != null) {
    await fsp.mkdir(path.dirname(rp), { recursive: true });
    await fsp.writeFile(rp, restored);
  } else {
    await fsp.rm(rp, { force: true }); // undo of a create
  }

  const record = await audit.record({
    operation: 'restore', absPath: abs, rightPath: rp,
    before: current, after: restored, actor, note,
    extra: { restored_from: b.name, undo_of: meta.operation || null, undo_of_at: meta.timestamp || null },
  });

  // Undoing a remediation clears the now-stale "fixed" flag — but only when it
  // was actually set, so we don't emit a spurious unmark-fixed audit line. This
  // also fixes the sidecar, the right-CSV column, the cached counts, and pushes
  // a 'fixed' event to the other operators.
  let unfixed = false;
  if (fixedStore.get(abs)) {
    await setFixed(abs, false, actor, { note: `undo of ${meta.operation || 'change'} (restore)`, clientId });
    unfixed = true;
  }

  events.broadcast('mutated', { path: abs, website: websiteOf(abs), operation: 'restore', by: actor, at: record.timestamp, clientId: clientId || null });
  return { record, undo_of: meta.operation || null, absolute_path: abs, result: restored != null ? 'restored' : 'deleted', unfixed };
}

module.exports = { deleteRight, overwriteFromLeft, saveRight, setFixed, restoreFromBackup };
