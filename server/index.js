'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const config = require('./config');
const { getDiff, getSummary, queryFiles, applyFixed } = require('./diff');
const { resolveSide, websiteOf } = require('./paths');
const audit = require('./audit');
const fixedStore = require('./fixed');
const events = require('./events');
const joomla = require('./joomla');
const patches = require('./patches');
const remediate = require('./remediate');

const app = express();
app.use(express.json({ limit: '25mb' }));

const MAX_READ = 8 * 1024 * 1024; // cap single-file view at 8MB

// Every change-operation must be attributed. Reject when no operator name is set.
function requireOperator(req) {
  const name = (req.get('x-operator') || (req.body && req.body.operator) || '').toString().trim();
  if (!name) { const e = new Error('operator name required before making changes'); e.status = 400; throw e; }
  return name.slice(0, 120);
}

const fail = (res, code, e) => {
  const status = (e && e.status) || code;
  const msg = String((e && e.message) || e);
  console.error(`[api] ${status} ${msg}`); // every error goes to the container log
  return res.status(status).json({ error: msg });
};

const originOf = (req) => (req.body && req.body.clientId) || null;

// --- multi-user live updates (Server-Sent Events) ------------------------
app.get('/api/events', (req, res) => {
  const id = (req.query.clientId || '').toString() || ('c' + Math.random().toString(36).slice(2));
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  events.addClient(id, res);
  events.broadcastPresence();
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
  req.on('close', () => { clearInterval(ping); events.removeClient(id); });
});

// Presence heartbeat: which file/mode this client is on.
app.post('/api/presence', (req, res) => {
  const { clientId, operator, path: p, mode } = req.body || {};
  if (!clientId) return fail(res, 400, 'clientId required');
  events.setPresence(clientId, { operator, path: p, mode });
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, config: {
  leftRoot: config.leftRoot, rightRoot: config.rightRoot, evidenceRoot: config.evidenceRoot,
  leftCsv: config.leftCsv, rightCsv: config.rightCsv, prefix: config.csvPrefix,
} }));

// Lightweight sidebar payload: websites + counts only (no file lists).
// Also carries each website's latest JCE-patch status (for the <patched> label).
app.get('/api/summary', async (req, res) => {
  try {
    const s = await getSummary(req.query.refresh === '1');
    const pmap = patches.map();
    s.websites = s.websites.map((w) => (pmap[w.name]
      ? { ...w, patched: { status: pmap[w.name].status, at: pmap[w.name].timestamp, jce: pmap[w.name].jce_after } }
      : w));
    s.totals.patched = Object.values(pmap).filter((p) => p.status === 'patched').length;
    res.json(s);
  } catch (e) { fail(res, 500, e); }
});

// Paged files. Scope with ?website=, search across all with ?q=, filter with
// ?status=, page with ?offset=&limit=. Keeps large datasets off the wire.
app.get('/api/files', async (req, res) => {
  try {
    res.json(await queryFiles({
      website: req.query.website || undefined,
      status: req.query.status || 'all',
      q: (req.query.q || '').toString(),
      offset: Number(req.query.offset) || 0,
      limit: Number(req.query.limit) || 200,
    }));
  } catch (e) { fail(res, 500, e); }
});

// Full diff (everything at once) — kept for debugging/export. The UI uses
// /api/summary + /api/files instead so it never transfers the whole set.
app.get('/api/diff', async (req, res) => {
  try { res.json(await getDiff(req.query.refresh === '1')); }
  catch (e) { fail(res, 500, e); }
});

// Read one file from either side.
app.get('/api/file', async (req, res) => {
  try {
    const side = req.query.side === 'left' ? 'left' : 'right';
    const abs = req.query.path;
    if (!abs) return fail(res, 400, 'path required');
    const full = resolveSide(side, abs);
    let stat;
    try { stat = await fsp.stat(full); }
    catch { return res.json({ exists: false, side, absolute_path: abs }); }
    if (!stat.isFile()) return res.json({ exists: false, side, absolute_path: abs, note: 'not a regular file' });
    if (stat.size > MAX_READ) return res.json({ exists: true, tooLarge: true, size: stat.size, side, absolute_path: abs });
    const content = await fsp.readFile(full, 'utf8');
    res.json({ exists: true, side, absolute_path: abs, size: stat.size, mtime: stat.mtime.toISOString(), content });
  } catch (e) { fail(res, 400, e); }
});

