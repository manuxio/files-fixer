'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const config = require('./config');
const { getDiff, getSummary, queryFiles, sameSha, findFile } = require('./diff');
const { resolveSide } = require('./paths');
const audit = require('./audit');
const events = require('./events');
const joomla = require('./joomla');
const patches = require('./patches');
const remediate = require('./remediate');
const jcesrc = require('./jcesrc');
const classify = require('./classify');
const knowngood = require('./knowngood');
const rules = require('./rules');
const terminal = require('./terminal');
const actions = require('./actions');
const agents = require('./agents');

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

// Other changed files byte-identical to the given one (same content sha256).
app.get('/api/same-sha', async (req, res) => {
  try {
    await getDiff();
    const abs = req.query.path;
    if (!abs) return fail(res, 400, 'path required');
    res.json(sameSha(abs));
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
      sort: req.query.sort || undefined,
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
    // Upgrade this file's harmfulness score to the content tier — but only when
    // we're reading its PRIMARY side (right for added/modified, left for
    // deleted), so we never score a clean baseline against a tampered hash.
    const file = findFile(abs);
    let risk = file ? classify.effectiveRisk(file) : null;
    if (file) {
      const primary = file.right ? 'right' : 'left';
      if (side === primary) risk = classify.scoreContent(file, content);
    }
    res.json({ exists: true, side, absolute_path: abs, size: stat.size, mtime: stat.mtime.toISOString(), content, risk });
  } catch (e) { fail(res, 400, e); }
});

// Delete a right-side file (logged + backed up).
app.post('/api/delete', async (req, res) => {
  try {
    const abs = req.body.path;
    if (!abs) return fail(res, 400, 'path required');
    const actor = requireOperator(req);
    const record = await actions.deleteRight(abs, actor, { note: req.body.note, clientId: originOf(req) });
    res.json({ ok: true, record });
  } catch (e) { fail(res, 400, e); }
});

// Overwrite (or restore) a right-side file with the left-side source (logged + backed up).
app.post('/api/overwrite', async (req, res) => {
  try {
    const abs = req.body.path;
    if (!abs) return fail(res, 400, 'path required');
    const actor = requireOperator(req);
    const record = await actions.overwriteFromLeft(abs, actor, { note: req.body.note, clientId: originOf(req) });
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
    const record = await actions.saveRight(abs, req.body.content, actor, { note: req.body.note, clientId: originOf(req) });
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
    const r = await actions.setFixed(abs, !!req.body.fixed, actor, { note: req.body.note, clientId: originOf(req) });
    res.json({ ok: true, ...r });
  } catch (e) { fail(res, 400, e); }
});

