'use strict';
// Known-good content index: the sha256 of every file in the pristine upstream
// sources we have on hand (Joomla core trees under JOOMLA_ROOT + the JCE
// packages the dropper installs). A changed file whose content sha matches one
// of these is byte-identical to a legitimate upstream file — strong benign
// evidence, used by the `known-good-sha` classifier rule.
//
// The Joomla trees can be large, so the index is built lazily in the background
// and cached. `has()` simply returns false until the build finishes (the rule
// just doesn't fire yet); a diff refresh or file open re-scores once it's ready.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const jcesrc = require('./jcesrc');

const MAX_READ = 8 * 1024 * 1024;
let shas = new Set();
let building = null;
let ready = false;

async function hashTree(dir, set) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of ents) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { await hashTree(fp, set); continue; }
    if (!e.isFile()) continue;
    try {
      const st = await fsp.stat(fp);
      if (st.size > MAX_READ) continue;
      const buf = await fsp.readFile(fp);
      set.add(crypto.createHash('sha256').update(buf).digest('hex').toLowerCase());
    } catch { /* unreadable file — skip */ }
  }
}

async function build() {
  if (building) return building;
  building = (async () => {
    const set = new Set();
    // Joomla core: one subfolder per version under JOOMLA_ROOT.
    try {
      const vers = await fsp.readdir(config.joomlaRoot, { withFileTypes: true });
      for (const v of vers) if (v.isDirectory()) await hashTree(path.join(config.joomlaRoot, v.name), set);
    } catch { /* no joomla root */ }
    // JCE packages (extracted in memory by jcesrc).
    try { for (const s of jcesrc.sourceShas()) set.add(String(s).toLowerCase()); } catch { /* ignore */ }
    shas = set;
    ready = true;
    console.log(`[knowngood] indexed ${shas.size} pristine file hashes`);
    return shas;
  })();
  return building;
}

const has = (sha) => !!sha && shas.has(String(sha).toLowerCase());
const status = () => ({ ready, size: shas.size });

module.exports = { build, has, status };
