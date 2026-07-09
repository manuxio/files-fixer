'use strict';
// Persistent "fixed" tracking.
//
// Source of truth is a small sidecar (/evidence/fixed.json) keyed by
// absolute_path — cheap to write, covers every status (including deleted
// entries, which have no row in the right CSV). We ALSO materialize a `fixed`
// column into the right CSV (added if missing) as requested, but do so
// debounced/streamed in the background so a huge manifest is not rewritten on
// every click, and so the UI never blocks on it. On startup both sources are
// merged (sidecar wins).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { parse } = require('csv-parse');
const config = require('./config');

const SIDECAR = path.join(config.evidenceRoot, 'fixed.json');

const state = new Map(); // absolute_path -> { at, by }

(function load() {
  try {
    const obj = JSON.parse(fs.readFileSync(SIDECAR, 'utf8'));
    for (const [k, v] of Object.entries(obj)) {
      state.set(k, v && typeof v === 'object' ? { at: v.at || '', by: v.by || '' } : { at: String(v), by: '' });
    }
  } catch { /* no sidecar yet */ }
})();

const get = (p) => state.get(p) || null;
const snapshot = () => { const o = {}; for (const [k, v] of state) o[k] = v; return o; };

async function replace(tmp, dest) {
  try { await fsp.rename(tmp, dest); }
  catch { await fsp.rm(dest, { force: true }); await fsp.rename(tmp, dest); }
}

async function writeSidecar() {
  await fsp.mkdir(path.dirname(SIDECAR), { recursive: true });
  // Unique temp name so concurrent writes never collide on the same file.
  const tmp = SIDECAR + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(snapshot(), null, 2));
  await replace(tmp, SIDECAR);
}

// Serialize sidecar writes: bulk actions fire many /api/fixed calls at once, and
// concurrent temp-file writes/renames would otherwise race (only the first would
// land, the rest erroring). Each write persists the full current snapshot.
let writeChain = Promise.resolve();
function persist() {
  writeChain = writeChain.then(writeSidecar, writeSidecar).catch((e) => console.error('[fixed] sidecar write failed:', e.message));
  return writeChain;
}

async function set(p, fixed, by, at) {
  if (fixed) state.set(p, { at, by: by || '' });
  else state.delete(p);
  const result = fixed ? state.get(p) : null;
  await persist();           // durable, serialized
  scheduleMaterialize();     // reflect into right CSV in the background
  return result;
}

// --- background materialize of the `fixed` column into the right CSV ---------
let timer = null, flushing = false, dirty = false;
function scheduleMaterialize() {
  dirty = true;
  if (timer || flushing) return;
  timer = setTimeout(runFlush, 1200);
}
async function runFlush() {
  timer = null;
  if (flushing) return;
  flushing = true;
  try { while (dirty) { dirty = false; await materializeOnce(); } }
  catch (e) { console.error('[fixed] right CSV materialize failed:', e.message); }
  finally { flushing = false; if (dirty) scheduleMaterialize(); }
}

const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

// Rewrites config.rightCsv, adding/refreshing a `fixed` column for existing
// rows. Never appends phantom rows (that would corrupt the diff on reload).
async function materializeOnce() {
  const src = config.rightCsv;
  if (!fs.existsSync(src)) return;
  const tmp = src + '.materialize.tmp';
  const out = fs.createWriteStream(tmp);
  const write = (line) => new Promise((res, rej) => out.write(line, (e) => (e ? rej(e) : res())));

  let cols = null;
  const parser = fs.createReadStream(src).pipe(parse({
    columns: (hdr) => { cols = hdr.slice(); if (!cols.includes('fixed')) cols.push('fixed'); return hdr; },
    skip_empty_lines: true, relax_column_count: true, bom: true,
  }));

  let wroteHeader = false;
  for await (const rec of parser) {
    if (!wroteHeader) { await write(cols.join(',') + '\n'); wroteHeader = true; }
    const f = state.get(rec.absolute_path);
    rec.fixed = f ? f.at : (rec.fixed || '');
    await write(cols.map((c) => esc(rec[c])).join(',') + '\n');
  }
  if (!wroteHeader && cols) await write(cols.join(',') + '\n');
  await new Promise((res) => out.end(res));
  await replace(tmp, src);
}

module.exports = { get, snapshot, set, SIDECAR };
