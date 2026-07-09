'use strict';
// Persistent record of JCE remediation runs, in a new CSV under /evidence.
// One appended row per patch attempt; an in-memory map keeps the latest row per
// website (for the sidebar <patched> label and the summary).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');

const CSV = config.patchesCsv;
const COLS = ['timestamp', 'website', 'operator', 'base_url', 'php_version',
  'joomla_version', 'jce_before', 'jce_after', 'package', 'status', 'note'];

const byWebsite = new Map();

function splitCsv(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else { q = false; } }
      else { cur += c; }
    } else if (c === '"') { q = true; }
    else if (c === ',') { out.push(cur); cur = ''; }
    else { cur += c; }
  }
  out.push(cur);
  return out;
}
const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

(function load() {
  try {
    const lines = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter(Boolean);
    if (!lines.length) return;
    const hdr = splitCsv(lines[0]);
    for (let i = 1; i < lines.length; i++) {
      const cells = splitCsv(lines[i]);
      const rec = {};
      hdr.forEach((h, j) => { rec[h] = cells[j] != null ? cells[j] : ''; });
      if (rec.website) byWebsite.set(rec.website, rec); // last row wins = latest
    }
  } catch (e) { if (e.code !== 'ENOENT') console.error('[patches] load failed:', e.message); }
})();

async function append(rec) {
  await fsp.mkdir(path.dirname(CSV), { recursive: true });
  const exists = fs.existsSync(CSV);
  let out = exists ? '' : COLS.join(',') + '\n';
  out += COLS.map((c) => esc(rec[c])).join(',') + '\n';
  await fsp.appendFile(CSV, out);
  if (rec.website) byWebsite.set(rec.website, { ...rec });
  return rec;
}

const get = (website) => byWebsite.get(website) || null;
const map = () => { const o = {}; for (const [k, v] of byWebsite) o[k] = v; return o; };
const all = () => [...byWebsite.values()];

module.exports = { append, get, map, all, CSV, COLS };
