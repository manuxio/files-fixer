'use strict';
// Shared remediation actions. These are the exact bodies the HTTP routes in
// index.js used to inline (delete / overwrite / save / mark-fixed): perform the
// mutation, record evidence (audit + backups), and broadcast the same live
// event — so the automation agents (agents.js) and the routes stay perfectly
// in sync. `clientId` is the originating browser (null for server-side agents).
const path = require('path');
const fsp = require('fs/promises');
const { resolveSide, websiteOf } = require('./paths');
const { applyFixed } = require('./diff');
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
  events.broadcast('fixed', { path: abs, website: websiteOf(abs), fixed: !!fixed, at: fixed ? at : null, by: fixed ? actor : null, clientId: clientId || null });
  return { fixed: !!fixed, at: fixed ? at : null, by: fixed ? actor : null };
}

module.exports = { deleteRight, overwriteFromLeft, saveRight, setFixed };