// Delete a right-side file (logged + backed up).
app.post('/api/delete', async (req, res) => {
  try {
    const abs = req.body.path;
    if (!abs) return fail(res, 400, 'path required');
    const actor = requireOperator(req);
    const full = resolveSide('right', abs);
    let before;
    try { before = await fsp.readFile(full); }
    catch { return fail(res, 404, 'right file not found'); }
    await fsp.rm(full);
    const record = await audit.record({ operation: 'delete', absPath: abs, rightPath: full, before, after: null, actor, note: req.body.note });
    events.broadcast('mutated', { path: abs, website: websiteOf(abs), operation: 'delete', by: actor, at: record.timestamp, clientId: originOf(req) });
    res.json({ ok: true, record });
  } catch (e) { fail(res, 400, e); }
});

// Overwrite (or restore) a right-side file with the left-side source (logged + backed up).
app.post('/api/overwrite', async (req, res) => {
  try {
    const abs = req.body.path;
    if (!abs) return fail(res, 400, 'path required');
    const actor = requireOperator(req);
    const lp = resolveSide('left', abs);
    const rp = resolveSide('right', abs);
    let after;
    try { after = await fsp.readFile(lp); }
    catch { return fail(res, 404, 'left source not found'); }
    let before = null;
    try { before = await fsp.readFile(rp); } catch { /* right may not exist (restore) */ }
    await fsp.mkdir(path.dirname(rp), { recursive: true });
    await fsp.writeFile(rp, after);
    const record = await audit.record({ operation: 'overwrite', absPath: abs, rightPath: rp, before, after, actor, note: req.body.note, extra: { source_left_path: lp } });
    events.broadcast('mutated', { path: abs, website: websiteOf(abs), operation: 'overwrite', by: actor, at: record.timestamp, clientId: originOf(req) });
    res.json({ ok: true, record });
  } catch (e) { fail(res, 400, e); }
});

// Save edited content to a right-side file (logged + backed up).
app.post('/api/save', async (req, res) => {
  try {
    const abs = req.body.path;
    if (!abs) return fail(res, 400, 'path required');
    if (typeof req.body.content !== 'string') return fail(res, 400, 'content required');
    const actor = requireOperator(req);
    const rp = resolveSide('right', abs);
    let before = null;
    try { before = await fsp.readFile(rp); } catch { /* new file */ }
    const after = Buffer.from(req.body.content, 'utf8');
    await fsp.mkdir(path.dirname(rp), { recursive: true });
    await fsp.writeFile(rp, after);
    const record = await audit.record({ operation: 'edit', absPath: abs, rightPath: rp, before, after, actor, note: req.body.note });
    events.broadcast('mutated', { path: abs, website: websiteOf(abs), operation: 'edit', by: actor, at: record.timestamp, clientId: originOf(req) });
    res.json({ ok: true, record });
  } catch (e) { fail(res, 400, e); }
});

// Mark/unmark an entry as fixed (persistent, all statuses). Updates the sidecar,
// materializes a `fixed` column into the right CSV, and logs the change.
app.post('/api/fixed', async (req, res) => {
  try {
    const abs = req.body.path;
    if (!abs) return fail(res, 400, 'path required');
    const actor = requireOperator(req);
    const fixed = !!req.body.fixed;
    const at = new Date().toISOString();
    const val = await fixedStore.set(abs, fixed, actor, at);
    applyFixed(abs, val);
    await audit.event({ operation: fixed ? 'mark-fixed' : 'unmark-fixed', absPath: abs, actor, note: req.body.note });
    events.broadcast('fixed', { path: abs, website: websiteOf(abs), fixed, at: fixed ? at : null, by: fixed ? actor : null, clientId: originOf(req) });
    res.json({ ok: true, fixed, at: fixed ? at : null, by: fixed ? actor : null });
  } catch (e) { fail(res, 400, e); }
});

