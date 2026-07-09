'use strict';
const fs = require('fs');
const { parse } = require('csv-parse');
const config = require('./config');
const { websiteOf } = require('./paths');
const fixedStore = require('./fixed');

let cache = null;      // last computed result (websites + counts + files)
let allFiles = [];     // flat list of every changed file (refs shared with cache)
let building = null;   // in-flight promise (de-dupes concurrent requests)

function row(r) {
  const ap = r.absolute_path;
  if (!ap) return null;
  return {
    filename: r.filename || ap.split('/').pop(),
    last_modified: r.last_modified || '',
    size_bytes: r.size_bytes !== undefined && r.size_bytes !== '' ? Number(r.size_bytes) : null,
    sha256: (r.sha256 || '').toLowerCase(),
    fixed: r.fixed || '', // may already carry the materialized column
  };
}

// Merge persistent fixed-state onto a file entry. Sidecar (fixedStore) wins;
// otherwise fall back to a `fixed` value already present in the right CSV.
function overlayFixed(f) {
  const s = fixedStore.get(f.absolute_path);
  const csvFixed = f.right && f.right.fixed;
  if (s) { f.fixed = true; f.fixedAt = s.at || ''; f.fixedBy = s.by || ''; }
  else if (csvFixed) { f.fixed = true; f.fixedAt = csvFixed; f.fixedBy = ''; }
  else { f.fixed = false; f.fixedAt = null; f.fixedBy = null; }
  return f;
}

function parser(file) {
  return fs.createReadStream(file).pipe(parse({
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    bom: true,
  }));
}

// Streams both CSVs. The full left manifest is held in a Map; the right side is
// streamed and diffed on the fly, deleting matches from the left Map so that
// whatever remains is "deleted on the right". Peak memory ~= one manifest.
async function computeDiff() {
  const left = new Map();
  for await (const r of parser(config.leftCsv)) {
    if (r.absolute_path) left.set(r.absolute_path, row(r));
  }

  const websites = new Map();
  const bucket = (name) => {
    let w = websites.get(name);
    if (!w) { w = { name, added: [], modified: [], deleted: [], unchanged: 0 }; websites.set(name, w); }
    return w;
  };

  for await (const r of parser(config.rightCsv)) {
    const ap = r.absolute_path;
    if (!ap) continue;
    const right = row(r);
    const name = websiteOf(ap);
    const w = bucket(name);
    const l = left.get(ap);
    if (!l) {
      w.added.push({ absolute_path: ap, filename: right.filename, website: name, status: 'added', right });
    } else {
      if (l.sha256 !== right.sha256) {
        w.modified.push({ absolute_path: ap, filename: right.filename, website: name, status: 'modified', left: l, right });
      } else {
        w.unchanged++;
      }
      left.delete(ap);
    }
  }

  for (const [ap, l] of left) {
    const name = websiteOf(ap);
    bucket(name).deleted.push({ absolute_path: ap, filename: l.filename, website: name, status: 'deleted', left: l });
  }

  const list = [...websites.values()]
    .map((w) => {
      const files = [...w.added, ...w.modified, ...w.deleted]
        .map(overlayFixed)
        .sort((a, b) => a.absolute_path.localeCompare(b.absolute_path));
      return {
        name: w.name,
        counts: {
          added: w.added.length, modified: w.modified.length, deleted: w.deleted.length,
          unchanged: w.unchanged, fixed: files.filter((f) => f.fixed).length,
        },
        files,
      };
    })
    // Only surface websites that actually have differences.
    .filter((w) => w.counts.added + w.counts.modified + w.counts.deleted > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const totals = list.reduce((t, w) => {
    t.added += w.counts.added; t.modified += w.counts.modified;
    t.deleted += w.counts.deleted; t.unchanged += w.counts.unchanged;
    t.fixed += w.counts.fixed;
    t.websites += 1; return t;
  }, { websites: 0, added: 0, modified: 0, deleted: 0, unchanged: 0, fixed: 0 });

  return {
    generatedAt: new Date().toISOString(),
    prefix: config.csvPrefix,
    leftCsv: config.leftCsv,
    rightCsv: config.rightCsv,
    totals,
    websites: list,
  };
}

// Update the cached diff in place after a fixed-state toggle (avoids a full
// recompute). `val` is { at, by } when fixed, or null when unfixed. Files in
// `allFiles` are the same object refs, so mutating here updates both views.
function applyFixed(absPath, val) {
  if (!cache) return;
  for (const w of cache.websites) {
    for (const f of w.files) {
      if (f.absolute_path === absPath) {
        const was = !!f.fixed;
        if (val) { f.fixed = true; f.fixedAt = val.at || ''; f.fixedBy = val.by || ''; }
        else { f.fixed = false; f.fixedAt = null; f.fixedBy = null; }
        if (was !== !!f.fixed) {
          const delta = f.fixed ? 1 : -1;
          w.counts.fixed = Math.max(0, (w.counts.fixed || 0) + delta);
          cache.totals.fixed = Math.max(0, (cache.totals.fixed || 0) + delta);
        }
        return;
      }
    }
  }
}

async function getDiff(refresh = false) {
  if (cache && !refresh) return cache;
  if (building) return building;
  building = computeDiff()
    .then((res) => {
      cache = res;
      allFiles = res.websites.flatMap((w) => w.files);
      building = null;
      return res;
    })
    .catch((e) => { building = null; throw e; });
  return building;
}

// Small payload for the sidebar: websites + counts only, never file lists.
async function getSummary(refresh = false) {
  const d = await getDiff(refresh);
  return {
    generatedAt: d.generatedAt,
    prefix: d.prefix,
    leftCsv: d.leftCsv,
    rightCsv: d.rightCsv,
    totals: d.totals,
    websites: d.websites.map((w) => ({ name: w.name, counts: w.counts })),
  };
}

// Paged file query. Scope to one website, or search across all (when `website`
// is omitted). Filters by status and a case-insensitive substring `q`.
async function queryFiles({ website, status, q, offset = 0, limit = 200 } = {}) {
  await getDiff();
  let files;
  if (website) {
    const w = cache.websites.find((x) => x.name === website);
    files = w ? w.files : [];
  } else {
    files = allFiles;
  }
  if (status && status !== 'all') files = files.filter((f) => f.status === status);
  if (q) {
    const s = q.toLowerCase();
    files = files.filter((f) =>
      f.filename.toLowerCase().includes(s) ||
      f.absolute_path.toLowerCase().includes(s) ||
      f.website.toLowerCase().includes(s));
  }
  const total = files.length;
  const off = Math.max(0, offset | 0);
  const lim = Math.min(Math.max(1, limit | 0), 1000);
  return { total, offset: off, limit: lim, files: files.slice(off, off + lim) };
}

module.exports = { getDiff, getSummary, queryFiles, applyFixed };
