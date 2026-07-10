'use strict';
const fs = require('fs');
const { parse } = require('csv-parse');
const config = require('./config');
const { websiteOf } = require('./paths');
const fixedStore = require('./fixed');
const classify = require('./classify');

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
        .map((f) => { f.riskBase = classify.scoreManifest(f); return f; })
        .sort((a, b) => a.absolute_path.localeCompare(b.absolute_path));
      // A fixed file counts ONLY as fixed, not in its added/modified/deleted bucket.
      // riskMax = highest score among still-open findings (drives a site indicator).
      const counts = { added: 0, modified: 0, deleted: 0, unchanged: w.unchanged, fixed: 0, riskMax: 0 };
      for (const f of files) {
        if (f.fixed) { counts.fixed += 1; continue; }
        counts[f.status] += 1;
        const s = (f.riskBase && f.riskBase.score) || 0;
        if (s > counts.riskMax) counts.riskMax = s;
      }
      return { name: w.name, counts, files };
    })
    // Surface websites with any change (still show fully-fixed sites).
    .filter((w) => w.counts.added + w.counts.modified + w.counts.deleted + w.counts.fixed > 0)
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
          // A fixed file leaves its added/modified/deleted bucket and joins "fixed".
          const s = f.status;
          const d = f.fixed ? 1 : -1;
          w.counts.fixed = Math.max(0, (w.counts.fixed || 0) + d);
          w.counts[s] = Math.max(0, (w.counts[s] || 0) - d);
          cache.totals.fixed = Math.max(0, (cache.totals.fixed || 0) + d);
          cache.totals[s] = Math.max(0, (cache.totals[s] || 0) - d);
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
// is omitted). Filters by status and a case-insensitive substring `q`. `sort`
// can be 'risk' (harmfulness desc) or defaults to path order.
async function queryFiles({ website, status, q, sort, offset = 0, limit = 200 } = {}) {
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
  if (sort === 'risk') {
    files = [...files].sort((a, b) =>
      classify.effectiveRisk(b).score - classify.effectiveRisk(a).score ||
      a.absolute_path.localeCompare(b.absolute_path));
  }
  const total = files.length;
  const off = Math.max(0, offset | 0);
  const lim = Math.min(Math.max(1, limit | 0), 1000);
  // Attach the current best (manifest- or content-tier) score to the page only.
  const page = files.slice(off, off + lim).map((f) => ({ ...f, risk: classify.effectiveRisk(f) }));
  return { total, offset: off, limit: lim, files: page };
}

// Look up a changed-file entry by its absolute path (for content classification).
function findFile(absPath) {
  return allFiles.find((f) => f.absolute_path === absPath) || null;
}

// Content checksum of a changed file: the right (live) sha when present,
// otherwise the left (baseline) sha for deleted files.
const contentSha = (f) => (f.right && f.right.sha256) || (f.left && f.left.sha256) || '';

// Other changed files (any website) byte-identical to the given one.
function sameSha(absPath) {
  const target = allFiles.find((f) => f.absolute_path === absPath);
  const sha = target ? contentSha(target) : '';
  if (!sha) return { sha: '', files: [] };
  const files = allFiles
    .filter((f) => f.absolute_path !== absPath && contentSha(f) === sha)
    .map((f) => ({ absolute_path: f.absolute_path, filename: f.filename, website: f.website, status: f.status, fixed: !!f.fixed }));
  return { sha, files };
}

module.exports = { getDiff, getSummary, queryFiles, applyFixed, sameSha, findFile };