// Available pristine Joomla versions (subfolders of JOOMLA_ROOT).
app.get('/api/joomla/versions', async (req, res) => {
  try { res.json({ versions: await joomla.listVersions() }); }
  catch (e) { fail(res, 500, e); }
});

// Pristine Joomla core file matching a website path, for the chosen version.
app.get('/api/joomla/file', async (req, res) => {
  try {
    const version = req.query.version;
    const abs = req.query.path;
    if (!version) return fail(res, 400, 'version required');
    if (!abs) return fail(res, 400, 'path required');
    res.json(await joomla.findFile(version, abs));
  } catch (e) { fail(res, 400, e); }
});

// JCE remediation availability (are the bundled dropper + packages present?).
app.get('/api/jce/status', (req, res) => res.json(remediate.assetStatus()));

// Latest patch record per website + full history.
app.get('/api/patches', (req, res) => {
  res.json({ target: config.jceTarget, byWebsite: patches.map(), patches: patches.all() });
});

// Temporarily drop the dropper into <website>'s docroot and drive it to patch
// JCE to the target version. Logged to patches.csv + a per-run detail JSON,
// broadcast to other operators.
app.post('/api/patch-jce', async (req, res) => {
  try {
    const actor = requireOperator(req);
    const website = req.body && req.body.website;
    const baseUrl = req.body && req.body.baseUrl;
    if (!website) return fail(res, 400, 'website required');
    if (!baseUrl) return fail(res, 400, 'baseUrl required');
    console.log(`[api] patch-jce request: website=${website} baseUrl=${baseUrl} ip=${req.body.ip || '(DNS)'} operator=${actor} basicAuth=${req.body.basicUser ? 'yes' : 'no'}`);
    const { record, detail } = await remediate.patchWebsite({
      website, baseUrl, ip: req.body.ip,
      basicUser: req.body.basicUser, basicPass: req.body.basicPass,
      operator: actor,
    });
    await patches.append(record);
    await writePatchDetail(record, detail);
    await audit.event({
      operation: 'patch-jce', absPath: `${config.csvPrefix}/${website}/`, actor,
      note: `${record.status}: ${record.package} ${record.jce_before || '?'} -> ${record.jce_after || '?'} (${record.note})`,
      extra: { website, base_url: baseUrl, status: record.status, package: record.package },
    });
    events.broadcast('patched', {
      website, status: record.status, jce_after: record.jce_after, by: actor,
      at: record.timestamp, clientId: originOf(req),
    });
    res.json({ ok: true, record, detail });
  } catch (e) { fail(res, e.status || 400, e); }
});

async function writePatchDetail(record, detail) {
  try {
    const dir = path.join(config.evidenceRoot, 'patches');
    await fsp.mkdir(dir, { recursive: true });
    const stamp = record.timestamp.replace(/[:.]/g, '-');
    const safe = String(record.website).replace(/[^A-Za-z0-9._-]+/g, '_');
    await fsp.writeFile(path.join(dir, `${stamp}__${safe}.json`), JSON.stringify({ ...record, detail }, null, 2));
  } catch (e) { console.error('[patch] detail write failed:', e.message); }
}

app.get('/api/audit', async (req, res) => {
  try { res.json({ records: await audit.tail(Number(req.query.limit) || 200) }); }
  catch (e) { fail(res, 500, e); }
});

// --- static client (production build) ------------------------------------
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.listen(config.port, () => {
  console.log(`[files-fixer] listening on :${config.port}`);
  console.log(`  left   : ${config.leftRoot}   (${config.leftCsv})`);
  console.log(`  right  : ${config.rightRoot}   (${config.rightCsv})`);
  console.log(`  evidence: ${config.evidenceRoot}`);
  console.log(`  joomla  : ${config.joomlaRoot}`);
  const a = remediate.assetStatus();
  console.log(`  jce     : ${config.jceAssetsRoot} (dropper:${a.dropper} full:${a.full} patch:${a.patch}) target ${config.jceTarget}`);
});