// Undo a prior delete/overwrite/edit by restoring its backup snapshot. Accepts
// a backup id (bare folder name or the backup_folder path from the trail). The
// restore is logged + backed up as its own reversible 'restore' record.
app.post('/api/restore', async (req, res) => {
  try {
    const backup = req.body && (req.body.backup || req.body.name || req.body.backup_folder);
    if (!backup) return fail(res, 400, 'backup id required');
    const actor = requireOperator(req);
    const r = await actions.restoreFromBackup(backup, actor, { note: req.body.note, clientId: originOf(req) });
    res.json({ ok: true, ...r });
  } catch (e) { fail(res, e.status || 400, e); }
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

// Pristine JCE sources to diff against (the packages the dropper installs).
app.get('/api/jce/sources', (req, res) => {
  try { res.json({ sources: jcesrc.listSources(), target: config.jceTarget }); }
  catch (e) { fail(res, 500, e); }
});

// Pristine JCE file matching a website path, for the chosen source package.
app.get('/api/jce/file', (req, res) => {
  try {
    const version = req.query.version;
    const abs = req.query.path;
    if (!version) return fail(res, 400, 'version required');
    if (!abs) return fail(res, 400, 'path required');
    res.json(jcesrc.findFile(version, abs));
  } catch (e) { fail(res, e.status || 400, e); }
});

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

// Restorable backup snapshots (newest first) — drives the restore/undo UI.
app.get('/api/backups', async (req, res) => {
  try { res.json({ backups: await audit.listBackups(Number(req.query.limit) || 500) }); }
  catch (e) { fail(res, 500, e); }
});

// --- classifier rules (live CRUD + persisted) ----------------------------
// The effective rule set (built-ins ⊕ user rules) + known-good index status.
app.get('/api/rules', (req, res) => {
  try { res.json({ ...rules.list(), knowngood: knowngood.status() }); }
  catch (e) { fail(res, 500, e); }
});

// Create or update a user rule (also used to override a built-in by id).
app.post('/api/rules', async (req, res) => {
  try {
    const actor = requireOperator(req);
    const rule = await rules.upsert(req.body && req.body.rule);
    await audit.event({ operation: 'rule-upsert', absPath: `rule:${rule.id}`, actor, note: rule.name });
    events.broadcast('rules', { op: 'upsert', id: rule.id, by: actor, clientId: originOf(req) });
    res.json({ ok: true, rule });
  } catch (e) { fail(res, e.status || 400, e); }
});

// Enable/disable a rule (the only way to switch off a built-in).
app.post('/api/rules/disable', async (req, res) => {
  try {
    const actor = requireOperator(req);
    const { id, disabled } = req.body || {};
    await rules.setDisabled(id, disabled !== false);
    await audit.event({ operation: 'rule-disable', absPath: `rule:${id}`, actor, note: String(disabled !== false) });
    events.broadcast('rules', { op: 'disable', id, by: actor, clientId: originOf(req) });
    res.json({ ok: true });
  } catch (e) { fail(res, e.status || 400, e); }
});

// Delete a user rule (built-ins can only be disabled).
app.delete('/api/rules/:id', async (req, res) => {
  try {
    const actor = requireOperator(req);
    await rules.remove(req.params.id);
    await audit.event({ operation: 'rule-delete', absPath: `rule:${req.params.id}`, actor });
    events.broadcast('rules', { op: 'delete', id: req.params.id, by: actor, clientId: originOf(req) });
    res.json({ ok: true });
  } catch (e) { fail(res, e.status || 400, e); }
});

// --- Claude web shell ----------------------------------------------------
// Availability + profile list for the in-browser terminal (client connects to
// the ws at /api/terminal?profile=N once it knows the shell is enabled).
app.get('/api/claude/status', (req, res) => {
  try { res.json(terminal.status()); }
  catch (e) { fail(res, 500, e); }
});

// Live per-account usage (subscription rate-limit windows) for the profile
// picker. Queries Anthropic with each profile's stored OAuth token; failures
// are reported per profile, never as a whole-request error.
app.get('/api/claude/usage', async (req, res) => {
  try { res.json(await terminal.usage()); }
  catch (e) { fail(res, e.status || 500, e); }
});

// One-shot triage of a selected file with `claude -p` in the hardened sandbox.
// Returns { outcome: keep|delete|left|dontknow, brief_reason, profile, ... }.
app.post('/api/claude/analyze', async (req, res) => {
  try {
    const abs = req.body && req.body.path;
    if (!abs) return fail(res, 400, 'path required');
    const result = await terminal.analyze(abs);
    res.json({ ok: true, ...result });
  } catch (e) { fail(res, e.status || 500, e); }
});

// --- Claude automation (server-spawned agents) ----------------------------
// Which websites have agents running (button state) + live counts/stats.
app.get('/api/agents', (req, res) => {
  try { res.json(agents.status()); }
  catch (e) { fail(res, 500, e); }
});

// Spawn 1..5 agents that work through a website's unresolved changed files.
app.post('/api/agents/start', async (req, res) => {
  try {
    const actor = requireOperator(req);
    const { website, count } = req.body || {};
    if (!website) return fail(res, 400, 'website required');
    res.json({ ok: true, run: await agents.start(website, count, actor) });
  } catch (e) { fail(res, e.status || 400, e); }
});

// Stop the website's agents (each finishes its in-flight file first).
app.post('/api/agents/stop', (req, res) => {
  try {
    const actor = requireOperator(req);
    const website = req.body && req.body.website;
    if (!website) return fail(res, 400, 'website required');
    res.json({ ok: true, run: agents.stop(website, actor) });
  } catch (e) { fail(res, e.status || 400, e); }
});

// --- static client (production build) ------------------------------------
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

rules.load(); // load persisted user rules and apply them to the classifier
knowngood.build().catch((e) => console.error('[knowngood] build failed:', e.message)); // background sha index

const server = http.createServer(app);
terminal.attach(server); // Claude web shell PTY on /api/terminal (no-op if disabled)

server.listen(config.port, () => {
  console.log(`[files-fixer] listening on :${config.port}`);
  console.log(`  left   : ${config.leftRoot}   (${config.leftCsv})`);
  console.log(`  right  : ${config.rightRoot}   (${config.rightCsv})`);
  console.log(`  evidence: ${config.evidenceRoot}`);
  console.log(`  joomla  : ${config.joomlaRoot}`);
  const a = remediate.assetStatus();
  console.log(`  jce     : ${config.jceAssetsRoot} (dropper:${a.dropper} full:${a.full} patch:${a.patch}) target ${config.jceTarget}`);
});
