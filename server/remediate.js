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
// the target's access log. Sends a real User-Agent (Node sends none, which many
// WAFs answer 503/403). HTTPS certs are NOT verified (policy: messy fleet).
// Resolves with the full exchange (req+resp headers/body) for diagnostics.
function httpJson(url, { headers = {}, body = null, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const h = {
      'User-Agent': config.patchUserAgent,
      Accept: 'application/json, text/plain, */*',
      ...headers,
    };
    const opts = { method: 'POST', headers: h, timeout: timeoutMs };
    if (url.protocol === 'https:') opts.rejectUnauthorized = false;
    if (body != null) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const shownUrl = url.origin + url.pathname;
    const req = lib.request(url, opts, (res) => {
      let data = ''; let size = 0; const CAP = 16 * 1024 * 1024;
      res.on('data', (c) => { size += c.length; if (size <= CAP) data += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch { /* non-JSON */ }
        resolve({
          status: res.statusCode, statusMessage: res.statusMessage, json,
          respBody: data, bodySnippet: json ? null : data.slice(0, 500),
          respHeaders: res.headers, reqHeaders: req.getHeaders(),
          reqBody: body, method: opts.method, url: shownUrl,
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out after ' + timeoutMs + 'ms')));
    req.on('error', (e) => { e.reqHeaders = req.getHeaders(); e.url = shownUrl; e.method = opts.method; e.reqBody = body; reject(e); });
    if (body != null) req.write(body);
    req.end();
  });
}

// Compact per-phase record for the detail JSON / dialog.
function phaseDetail(x) {
  return {
    url: x.url, http_status: x.status, status_message: x.statusMessage,
    json: x.json || undefined,
    body: x.json ? undefined : String(x.respBody || '').slice(0, 4000),
    req_headers: x.reqHeaders, resp_headers: x.respHeaders,
  };
}

// Full request+response dump to the container log (token redacted).
function dumpExchange(website, phase, x, token) {
  const redact = (s) => (token ? String(s || '').split(token).join('***') : String(s || ''));
  logErr(`${website}: ${phase} ── full exchange ──`);
  logErr(`${website}: ${phase} > ${x.method} ${x.url}`);
  logErr(`${website}: ${phase} > req headers: ${JSON.stringify(x.reqHeaders || {})}`);
  logErr(`${website}: ${phase} > req body: ${redact(x.reqBody).slice(0, 1000)}`);
  logErr(`${website}: ${phase} < HTTP ${x.status} ${x.statusMessage || ''}`);
  logErr(`${website}: ${phase} < resp headers: ${JSON.stringify(x.respHeaders || {})}`);
  logErr(`${website}: ${phase} < resp body: ${redact(x.respBody).slice(0, 4000)}`);
}

const log = (...a) => console.log('[patch]', ...a);
const logErr = (...a) => console.error('[patch]', ...a);

// Human explanation for a non-JSON HTTP response from the dropper URL.
function hintForStatus(status, snippet) {
  const s = String(snippet || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (status === 401) return 'HTTP 401 — Basic Auth required, or wrong username/password.';
  if (status === 403) return 'HTTP 403 — blocked by the server/WAF/mod_security before the dropper ran.';
  if (status === 404) return 'HTTP 404 — dropper not found at that URL. The Base URL must point at the site DOCUMENT ROOT (where index.php lives), not a parent/subfolder.';
  if (status === 500) return 'HTTP 500 — the dropper hit a PHP fatal. Check the site PHP error log.';
  if (status === 502 || status === 504) return `HTTP ${status} — upstream/proxy error; the PHP backend is down or too slow.`;
  if (status === 503) return 'HTTP 503 — site unavailable: usually Joomla is in OFFLINE/maintenance mode (it serves 503 to everyone), or a proxy/backend is down. The dropper never executed — bring the site online (or fix the proxy) and retry.';
  if (status === 200) return `HTTP 200 but not JSON — reached a page that is not the dropper. PHP may not be executing (.php served as text), or a WAF/login/HTML page came back. Body: "${s}"`;
  return `HTTP ${status}, non-JSON. Body: "${s}"`;
}
function hintForError(e) {
  const m = String((e && e.code) || (e && e.message) || e);
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'DNS — the host could not be resolved from inside the container (check the Base URL host / the container can reach it).';
  if (/ECONNREFUSED/i.test(m)) return 'Connection refused — wrong host/port, or the site is down.';
  if (/ETIMEDOUT|timed out/i.test(m)) return 'Timed out — host slow/unreachable, or the container has no network route to it.';
  if (/ECONNRESET/i.test(m)) return 'Connection reset — a proxy/WAF dropped the connection.';
  return null;
}
// Return the dropper's parsed JSON, or throw a diagnostic Error carrying `.hint`.
function expectJson(resp, phase) {
  if (resp.json) {
    if (resp.json.error) {
      const e = new Error(`${phase}: dropper refused: ${resp.json.error}`);
      e.hint = `The dropper executed but returned "${resp.json.error}". "forbidden" = token mismatch; "not templated"/"expired" = token/expiry issue; otherwise see the dropper output in details.`;
      throw e;
    }
    return resp.json;
  }
  const e = new Error(`${phase}: HTTP ${resp.status}, non-JSON`);
  e.hint = hintForStatus(resp.status, resp.bodySnippet);
  throw e;
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

  const baseSlash = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const su = new URL(dropperName, baseSlash);
  detail.dropper_url = su.origin + su.pathname;
  log(`${website}: START base=${baseUrl} docroot=${docroot} operator=${operator || '(none)'} url=${detail.dropper_url}`);

  try {
    await fsp.writeFile(path.join(docroot, dropperName), templated);
    deployed.push(path.join(docroot, dropperName));
    await fsp.copyFile(fullSrc, path.join(docroot, fullName)); deployed.push(path.join(docroot, fullName));
    await fsp.copyFile(patchSrc, path.join(docroot, patchName)); deployed.push(path.join(docroot, patchName));
    log(`${website}: deployed dropper + ${fullName} + ${patchName}`);

    const auth = { basicUser, basicPass };

    // 1. preflight
    log(`${website}: preflight POST ${detail.dropper_url}`);
    const pf = await call(baseUrl, dropperName, { token, mode: 'preflight', run_id: runId }, { ...auth, timeout: 60000 });
    detail.phases.preflight = phaseDetail(pf);
    log(`${website}: preflight <- HTTP ${pf.status} ${pf.json ? 'JSON' : 'NON-JSON'}`);
    if (!pf.json || pf.json.error) dumpExchange(website, 'preflight', pf, token);
    const pj = expectJson(pf, 'preflight');
    const pfd = pj.preflight || {};
    record.php_version = String(pj.php_version || '');
    record.joomla_version = pfd.joomla_version || '';
    record.jce_before = (pfd.jce && pfd.jce.version) || '';
    const major = pfd.joomla_major || 0;
    log(`${website}: php=${record.php_version || '?'} joomla=${record.joomla_version || '?'}(major ${major}) jce_before=${record.jce_before || '(none)'} update_needed=${pfd.jce ? pfd.jce.update_needed : '?'}`);
    if (major < 3) {
      const e = new Error('target does not look like Joomla (major < 3)');
      e.hint = 'No Joomla detected at this docroot (administrator/manifests/files/joomla.xml missing). Check the Base URL points at the Joomla site root.';
      throw e;
    }

    if (pfd.jce && pfd.jce.installed && pfd.jce.update_needed === false) {
      record.status = 'already'; record.jce_after = record.jce_before; record.package = '(none)';
      record.note = 'JCE already >= ' + config.jceTarget;
      log(`${website}: ALREADY up-to-date (${record.jce_before})`);
      return finish();
    }

    // 2. choose package: full upgrade on PHP >= 7.4, else the legacy file-patch
    const useFull = !phpLt(record.php_version || '0', '7.4');
    const pkg = useFull ? fullName : patchName;
    record.package = pkg;
    log(`${website}: chose ${pkg} (${useFull ? 'full upgrade, PHP>=7.4' : 'legacy file-patch, PHP<7.4'})`);

    // 3. install
    log(`${website}: install POST pkg=${pkg} (up to 300s)`);
    const ins = await call(baseUrl, dropperName, { token, mode: 'install', pkg, run_id: runId }, { ...auth, timeout: 300000 });
    detail.phases.install = phaseDetail(ins);
    log(`${website}: install <- HTTP ${ins.status} ${ins.json ? 'JSON' : 'NON-JSON'}`);
    if (!ins.json || ins.json.error) dumpExchange(website, 'install', ins, token);
    const ij = expectJson(ins, 'install');
    const insInfo = ij.install || {};
    if (Array.isArray(insInfo.messages) && insInfo.messages.length) log(`${website}: install messages: ${insInfo.messages.join(' | ')}`);
    if (Array.isArray(insInfo.errors) && insInfo.errors.length) logErr(`${website}: install errors: ${insInfo.errors.join(' | ')}`);

    // 4. verify
    log(`${website}: verify POST`);
    const vf = await call(baseUrl, dropperName, { token, mode: 'verify', run_id: runId }, { ...auth, timeout: 60000 });
    detail.phases.verify = phaseDetail(vf);
    log(`${website}: verify <- HTTP ${vf.status} ${vf.json ? 'JSON' : 'NON-JSON'}`);
    if (!vf.json) dumpExchange(website, 'verify', vf, token);
    const v = vf.json && vf.json.verify;
    record.jce_after = (v && v.jce_version) || insInfo.after || '';
    const upToDate = !!(v && v.up_to_date);
    const vulnClosed = !!(v && v.vuln_closed);
    if (upToDate || (!useFull && vulnClosed)) {
      record.status = 'patched';
      record.note = useFull ? ('upgraded to ' + (record.jce_after || config.jceTarget)) : 'legacy security-patch applied (vuln closed)';
    } else {
      record.status = 'failed';
      record.note = 'verify did not confirm remediation (jce_after=' + (record.jce_after || '?') + ')';
      detail.hint = 'Install ran but the site is still not up-to-date. Check the install messages/errors above and the install phase in details.';
      if (detail.hint) record.note += ' — ' + detail.hint;
    }
    log(`${website}: DONE status=${record.status} jce ${record.jce_before || '?'} -> ${record.jce_after || '?'}`);
    return finish();
  } catch (e) {
    record.status = 'failed';
    record.note = String(e.message || e);
    detail.hint = e.hint || hintForError(e) || detail.hint || null;
    if (detail.hint) record.note += ' — ' + detail.hint;
    detail.error = record.note;
    logErr(`${website}: FAILED — ${record.note}`);
    if (e && e.reqHeaders) logErr(`${website}: errored request ${e.method || 'POST'} ${e.url || ''} req headers: ${JSON.stringify(e.reqHeaders)}`);
    if (e && e.stack && !e.hint) logErr(e.stack);
    return finish();
  } finally {
    for (const f of deployed) { try { await fsp.rm(f, { force: true }); } catch { /* best effort */ } }
    detail.cleaned = deployed;
    log(`${website}: cleaned ${deployed.length} deployed file(s)`);
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
