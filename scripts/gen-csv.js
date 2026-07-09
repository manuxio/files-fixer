'use strict';
// Walk a directory tree and emit a checksum manifest in the format the app expects:
//   absolute_path,filename,last_modified,size_bytes,sha256
// where absolute_path = <prefix>/<path-relative-to-root>.
//
// CLI:   node scripts/gen-csv.js <root> [prefix] [outFile]
// Module: const { generate } = require('./gen-csv'); generate(root, prefix, outFile)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(fp);
    else if (e.isFile()) yield fp;
  }
}

const csv = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function generate(root, prefix = '/mnt/data', outFile) {
  const rootAbs = path.resolve(root);
  const cleanPrefix = prefix.replace(/\/+$/, '');
  const rows = ['absolute_path,filename,last_modified,size_bytes,sha256'];
  for (const fp of walk(rootAbs)) {
    const rel = path.relative(rootAbs, fp).split(path.sep).join('/');
    const buf = fs.readFileSync(fp);
    const st = fs.statSync(fp);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    rows.push([csv(cleanPrefix + '/' + rel), csv(path.basename(fp)), csv(st.mtime.toISOString()), csv(st.size), csv(sha)].join(','));
  }
  const out = rows.join('\n') + '\n';
  if (outFile) { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, out); }
  return out;
}

module.exports = { generate };

if (require.main === module) {
  const [root, prefix, outFile] = process.argv.slice(2);
  if (!root) {
    console.error('usage: node scripts/gen-csv.js <root> [prefix=/mnt/data] [outFile]');
    process.exit(1);
  }
  const out = generate(root, prefix || '/mnt/data', outFile);
  if (outFile) console.error(`wrote ${outFile}`);
  else process.stdout.write(out);
}
