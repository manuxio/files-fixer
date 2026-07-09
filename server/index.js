'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const config = require('./config');
const { getDiff, applyFixed } = require('./diff');
const { resolveSide } = require('./paths');
const audit = require('./audit');
const fixedStore = require('./fixed');

const app = express();
app.use(express.json({ limit: '25mb' }));

const MAX_READ = 8 * 1024 * 1024; // cap single-file view at 8MB

const operatorOf = (req) =>
  (req.get('x-operator') || (req.body && req.body.operator) || 'operator').toString().slice(0, 120);

const fail = (res, code, e) => res.status(code).json({ error: String((e && e.message) || e) });

app.get('/api/health', (req, res) => res.json({ ok: true, config: {
  leftRoot: config.leftRoot, rightRoot: config.rightRoot, evidenceRoot: config.evidenceRoot,
  leftCsv: config.leftCsv, rightCsv: config.rightCsv, prefix: config.csvPrefix,
} }));

// Full diff, grouped by website. ?refresh=1 re-reads the CSVs.
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
    const full = resolveSide('right', abs);
    let before;
    try { before = await fsp.readFile(full); }
    catch { return fail(res, 404, 'right file not found'); }
    await fsp.rm(full);
    const record = await audit.record({ operation: 'delete', absPath: abs, rightPath: full, before, after: null, actor: operatorOf(req), note: req.body.note });
    res.json({ ok: true, record });
  } catch (e) { fail(res, 400, e); }
});

// Overwrite (or restore) a right-side file with the left-side source (logged + backed up).
app.post('/api/overwrite', async (req, res) => {
  try {
    const abs = req.body.path;
    if (!abs) return fail(res, 400, 'path required');
    const lp = resolveSide('left', abs);
    const rp = resolveSide('right', abs);
    let after;
    try { after = await fsp.readFile(lp); }
    catch { return fail(res, 404, 'left source not found'); }
    let before = null;
    try { before = await fsp.readFile(rp); } catch { /* right may not exist (restore) */ }
    await fsp.mkdir(path.dirname(rp), { recursive: true });
    await fsp.writeFile(rp, after);
    const record = await audit.record({ operation: 'overwrite', absPath: abs, rightPath: rp, before, after, actor: operatorOf(req), note: req.body.note, extra: { source_left_path: lp } });
    res.json({ ok: true, record });
  } catch (e) { fail(res, 400, e); }
});

// Save edited content to a right-side file (logged + backed up).
app.post('/api/save', async (req, res) => {
  try {
    const abs = req.body.path;
    if (!abs) return fail(res, 400, 'path required');
    if (typeof req.body.content !== 'string') return fail(res, 400, 'content required');
    const rp = resolveSide('right', abs);
    let before = null;
    try { before = await fsp.readFile(rp); } catch { /* new file */ }
    const after = Buffer.from(req.body.content, 'utf8');
    await fsp.mkdir(path.dirname(rp), { recursive: true });
    await fsp.writeFile(rp, after);
    const record = await audit.record({ operation: 'edit', absPath: abs, rightPath: rp, before, after, actor: operatorOf(req), note: req.body.note });
    res.json({ ok: true, record });
  } catch (e) { fail(res, 400, e); }
});

// Mark/unmark an entry as fixed (persistent, all statuses). Updates the sidecar,
// materializes a `fixed` column into the right CSV, and logs the change.
app.post('/api/fixed', async (req, res) => {
  try {
    const abs = req.body.path;
    if (!abs) return fail(res, 400, 'path required');
    const fixed = !!req.body.fixed;
    const actor = operatorOf(req);
    const at = new Date().toISOString();
    const val = await fixedStore.set(abs, fixed, actor, at);
    applyFixed(abs, val);
    await audit.event({ operation: fixed ? 'mark-fixed' : 'unmark-fixed', absPath: abs, actor, note: req.body.note });
    res.json({ ok: true, fixed, at: fixed ? at : null, by: fixed ? actor : null });
  } catch (e) { fail(res, 400, e); }
});

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
});
