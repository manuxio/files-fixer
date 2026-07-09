'use strict';
// JCE remediation orchestration.
//
// For a chosen website (on the RIGHT side): template dropper.5.3.php with a
// fresh token + short expiry, drop it plus both JCE .zip packages into the
// site's docroot, drive it over HTTP (preflight -> install -> verify), then
// ALWAYS remove the dropper + zips (temporary drop). Returns a summary record
// plus the full dropper responses; persistence/notify is done by the caller.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const config = require('./config');

const cmpVer = (a, b) => {
  const A = String(a).match(/\d+/g) || [];
  const B = String(b).match(/\d+/g) || [];
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) { const x = +(A[i] || 0); const y = +(B[i] || 0); if (x !== y) return x - y; }
  return 0;
};
const phpLt = (a, b) => cmpVer(a, b) < 0;

// One HTTP call to the dropper. POST form-encoded so the token is not left in
// the target's access log. HTTPS certs are NOT verified (policy: messy fleet).
function httpJson(url, { headers = {}, body = null, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const opts = { method: 'POST', headers: { ...headers }, timeout: timeoutMs };
    if (url.protocol === 'https:') opts.rejectUnauthorized = false;
    if (body != null) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = lib.request(url, opts, (res) => {
      let data = ''; let size = 0; const CAP = 16 * 1024 * 1024;
      res.on('data', (c) => { size += c.length; if (size <= CAP) data += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json, bodySnippet: json ? null : data.slice(0, 500) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out after ' + timeoutMs + 'ms')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function call(baseUrl, dropperName, params, { basicUser, basicPass, timeout }) {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const url = new URL(dropperName, base);
  const body = new URLSearchParams(params).toString();
  const headers = {};
  if (basicUser) headers.Authorization = 'Basic ' + Buffer.from(`${basicUser}:${basicPass || ''}`).toString('base64');
  return httpJson(url, { headers, body, timeoutMs: timeout });
}

async function patchWebsite({ website, baseUrl, basicUser, basicPass, operator }) {
  const dropperSrc = path.join(config.jceAssetsRoot, config.jceDropper);
  const fullSrc = path.join(config.jceAssetsRoot, config.jcePkgFull);
  const patchSrc = path.join(config.jceAssetsRoot, config.jcePkgPatch);
  for (const [label, p] of [['dropper', dropperSrc], ['full package', fullSrc], ['patch package', patchSrc]]) {
    if (!fs.existsSync(p)) { const e = new Error(`JCE asset missing: ${label} (${p})`); e.status = 503; throw e; }
  }
  if (!baseUrl) { const e = new Error('base URL required'); e.status = 400; throw e; }
  if (/[\\/]/.test(website) || website.includes('..')) { const e = new Error('invalid website'); e.status = 400; throw e; }

  const rightRoot = path.resolve(config.rightRoot);
  const docroot = path.resolve(rightRoot, website);
  if (docroot !== rightRoot && !docroot.startsWith(rightRoot + path.sep)) { const e = new Error('website escapes right root'); e.status = 400; throw e; }
  const st = await fsp.stat(docroot).catch(() => null);
  if (!st || !st.isDirectory()) { const e = new Error('website docroot not found on right side: ' + docroot); e.status = 404; throw e; }

  const token = crypto.randomBytes(24).toString('hex');
  const expires = Math.floor(Date.now() / 1000) + config.patchExpirySec;
  const runId = 'r' + Date.now();
  const dropperName = 'jcefix-' + crypto.randomBytes(6).toString('hex') + '.php';
  const fullName = config.jcePkgFull;
  const patchName = config.jcePkgPatch;

  const tpl = await fsp.readFile(dropperSrc, 'utf8');
  const templated = tpl.split('__SCANNER_TOKEN__').join(token).split('__SCANNER_EXPIRES__').join(String(expires));

  const deployed = [];
  const detail = { website, base_url: baseUrl, dropper: dropperName, run_id: runId, target: config.jceTarget, phases: {} };
  const record = {
    timestamp: new Date().toISOString(), website, operator: operator || '', base_url: baseUrl,
    php_version: '', joomla_version: '', jce_before: '', jce_after: '', package: '', status: 'failed', note: '',
  };
  const finish = () => ({ record, detail });

  try {
    await fsp.writeFile(path.join(docroot, dropperName), templated);
    deployed.push(path.join(docroot, dropperName));
    await fsp.copyFile(fullSrc, path.join(docroot, fullName)); deployed.push(path.join(docroot, fullName));
    await fsp.copyFile(patchSrc, path.join(docroot, patchName)); deployed.push(path.join(docroot, patchName));

    const auth = { basicUser, basicPass };

    // 1. preflight
    const pf = await call(baseUrl, dropperName, { token, mode: 'preflight', run_id: runId }, { ...auth, timeout: 60000 });
    detail.phases.preflight = pf.json || { http_status: pf.status, body: pf.bodySnippet };
    if (!pf.json) throw new Error(`preflight: HTTP ${pf.status}, non-JSON (${(pf.bodySnippet || '').slice(0, 120)})`);
    if (pf.json.error) throw new Error('preflight rejected: ' + pf.json.error);
    const pfd = pf.json.preflight || {};
    record.php_version = String(pf.json.php_version || '');
    record.joomla_version = pfd.joomla_version || '';
    record.jce_before = (pfd.jce && pfd.jce.version) || '';
    const major = pfd.joomla_major || 0;
    if (major < 3) throw new Error('target does not look like Joomla (major < 3)');

    if (pfd.jce && pfd.jce.installed && pfd.jce.update_needed === false) {
      record.status = 'already'; record.jce_after = record.jce_before; record.package = '(none)';
      record.note = 'JCE already >= ' + config.jceTarget;
      return finish();
    }

    // 2. choose package: full upgrade on PHP >= 7.4, else the legacy file-patch
    const useFull = !phpLt(record.php_version || '0', '7.4');
    const pkg = useFull ? fullName : patchName;
    record.package = pkg;

    // 3. install
    const ins = await call(baseUrl, dropperName, { token, mode: 'install', pkg, run_id: runId }, { ...auth, timeout: 300000 });
    detail.phases.install = ins.json || { http_status: ins.status, body: ins.bodySnippet };
    if (!ins.json) throw new Error(`install: HTTP ${ins.status}, non-JSON (${(ins.bodySnippet || '').slice(0, 120)})`);
    if (ins.json.error) throw new Error('install rejected: ' + ins.json.error);

    // 4. verify
    const vf = await call(baseUrl, dropperName, { token, mode: 'verify', run_id: runId }, { ...auth, timeout: 60000 });
    detail.phases.verify = vf.json || { http_status: vf.status, body: vf.bodySnippet };
    const v = vf.json && vf.json.verify;
    record.jce_after = (v && v.jce_version) || (ins.json.install && ins.json.install.after) || '';
    const upToDate = !!(v && v.up_to_date);
    const vulnClosed = !!(v && v.vuln_closed);
    if (upToDate || (!useFull && vulnClosed)) {
      record.status = 'patched';
      record.note = useFull ? ('upgraded to ' + (record.jce_after || config.jceTarget)) : 'legacy security-patch applied (vuln closed)';
    } else {
      record.status = 'failed';
      record.note = 'verify did not confirm remediation: ' + JSON.stringify(v || (vf.json && vf.json.error) || vf.bodySnippet || 'no verify');
    }
    return finish();
  } catch (e) {
    record.status = 'failed';
    record.note = String(e.message || e);
    detail.error = record.note;
    return finish();
  } finally {
    for (const f of deployed) { try { await fsp.rm(f, { force: true }); } catch { /* best effort */ } }
    detail.cleaned = deployed;
  }
}

function assetStatus() {
  const chk = (f) => fs.existsSync(path.join(config.jceAssetsRoot, f));
  const dropper = chk(config.jceDropper);
  const full = chk(config.jcePkgFull);
  const patch = chk(config.jcePkgPatch);
  return { available: dropper && full && patch, dropper, full, patch, target: config.jceTarget,
    assetsRoot: config.jceAssetsRoot, pkgFull: config.jcePkgFull, pkgPatch: config.jcePkgPatch };
}

module.exports = { patchWebsite, assetStatus };
