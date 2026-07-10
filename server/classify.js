'use strict';
// Server-side harmfulness classifier. Scores each changed file 0..100 by how
// likely it is to be attacker-planted / injected — purely as ADVICE to the
// human reviewer. It never acts; it only reorders and flags.
//
// Two tiers, matching the app's data model (see diff.js):
//   * manifest tier  — path, extension, status, size/distance, known-good sha.
//                      No file read, so it's computed for every changed file.
//   * content tier   — adds body pattern-signatures + entropy. Needs one read;
//                      cached by content sha256 so byte-identical files (which
//                      the tool already clusters) are scanned once.
//
// Rules are DECLARATIVE, NAMED, and MIXABLE. A rule is a list of conditions
// ANDed together (`all: [...]`); mix structural conditions (path, extension,
// status, distance, known-good sha) with content patterns freely. A content
// pattern (`contains`) is a plain string or a regex and carries a position —
// `where: 'top' | 'mid' | 'any'` — so a backdoor prepended at the very top of a
// file is distinguishable from a payload injected mid-file. Weights may be
// NEGATIVE: negative rules are benign evidence and pull the score DOWN (e.g. a
// file byte-identical to pristine upstream). Rules can be edited live (CRUD)
// and persisted — see rules.js; setUserRules() hot-swaps them.
//
// Fired evidence combines multiplicatively: risk pushes up via noisy-OR
// (independent, saturating toward 100), benign pulls down, then hard floors
// (known-bad) and ceilings clamp. Every score ships a `reasons` list — the
// number only suggests; a reviewer needs to see WHY to trust or reject it.

const knowngood = require('./knowngood');
const { stripPrefix } = require('./paths');

