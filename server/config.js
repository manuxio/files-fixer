'use strict';
const fs = require('fs');
const path = require('path');

// --- minimal .env loader (no dependency) ---------------------------------
(function loadDotenv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
})();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  // Mounted data roots (the real files live here)
  leftRoot: process.env.LEFT_ROOT || '/left',
  rightRoot: process.env.RIGHT_ROOT || '/right',
  // Evidence folder: audit log + backups are written here
  evidenceRoot: process.env.EVIDENCE_ROOT || '/evidence',
  // Checksum manifests
  leftCsv: process.env.LEFT_CSV || '',
  rightCsv: process.env.RIGHT_CSV || '',
  // Prefix present in every CSV absolute_path, stripped to map onto the mounts
  csvPrefix: process.env.CSV_PATH_PREFIX || '/mnt/data',
  // Pristine Joomla sources root: one subfolder per version (e.g. Joomla-3.9.21/)
  joomlaRoot: process.env.JOOMLA_ROOT || '/joomla',
  // JCE remediation dropper + packages (bundled under ./assets; override with JCE_ASSETS_ROOT)
  jceAssetsRoot: process.env.JCE_ASSETS_ROOT || path.join(__dirname, '..', 'assets'),
  jceDropper: process.env.JCE_DROPPER || 'dropper.5.3.php',
  jcePkgFull: process.env.JCE_PKG_FULL || 'pkg_jce_pro_29998.zip',   // full upgrade -> 2.9.99.8
  jcePkgPatch: process.env.JCE_PKG_PATCH || 'patch_jce_27x_29x.zip', // legacy file-patch (PHP < 7.4)
  jceTarget: process.env.JCE_TARGET || '2.9.99.8',
  // Sent on dropper requests — Node sends no User-Agent by default, which many
  // WAFs/proxies answer with 503/403. A real UA avoids that.
  patchUserAgent: process.env.PATCH_USER_AGENT
    || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  patchExpirySec: parseInt(process.env.PATCH_EXPIRY_SEC || '1800', 10), // dropper token lifetime
  patchesCsv: process.env.PATCHES_CSV || '',
};

if (!config.leftCsv) config.leftCsv = path.join(config.evidenceRoot, 'left.csv');
if (!config.rightCsv) config.rightCsv = path.join(config.evidenceRoot, 'right.csv');
if (!config.patchesCsv) config.patchesCsv = path.join(config.evidenceRoot, 'patches.csv');

module.exports = config;
