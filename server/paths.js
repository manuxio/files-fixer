'use strict';
const path = require('path');
const config = require('./config');

// Turn a CSV absolute_path (/mnt/data/<website>/a/b.php) into a root-relative
// path (<website>/a/b.php) by stripping the configured prefix.
function stripPrefix(absPath) {
  let p = String(absPath).replace(/\\/g, '/').trim();
  const prefix = config.csvPrefix.replace(/\\/g, '/').replace(/\/+$/, '');
  if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length);
  return p.replace(/^\/+/, '');
}

// First path segment after the prefix == website name.
function websiteOf(absPath) {
  const seg = stripPrefix(absPath).split('/').filter(Boolean);
  return seg.length ? seg[0] : '(root)';
}

function rootFor(side) {
  if (side === 'left') return config.leftRoot;
  if (side === 'right') return config.rightRoot;
  throw new Error('invalid side: ' + side);
}

// Resolve a CSV path to a real filesystem path under the given mount,
// refusing anything that escapes the mount root (path-traversal guard).
function resolveSide(side, absPath) {
  const root = path.resolve(rootFor(side));
  const full = path.resolve(root, stripPrefix(absPath));
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('path escapes ' + side + ' root');
  }
  return full;
}

module.exports = { stripPrefix, websiteOf, rootFor, resolveSide };
