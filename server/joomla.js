'use strict';
// Compare a website file against pristine Joomla core source.
//
// JOOMLA_ROOT holds one subfolder per version (folder name == version label,
// e.g. "Joomla-3.9.21"). Given a website file, we locate the matching core file
// by trying successive path suffixes (after the website segment) against the
// chosen version tree — so it works whether Joomla sits at the site root or in
// a subfolder.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { stripPrefix } = require('./paths');

const MAX_READ = 8 * 1024 * 1024;

// Numeric-aware version compare (so 3.10 > 3.9).
function cmp(a, b) {
  const na = a.match(/\d+/g) || [];
  const nb = b.match(/\d+/g) || [];
  const n = Math.max(na.length, nb.length);
  for (let i = 0; i < n; i++) {
    const x = Number(na[i] || 0);
    const y = Number(nb[i] || 0);
    if (x !== y) return x - y;
  }
  return a.localeCompare(b);
}

async function listVersions() {
  try {
    const ents = await fsp.readdir(config.joomlaRoot, { withFileTypes: true });
    return ents
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => cmp(b, a)) // newest first
      .map((d) => ({ id: d, label: d }));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function versionRoot(version) {
  if (!version || /[\\/]/.test(version) || version.includes('..')) throw new Error('invalid version');
  return path.resolve(config.joomlaRoot, version);
}

// Find the pristine core file matching `absPath` in the given version.
async function findFile(version, absPath) {
  const root = versionRoot(version);
  const segs = stripPrefix(absPath).split('/').filter(Boolean);
  // Start after the website segment (i=1); longest suffix first.
  for (let i = 1; i < segs.length; i++) {
    const candidate = segs.slice(i).join('/');
    const full = path.resolve(root, candidate);
    if (full !== root && !full.startsWith(root + path.sep)) continue;
    let st;
    try { st = await fsp.stat(full); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.size > MAX_READ) return { exists: true, tooLarge: true, size: st.size, version, joomlaPath: candidate };
    const buf = await fsp.readFile(full);
    return {
      exists: true,
      version,
      joomlaPath: candidate,
      size: st.size,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      content: buf.toString('utf8'),
    };
  }
  return { exists: false, version };
}

module.exports = { listVersions, findFile };
