'use strict';
// Compare a website file against the pristine JCE source that the dropper
// installs. The JCE package is a package-of-zips; each inner extension zip
// already stores files in installed-path form (administrator/components/com_jce/…,
// plugins/content/jce/…), so we extract them into memory and match a live file
// by its longest trailing path-segment run — mirroring the "vs Joomla" lookup.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const config = require('./config');
const { stripPrefix } = require('./paths');

const TEXT_RE = /\.(php|php[0-9]?|phtml|inc|js|mjs|cjs|css|less|html?|xml|ini|json|txt|htaccess)$/i;
const cache = new Map(); // id -> { files: Map<rel,{content,size,sha256}>, byBase: Map<base,[rel]> }

const allowedIds = () => [config.jcePkgFull, config.jcePkgPatch];

function listSources() {
  const label = (f) => {
    if (f === config.jcePkgFull) return 'JCE ' + config.jceTarget + ' (full package)';
    if (f === config.jcePkgPatch) return 'JCE security patch (2.7.x–2.9.x)';
    return f;
  };
  const out = [];
  for (const f of allowedIds()) {
    if (f && fs.existsSync(path.join(config.jceAssetsRoot, f))) out.push({ id: f, label: label(f) });
  }
  return out;
}

function addFile(idx, rel, buf) {
  if (!TEXT_RE.test(rel) || buf.length > 4 * 1024 * 1024) return;
  idx.files.set(rel, {
    content: buf.toString('utf8'),
    size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  });
  const base = rel.split('/').pop();
  const arr = idx.byBase.get(base) || [];
  arr.push(rel);
  idx.byBase.set(base, arr);
}

function buildIndex(id) {
  const idx = { files: new Map(), byBase: new Map() };
  const top = new AdmZip(path.join(config.jceAssetsRoot, id));
  for (const e of top.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName;
    if (/\.zip$/i.test(name)) {
      // nested extension zip — prefix keys with its name to keep them distinct
      let sub;
      try { sub = new AdmZip(e.getData()); } catch { continue; }
      const prefix = name.replace(/^packages\//i, '').replace(/\.zip$/i, '');
      for (const se of sub.getEntries()) {
        if (!se.isDirectory) addFile(idx, prefix + '/' + se.entryName, se.getData());
      }
    } else {
      addFile(idx, name, e.getData());
    }
  }
  return idx;
}

function index(id) {
  if (!allowedIds().includes(id)) { const e = new Error('unknown JCE source'); e.status = 400; throw e; }
  if (!cache.has(id)) cache.set(id, buildIndex(id));
  return cache.get(id);
}

// Longest-trailing-segment match of `absPath` against the extracted files.
function findFile(id, absPath) {
  const idx = index(id);
  const segs = stripPrefix(absPath).split('/').filter(Boolean);
  if (!segs.length) return { exists: false, version: id };
  const cands = idx.byBase.get(segs[segs.length - 1]) || [];
  let best = null;
  let bestScore = 0;
  for (const rel of cands) {
    const rs = rel.split('/');
    let score = 0;
    for (let i = 1; i <= Math.min(segs.length, rs.length); i++) {
      if (segs[segs.length - i].toLowerCase() === rs[rs.length - i].toLowerCase()) score += 1;
      else break;
    }
    if (score > bestScore) { bestScore = score; best = rel; }
  }
  // Require ≥2 matching trailing segments (filename + parent dir) — a bare
  // basename match (e.g. index.php) is not a confident JCE-file identification.
  if (!best || bestScore < 2) return { exists: false, version: id };
  const f = idx.files.get(best);
  return { exists: true, version: id, jcePath: best, matched_segments: bestScore, size: f.size, sha256: f.sha256, content: f.content };
}

// Every content sha256 across all available JCE source packages (for the
// known-good index — a live file matching one of these is pristine JCE).
function sourceShas() {
  const out = new Set();
  for (const s of listSources()) {
    try { for (const f of index(s.id).files.values()) out.add(f.sha256); }
    catch { /* skip a package that won't open */ }
  }
  return out;
}

module.exports = { listSources, findFile, sourceShas };
