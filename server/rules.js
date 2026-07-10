'use strict';
// Persisted, live-editable classifier rules. User rules are stored as JSON at
// <evidence>/classify.rules.json (override with CLASSIFY_RULES) and layered over
// the built-in catalog by classify.js. Every CRUD op persists to disk and
// hot-swaps the live rule set (classify.setUserRules) — no restart needed.
//
// A user rule may:
//   * add a brand-new rule (unique id),
//   * override a built-in (same id — user wins),
//   * disable a built-in (same id + "disabled": true).
// Schema mirrors classify.js: { id, name, kind, weight|floor|ceil, why, all:[…] }
// where `all` conditions carry regexes as { regex, flags } and strings verbatim.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const classify = require('./classify');

const FILE = process.env.CLASSIFY_RULES || path.join(config.evidenceRoot, 'classify.rules.json');
let userRules = [];

const KINDS = new Set(['risk', 'hardHit', 'hardBenign']);
const slug = (s) => String(s || 'rule').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'rule';

// Coerce an incoming rule into a safe, persistable shape.
function sanitize(r) {
  if (!r || typeof r !== 'object') throw httpErr(400, 'rule must be an object');
  const kind = KINDS.has(r.kind) ? r.kind : 'risk';
  const out = {
    id: (r.id && String(r.id).trim()) || `${slug(r.name)}-${crypto.randomUUID().slice(0, 8)}`,
    name: String(r.name || r.id || 'Unnamed rule').slice(0, 120),
    kind,
    why: String(r.why || r.name || '').slice(0, 200),
    all: Array.isArray(r.all) ? r.all : [],
    disabled: !!r.disabled,
  };
  if (kind === 'risk') out.weight = clampNum(r.weight, -1, 1, 0.3);        // negative = benign
  else if (kind === 'hardHit') out.floor = clampNum(r.floor, 0, 100, 90);
  else if (kind === 'hardBenign') out.ceil = clampNum(r.ceil, 0, 100, 5);
  return out;
}
function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      userRules = Array.isArray(arr) ? arr : [];
    }
  } catch (e) { console.error(`[rules] load failed (${FILE}): ${e.message}`); userRules = []; }
  classify.setUserRules(userRules);
  console.log(`[rules] ${userRules.length} user rule(s) from ${FILE}`);
  return userRules;
}

async function persist() {
  await fsp.mkdir(path.dirname(FILE), { recursive: true });
  await fsp.writeFile(FILE, JSON.stringify(userRules, null, 2));
  classify.setUserRules(userRules); // live hot-swap + cache clear
}

// Effective rule set (built-ins ⊕ user) for the editor, plus the raw user list.
const list = () => ({ ...classify.listRules(), file: FILE });

// Create or update a user rule (by id). Returns the sanitized rule.
async function upsert(rule) {
  const r = sanitize(rule);
  const i = userRules.findIndex((x) => x.id === r.id);
  if (i >= 0) userRules[i] = r; else userRules.push(r);
  await persist();
  return r;
}

// Disable/enable a rule without deleting it. Disabling a built-in persists a
// stub override; re-enabling one drops the stub again so the file stays clean.
async function setDisabled(id, disabled) {
  if (!id) throw httpErr(400, 'id required');
  disabled = disabled !== false;
  const i = userRules.findIndex((x) => x.id === id);
  if (i >= 0) {
    const entry = userRules[i];
    const isStub = !Array.isArray(entry.all) || entry.all.length === 0; // carries only on/off
    if (!disabled && isStub) userRules.splice(i, 1);      // re-enabling a built-in → drop the stub
    else userRules[i] = { ...entry, disabled };
  } else if (disabled) {
    userRules.push({ id, disabled: true });               // stub override to switch a built-in off
  }
  await persist();
}

// Delete a user rule (built-ins can't be deleted — disable them instead).
async function remove(id) {
  const before = userRules.length;
  userRules = userRules.filter((x) => x.id !== id);
  if (userRules.length === before) throw httpErr(404, 'no user rule with that id (built-ins can only be disabled)');
  await persist();
}

module.exports = { load, list, upsert, remove, setDisabled, FILE };