// --- helpers --------------------------------------------------------------
const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
// Path relative to the site's document root: strip the CSV prefix, then drop
// the leading <website> segment. Rules author paths as docroot-relative
// (e.g. `uploads/shell.php`, not `example.com/uploads/shell.php`).
function docPathOf(absPath) {
  const segs = stripPrefix(absPath).split('/').filter(Boolean);
  return norm(segs.slice(1).join('/'));
}
const extOf = (name) => {
  const m = /\.([a-z0-9_]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
};
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const contentSha = (f) => (f.right && f.right.sha256) || (f.left && f.left.sha256) || '';
const TOP_CHARS = 512; // "very top" = first 512 bytes (line 1..~8)

// Server-executable extensions (PHP-family first — this is a Joomla/JCE tool).
const EXEC_EXT = new Set([
  'php', 'php3', 'php4', 'php5', 'php7', 'phtml', 'pht', 'phar', 'phps', 'inc',
  'cgi', 'pl', 'py', 'asp', 'aspx', 'jsp', 'jspx', 'sh',
]);
const MEDIA_EXT = ['jpg', 'jpeg', 'png', 'gif', 'ico', 'bmp', 'webp', 'svg', 'pdf', 'txt', 'css'];

const UPLOAD_RE = /(^|\/)(uploads?|images?|img|media|cache|tmp|temp|files?|assets|attachments|avatars|backups?|logs?|thumbs?|userfiles|wp-content\/uploads)(\/|$)/;
const DISGUISE_RE = /(\.(php\w?|phtml|pht|phar)\.(jpe?g|png|gif|ico|txt|zip|pdf|css|js|html?)$)|(\.(jpe?g|png|gif|ico|pdf|txt)\.(php\w?|phtml|pht|phar)$)|(\.(php\w?|phtml|pht|phar)[ .]+$)/i;
const BAD_STEM_RE = /^(shell|sh|cmd|c99|r57|wso|alfa|gel4y|b374k|indoxploit|priv8|0day|bypass|leaf|marijuana|adminer|backdoor|up|upload|xleet|moon|radio|mini|konfig|wp-conf\w+|wp-l0gin)\b/i;
const HASHNAME_RE = /^[a-f0-9]{16,}$/i;

// Reusable content-signature patterns (used as `contains` regex in rules).
const P = {
  execSink: /\b(eval|assert|system|exec|shell_exec|passthru|popen|proc_open|pcntl_exec)\s*\(/i,
  superToSink: /\b(eval|assert|system|exec|shell_exec|passthru|popen|proc_open|include|include_once|require|require_once|preg_replace|call_user_func|call_user_func_array)\b[^;{]{0,60}\$_(get|post|request|cookie|server)\b/i,
  decoder: /\b(base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|convert_uudecode|hex2bin)\s*\(/i,
  includeB64: /@?\s*(include|include_once|require|require_once)\s*\(\s*(base64_decode|gzinflate|str_rot13)\s*\(/i,
  pregE: /preg_replace\s*\(\s*(['"]).*?\/\w*e\w*\1/i,
  createFn: /\bcreate_function\s*\(/i,
  uploader: /\bmove_uploaded_file\s*\(|\bfile_put_contents\s*\([^)]*\$_(get|post|request)/i,
  varVar: /\$\{\s*['"]/,
  knownShell: /\b(c99shell|r57shell|filesman|b374k|wso\s*shell|gel4y|angel\s*shell|by\s+orb|indoxploit|\/\*\s*wso\s*\*\/)\b/i,
  phpOpen: /<\?php|<\?=/i,
  htEnablesPhp: /(addtype\s+application\/x-httpd-php)|(sethandler\s+application\/x-httpd-php)|(php_value\s+auto_prepend_file)|(addhandler\s+[^\n]*php)/i,
  jsCookie: /document\.cookie/i,
  jsSender: /\b(fetch|xmlhttprequest|navigator\.sendbeacon|new\s+image|\.src\s*=)/i,
  jsEvalDecode: /\b(eval|settimeout|setinterval|function)\s*\(\s*(atob|unescape|decodeuricomponent)\s*\(/i,
  foreignScript: /<script[^>]+src\s*=\s*['"]?https?:\/\//i,
  hiddenIframe: /<iframe[^>]*(display\s*:\s*none|visibility\s*:\s*hidden|width\s*=\s*['"]?\s*[01]\b|height\s*=\s*['"]?\s*[01]\b|src\s*=\s*['"]?https?:\/\/)/i,
};

// Shannon entropy (bits/byte). Packed/base64 shells run high (~5.5–6) vs
// ordinary source (~4–5). Cheap corroborating signal.
function entropyOf(s) {
  const n = s.length;
  if (!n) return 0;
  const freq = new Array(256).fill(0);
  for (let i = 0; i < n; i++) freq[s.charCodeAt(i) & 255]++;
  let h = 0;
  for (const c of freq) if (c) { const p = c / n; h -= p * Math.log2(p); }
  return h;
}
function longestToken(s) {
  let max = 0, cur = 0;
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i])) { if (cur > max) max = cur; cur = 0; } else cur++;
  }
  return Math.max(max, cur);
}

// --- built-in rule catalog ------------------------------------------------
// { id, name, kind, why, all:[conditions], weight|floor|ceil }.
// kind: 'risk' (weight 0..1 up, or NEGATIVE for benign/down) ·
//       'hardHit' (floor) · 'hardBenign' (ceiling).
// Conditions (mix freely): execExt · ext:[..] · pathRe · nameRe · stemRe ·
//   status · uploadDir · disguised · sizeGrew/sizeReplace/sizeSame ·
//   knownGoodSha · contains:'str'|/re/ (+ where) · entropyOver · tokenOver.
const BUILTIN_RULES = [
  // ---- path + extension (manifest) ----
  { id: 'exec-script', name: 'Executable script', kind: 'risk', weight: 0.18, why: 'server-executable script',
    all: [{ execExt: true }] },
  { id: 'script-in-upload-dir', name: 'Script in upload/cache dir', kind: 'risk', weight: 0.75, why: 'executable script in an upload/cache dir',
    all: [{ execExt: true }, { uploadDir: true }] },
  { id: 'added-script', name: 'New script (not in baseline)', kind: 'risk', weight: 0.4, why: 'net-new script',
    all: [{ execExt: true }, { status: 'added' }] },
  { id: 'disguised-ext', name: 'Disguised / double extension', kind: 'risk', weight: 0.7, why: 'disguised / double extension',
    all: [{ disguised: true }] },
  { id: 'suspicious-name', name: 'Suspicious filename', kind: 'risk', weight: 0.55, why: 'known-shell or cryptic filename',
    all: [{ execExt: true }, { stemRe: new RegExp(`${BAD_STEM_RE.source}|${HASHNAME_RE.source}`, 'i') }] },
  { id: 'htaccess', name: 'Server-config file', kind: 'risk', weight: 0.4, why: 'server-config file (can enable exec)',
    all: [{ nameRe: /^\.(htaccess|user\.ini)$/i }] },

  // ---- distance from original (manifest, size proxy) ----
  { id: 'injection-growth', name: 'Grew over baseline', kind: 'risk', weight: 0.28, why: 'grew over baseline (content appended)',
    all: [{ sizeGrew: true }] },
  { id: 'wholesale-replace', name: 'Wholesale size change', kind: 'risk', weight: 0.2, why: 'size changed wholesale vs baseline',
    all: [{ sizeReplace: true }] },
  { id: 'subtle-inplace', name: 'In-place tamper', kind: 'risk', weight: 0.15, why: 'in-place tamper (same size, new hash)',
    all: [{ sizeSame: true }] },

  // ---- pattern (content), position-agnostic ----
  { id: 'super-to-sink', name: 'Request input → exec/eval', kind: 'risk', weight: 0.8, why: 'request input flows into exec/eval/include',
    all: [{ contains: P.superToSink }] },
  { id: 'include-backdoor', name: 'include() of decoded payload', kind: 'risk', weight: 0.8, why: 'include/require of decoded payload',
    all: [{ contains: P.includeB64 }] },
  { id: 'exec-sink', name: 'Code-execution sink', kind: 'risk', weight: 0.5, why: 'code-execution sink present',
    all: [{ contains: P.execSink }] },
  { id: 'preg-replace-e', name: 'preg_replace /e', kind: 'risk', weight: 0.7, why: 'preg_replace /e (deprecated code-exec)',
    all: [{ contains: P.pregE }] },
  { id: 'create-function', name: 'create_function()', kind: 'risk', weight: 0.5, why: 'create_function (dynamic code)',
    all: [{ contains: P.createFn }] },
  { id: 'decoder', name: 'Obfuscation decoder', kind: 'risk', weight: 0.45, why: 'obfuscation decoder (base64/gzinflate/…)',
    all: [{ contains: P.decoder }] },
  { id: 'uploader', name: 'Upload / write primitive', kind: 'risk', weight: 0.5, why: 'file-upload / write primitive',
    all: [{ contains: P.uploader }] },
  { id: 'var-var', name: 'Variable-variable', kind: 'risk', weight: 0.3, why: 'variable-variable indirection',
    all: [{ contains: P.varVar }] },
  { id: 'high-entropy-blob', name: 'High-entropy blob', kind: 'risk', weight: 0.4, why: 'high-entropy packed blob',
    all: [{ entropyOver: 5.6 }, { tokenOver: 500 }] },

  // ---- position-aware (the `where` spec) ----
  { id: 'prepended-backdoor', name: 'Backdoor at top of file', kind: 'risk', weight: 0.6, why: 'exec sink at the very top of the file',
    all: [{ execExt: true }, { contains: P.execSink, where: 'top' }] },
  { id: 'deep-injection', name: 'Injection mid-file', kind: 'risk', weight: 0.35, why: 'exec sink buried mid-file',
    all: [{ execExt: true }, { contains: P.execSink, where: 'mid' }] },

  // ---- JS-side injection (content) ----
  { id: 'js-cookie-exfil', name: 'Cookie exfiltration', kind: 'risk', weight: 0.8, why: 'reads document.cookie + network sender',
    all: [{ contains: P.jsCookie }, { contains: P.jsSender }] },
  { id: 'js-eval-decode', name: 'eval(atob(…))', kind: 'risk', weight: 0.6, why: 'eval(atob/unescape(…)) obfuscation',
    all: [{ contains: P.jsEvalDecode }] },
  { id: 'foreign-script', name: 'Injected external script', kind: 'risk', weight: 0.35, why: 'injected external <script src>',
    all: [{ contains: P.foreignScript }] },
  { id: 'hidden-iframe', name: 'Hidden iframe', kind: 'risk', weight: 0.4, why: 'hidden / off-page <iframe>',
    all: [{ contains: P.hiddenIframe }] },

  // ---- path + extension + pattern (mixes → hard floors) ----
  { id: 'shell-in-upload', name: 'Shell in upload dir', kind: 'hardHit', floor: 92, why: 'code-exec sink in an upload/cache dir',
    all: [{ execExt: true }, { uploadDir: true }, { contains: P.execSink }] },
  { id: 'polyglot', name: 'Polyglot (php as media)', kind: 'hardHit', floor: 90, why: 'non-script file carrying PHP (<?php)',
    all: [{ execExt: false }, { ext: MEDIA_EXT }, { contains: P.phpOpen, where: 'top' }] },
  { id: 'known-shell', name: 'Known webshell fingerprint', kind: 'hardHit', floor: 95, why: 'known webshell fingerprint',
    all: [{ contains: P.knownShell }] },
  { id: 'htaccess-enables-php', name: '.htaccess enables PHP', kind: 'hardHit', floor: 80, why: '.htaccess enables PHP execution',
    all: [{ nameRe: /^\.(htaccess|user\.ini)$/i }, { contains: P.htEnablesPhp }] },

  // ---- benign / known-good (NEGATIVE weight pulls the score down) ----
  { id: 'known-good-sha', name: 'Matches pristine source', kind: 'risk', weight: -0.97, why: 'sha256 matches a pristine Joomla/JCE source file',
    all: [{ knownGoodSha: true }] },
];

const CONTENT_KEYS = new Set(['contains', 'entropyOver', 'tokenOver']);
const isContentRule = (rule) => rule.all.some((el) => Object.keys(el).some((k) => CONTENT_KEYS.has(k)));

// --- (de)serialization for persistence + the CRUD API ---------------------
// Regexes travel as { regex, flags }; Sets/arrays as arrays. Round-trips so the
// client can display/edit built-ins and user rules through one schema.
const REGEX_KEYS = new Set(['contains', 'pathRe', 'nameRe', 'stemRe']);
function serCond(el) {
  const out = {};
  for (const [k, v] of Object.entries(el)) {
    if (v instanceof RegExp) out[k] = { regex: v.source, flags: v.flags };
    else out[k] = v;
  }
  return out;
}
function deserCond(el) {
  const out = {};
  for (const [k, v] of Object.entries(el)) {
    if (REGEX_KEYS.has(k) && v && typeof v === 'object' && v.regex) out[k] = new RegExp(v.regex, v.flags || 'i');
    else out[k] = v;
  }
  return out;
}
function serializeRule(rule) {
  const { id, name, kind, weight, floor, ceil, why, disabled, source } = rule;
  return { id, name, kind, weight, floor, ceil, why, disabled: !!disabled, source, all: rule.all.map(serCond) };
}
function compileRule(rule, source) {
  const all = (rule.all || []).map(deserCond);
  const out = { ...rule, source, all };
  out._content = isContentRule(out);
  return out;
}

// --- effective rule set (built-ins ⊕ user rules), hot-swappable -----------
const BUILTIN_COMPILED = BUILTIN_RULES.map((r) => compileRule(r, 'builtin'));
let userRules = [];      // raw persisted user rules (serialized form)
let RULES = BUILTIN_COMPILED.slice();
const contentCache = new Map(); // sha256 -> content-tier result (cleared on rule change)

const hasConds = (r) => Array.isArray(r.all) && r.all.length > 0;
function recompile() {
  const builtinIds = new Set(BUILTIN_COMPILED.map((b) => b.id));
  const overrides = new Map(); // built-in id -> user rule targeting it
  const extras = [];           // brand-new user rules
  for (const u of userRules) (builtinIds.has(u.id) ? overrides.set(u.id, u) : extras.push(u));

  const eff = [];
  for (const b of BUILTIN_COMPILED) {
    const u = overrides.get(b.id);
    if (u && u.disabled) continue;                              // built-in switched off
    if (u && hasConds(u)) eff.push(compileRule(u, 'builtin-override')); // real override
    else eff.push(b);                                           // keep default (bare enable stub is a no-op)
  }
  for (const u of extras) if (!u.disabled && hasConds(u)) eff.push(compileRule(u, 'user'));

  RULES = eff.filter((r) => r.all.length); // a rule with no conditions never fires
  contentCache.clear();                    // scores change → drop cached content results
}
// Replace the user rule set live (called by rules.js after a CRUD op).
function setUserRules(rules) { userRules = Array.isArray(rules) ? rules : []; recompile(); }

// Effective rules for the CRUD UI: every built-in (flagged if a user override
// disabled/replaced it) plus user-only rules.
function listRules() {
  const byId = new Map(userRules.map((r) => [r.id, r]));
  const builtins = BUILTIN_COMPILED.map((b) => {
    const u = byId.get(b.id);
    return { ...serializeRule(b), source: 'builtin', disabled: !!(u && u.disabled), overridden: !!(u && !u.disabled) };
  });
  const builtinIds = new Set(BUILTIN_COMPILED.map((b) => b.id));
  const user = userRules.filter((u) => !builtinIds.has(u.id)).map((u) => ({ ...u, source: 'user', all: u.all || [] }));
  return { builtins, user, overrides: userRules.filter((u) => builtinIds.has(u.id)) };
}

const BANDS = [[80, 'critical'], [50, 'high'], [20, 'elevated'], [0, 'low']];
const bandOf = (s) => (BANDS.find(([t]) => s >= t) || [0, 'low'])[1];

// --- evaluation -----------------------------------------------------------
function matchPattern(c, pat, where) {
  const hay = where === 'top' ? c.top : where === 'mid' ? c.mid : c.all;
  if (hay == null) return false;
  return pat instanceof RegExp ? pat.test(hay) : hay.toLowerCase().includes(String(pat).toLowerCase());
}
function condMatch(c, key, val, el) {
  switch (key) {
    case 'where': return true; // modifier of `contains`
    case 'execExt': return c.isExec === val;
    case 'ext': return (val.includes ? val.includes(c.ext) : !!val[c.ext]);
    case 'pathRe': return val.test(c.path);
    case 'nameRe': return val.test(c.name);
    case 'stemRe': return val.test(c.stem);
    case 'status': return c.status === val;
    case 'uploadDir': return UPLOAD_RE.test(c.path) === val;
    case 'disguised': return DISGUISE_RE.test(c.name) === val;
    case 'knownGoodSha': return (!!c.sha && knowngood.has(c.sha)) === val;
    case 'sizeGrew': return (c.status === 'modified' && c.leftSize != null && c.rightSize != null
      && c.rightSize > c.leftSize && (c.rightSize - c.leftSize) <= c.leftSize) === val;
    case 'sizeReplace': return (c.status === 'modified' && c.leftSize != null && c.rightSize != null
      && (c.rightSize > 4 * c.leftSize || c.rightSize < 0.3 * c.leftSize)) === val;
    case 'sizeSame': return (c.status === 'modified' && c.leftSize != null && c.rightSize != null
      && Math.abs(c.rightSize - c.leftSize) <= 2) === val;
    case 'contains': return matchPattern(c, val, el.where || 'any');
    case 'entropyOver': return c.entropy > val;
    case 'tokenOver': return c.longestToken > val;
    default: return false;
  }
}
const elemMatch = (c, el) => Object.entries(el).every(([k, v]) => condMatch(c, k, v, el));

function combine(fired) {
  let up = 1, down = 1, floor = 0, ceil = 100;
  const reasons = [];
  for (const r of fired) {
    if (r.kind === 'hardHit') { floor = Math.max(floor, r.floor); reasons.push({ id: r.id, name: r.name, weight: 1, why: r.why }); }
    else if (r.kind === 'hardBenign') { ceil = Math.min(ceil, r.ceil); reasons.push({ id: r.id, name: r.name, weight: -1, why: r.why }); }
    else {
      const w = Number(r.weight) || 0;
      if (w >= 0) up *= (1 - w); else down *= (1 - Math.min(0.99, -w));
      reasons.push({ id: r.id, name: r.name, weight: +w.toFixed(2), why: r.why });
    }
  }
  const riskUp = 1 - up, benignDown = 1 - down;
  let score = 100 * riskUp * (1 - benignDown); // benign evidence scales risk down
  score = Math.min(ceil, score);
  score = Math.max(floor, score);              // known-bad floor wins ties
  score = Math.max(0, Math.min(100, Math.round(score)));
  reasons.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return { score, band: bandOf(score), reasons: reasons.slice(0, 6) };
}

function buildCtx(file, body) {
  const path = docPathOf(file.absolute_path); // relative to the document root
  const name = (file.filename || path.split('/').pop() || '');
  const ext = extOf(name);
  const c = {
    path, name, ext, stem: name.replace(/\.[^.]*$/, ''),
    status: file.status,
    isExec: EXEC_EXT.has(ext),
    sha: contentSha(file),
    leftSize: file.left ? num(file.left.size_bytes) : null,
    rightSize: file.right ? num(file.right.size_bytes) : null,
    top: null, mid: null, all: null,
  };
  if (body != null) {
    const sample = body.length > 300000 ? body.slice(0, 300000) : body;
    c.all = sample;
    c.top = body.slice(0, TOP_CHARS);
    c.mid = body.length > TOP_CHARS ? sample.slice(TOP_CHARS) : '';
    c.entropy = entropyOf(sample);
    c.longestToken = longestToken(sample);
  }
  return c;
}

function run(file, body, withContent) {
  const c = buildCtx(file, body);
  const fired = [];
  for (const rule of RULES) {
    if (rule._content && (!withContent || c.all == null)) continue;
    if (rule.all.every((el) => elemMatch(c, el))) fired.push(rule);
  }
  return combine(fired);
}

// --- public API + content cache -------------------------------------------
function scoreManifest(file) {
  return { ...run(file, null, false), tier: 'manifest' };
}
// Score with the PRIMARY side's body (right for added/modified, left for
// deleted — caller guarantees this). Cached by content sha.
function scoreContent(file, body) {
  const sha = contentSha(file);
  const res = { ...run(file, body, true), tier: 'content' };
  if (sha) contentCache.set(sha, res);
  return res;
}
// Best score known: cached content-tier if we've read it, else a fresh
// manifest-tier score (fresh so it reflects live rule/known-good changes).
function effectiveRisk(file) {
  return contentCache.get(contentSha(file)) || scoreManifest(file);
}

module.exports = {
  scoreManifest, scoreContent, effectiveRisk, bandOf, contentSha,
  setUserRules, listRules,
};
