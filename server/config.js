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
};

if (!config.leftCsv) config.leftCsv = path.join(config.evidenceRoot, 'left.csv');
if (!config.rightCsv) config.rightCsv = path.join(config.evidenceRoot, 'right.csv');

module.exports = config;
