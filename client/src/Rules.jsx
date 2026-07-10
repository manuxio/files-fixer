import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

// ---- condition schema (drives the guided builder) ------------------------
const COND_KEYS = [
  { k: 'execExt', label: 'is executable script', type: 'bool' },
  { k: 'uploadDir', label: 'in upload/cache dir', type: 'bool' },
  { k: 'disguised', label: 'disguised extension', type: 'bool' },
  { k: 'knownGoodSha', label: 'matches pristine sha', type: 'bool' },
  { k: 'sizeGrew', label: 'grew over baseline', type: 'bool' },
  { k: 'sizeReplace', label: 'wholesale size change', type: 'bool' },
  { k: 'sizeSame', label: 'in-place tamper (same size)', type: 'bool' },
  { k: 'status', label: 'status is', type: 'status' },
  { k: 'ext', label: 'extension in', type: 'list' },
  { k: 'pathRe', label: 'path matches regex', type: 'regex' },
  { k: 'nameRe', label: 'filename matches regex', type: 'regex' },
  { k: 'stemRe', label: 'name (no ext) matches regex', type: 'regex' },
  { k: 'contains', label: 'body contains', type: 'contains' },
  { k: 'entropyOver', label: 'entropy over', type: 'num' },
  { k: 'tokenOver', label: 'longest token over', type: 'num' },
];
const typeOf = (k) => (COND_KEYS.find((c) => c.k === k) || { type: 'bool' }).type;
const BOOL_KEYS = COND_KEYS.filter((c) => c.type === 'bool').map((c) => c.k);

// UI condition <-> API condition object ------------------------------------
function apiToConds(all) {
  const out = [];
  for (const el of all || []) {
    const where = el.where;
    for (const [k, v] of Object.entries(el)) {
      if (k === 'where') continue;
      const c = { key: k, bool: true, text: '', flags: 'i', isRegex: false, where: 'any', value: 'added' };
      if (BOOL_KEYS.includes(k)) c.bool = v !== false;
      else if (k === 'ext') c.text = Array.isArray(v) ? v.join(', ') : String(v);
      else if (k === 'status') c.value = v;
      else if (['pathRe', 'nameRe', 'stemRe'].includes(k)) { c.text = v && v.regex ? v.regex : String(v); c.flags = (v && v.flags) || 'i'; c.isRegex = true; }
      else if (k === 'contains') { if (v && v.regex) { c.text = v.regex; c.flags = v.flags || 'i'; c.isRegex = true; } else { c.text = String(v); } c.where = where || 'any'; }
      else if (['entropyOver', 'tokenOver'].includes(k)) c.text = String(v);
      out.push(c);
    }
  }
  return out.length ? out : [{ key: 'execExt', bool: true, text: '', flags: 'i', isRegex: false, where: 'any', value: 'added' }];
}
function condToApi(c) {
  const t = typeOf(c.key);
  if (t === 'bool') return { [c.key]: c.bool !== false };
  if (t === 'status') return { status: c.value || 'added' };
  if (t === 'list') return { ext: String(c.text || '').split(',').map((s) => s.trim().replace(/^\./, '')).filter(Boolean) };
  if (t === 'regex') return { [c.key]: { regex: c.text || '', flags: c.flags || 'i' } };
  if (t === 'num') return { [c.key]: Number(c.text) || 0 };
  // contains
  const el = c.isRegex ? { contains: { regex: c.text || '', flags: c.flags || 'i' } } : { contains: c.text || '' };
  if (c.where && c.where !== 'any') el.where = c.where;
  return el;
}

// ---- condition row -------------------------------------------------------
function CondRow({ c, canRemove, onChange, onRemove }) {
  const t = typeOf(c.key);
  const set = (patch) => onChange({ ...c, ...patch });
  return (
    <div className="cond-row">
      <select value={c.key} onChange={(e) => set({ key: e.target.value })}>
        {COND_KEYS.map((k) => <option key={k.k} value={k.k}>{k.label}</option>)}
      </select>
      {t === 'bool' && (
        <select value={c.bool !== false ? 'true' : 'false'} onChange={(e) => set({ bool: e.target.value === 'true' })}>
          <option value="true">= true</option>
          <option value="false">= false</option>
        </select>
      )}
      {t === 'status' && (
        <select value={c.value || 'added'} onChange={(e) => set({ value: e.target.value })}>
          <option value="added">added</option><option value="modified">modified</option><option value="deleted">deleted</option>
        </select>
      )}
      {t === 'list' && <input className="grow" placeholder="php, phtml, phar" value={c.text} onChange={(e) => set({ text: e.target.value })} spellCheck={false} />}
      {t === 'num' && <input type="number" step="0.1" placeholder="e.g. 5.6" value={c.text} onChange={(e) => set({ text: e.target.value })} />}
      {t === 'regex' && (
        <>
          <input className="grow mono" placeholder="regex, e.g. ^uploads/" value={c.text} onChange={(e) => set({ text: e.target.value })} spellCheck={false} />
          <input className="flags" title="flags" value={c.flags} onChange={(e) => set({ flags: e.target.value })} />
        </>
      )}
      {t === 'contains' && (
        <>
          <input className="grow mono" placeholder={c.isRegex ? 'regex' : 'text to find'} value={c.text} onChange={(e) => set({ text: e.target.value })} spellCheck={false} />
          <label className="inline-check" title="treat as a regex"><input type="checkbox" checked={!!c.isRegex} onChange={(e) => set({ isRegex: e.target.checked })} /> re</label>
          <select value={c.where || 'any'} onChange={(e) => set({ where: e.target.value })} title="position">
            <option value="any">anywhere</option><option value="top">top</option><option value="mid">mid</option>
          </select>
        </>
      )}
      <button className="btn ghost tiny" onClick={onRemove} disabled={!canRemove} title="remove condition">✕</button>
    </div>
  );
}

// ---- rule editor (create / edit) -----------------------------------------
// One-line rule-of-thumb for the chosen kind (risk flips on the weight sign).
function kindHint(kind, weight) {
  if (kind === 'hardHit') return { k: 'hardHit', t: '“this IS harmful — always flag it.” Forces the score to at least the floor; overrides everything, even benign rules.' };
  if (kind === 'hardBenign') return { k: 'hardBenign', t: '“this IS legit — stop suspecting it.” Caps the score at the ceiling (a hard allow-list).' };
  if (Number(weight) < 0) return { k: 'negative risk', t: '“this looks legit — lower my suspicion.” A soft discount, weighed against the harmful signals.' };
  return { k: 'positive risk', t: '“this looks suspicious — raise my suspicion.” A soft signal, combined with the others.' };
}

function RuleEditor({ rule, canEdit, busy, onSave, onCancel }) {
  const isBuiltin = rule && rule.source === 'builtin';
  const [name, setName] = useState(rule?.name || '');
  const [kind, setKind] = useState(rule?.kind || 'risk');
  const [why, setWhy] = useState(rule?.why || '');
  const [weight, setWeight] = useState(rule?.weight ?? 0.5);
  const [floor, setFloor] = useState(rule?.floor ?? 90);
  const [ceil, setCeil] = useState(rule?.ceil ?? 5);
  const [conds, setConds] = useState(apiToConds(rule?.all));
  const [err, setErr] = useState('');

  const setCond = (i, c) => setConds((cs) => cs.map((x, j) => (j === i ? c : x)));
  const addCond = () => setConds((cs) => [...cs, { key: 'contains', bool: true, text: '', flags: 'i', isRegex: false, where: 'any', value: 'added' }]);
  const removeCond = (i) => setConds((cs) => cs.filter((_, j) => j !== i));

  const save = () => {
    if (!name.trim()) { setErr('name is required'); return; }
    const all = conds.map(condToApi).filter((el) => {
      const k = Object.keys(el).find((x) => x !== 'where');
      const v = el[k];
      if (['pathRe', 'nameRe', 'stemRe'].includes(k)) return v && v.regex;      // need a pattern
      if (k === 'contains') return (v && v.regex) || (typeof v === 'string' && v);
      if (k === 'ext') return Array.isArray(v) && v.length;
      return true;
    });
    if (!all.length) { setErr('add at least one condition with a value'); return; }
    const out = { id: rule?.id, name: name.trim(), kind, why: why.trim(), all };
    if (kind === 'risk') out.weight = Number(weight);
    else if (kind === 'hardHit') out.floor = Number(floor);
    else if (kind === 'hardBenign') out.ceil = Number(ceil);
    onSave(out);
  };

  const hint = kindHint(kind, weight);
  return (
    <div className="rule-editor">
      {isBuiltin && <div className="banner-note">Editing a built-in creates an <b>override</b> (same id). Reset it later from the list.</div>}
      <div className="form-row">
        <label className="form-field grow">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. PHP in /images" /></label>
        <label className="form-field">Kind
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="risk">risk (weighted)</option>
            <option value="hardHit">hardHit (floor)</option>
            <option value="hardBenign">hardBenign (ceiling)</option>
          </select>
        </label>
        {kind === 'risk' && (
          <label className="form-field">Weight −1…1
            <input type="number" step="0.05" min="-1" max="1" value={weight} onChange={(e) => setWeight(e.target.value)} />
          </label>
        )}
        {kind === 'hardHit' && (
          <label className="form-field">Floor 0…100<input type="number" min="0" max="100" value={floor} onChange={(e) => setFloor(e.target.value)} /></label>
        )}
        {kind === 'hardBenign' && (
          <label className="form-field">Ceiling 0…100<input type="number" min="0" max="100" value={ceil} onChange={(e) => setCeil(e.target.value)} /></label>
        )}
      </div>
      <label className="form-field">Why (shown to reviewer)<input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="one-line rationale" /></label>

      <div className="cond-head">Conditions <span className="muted small">— all must match (AND)</span></div>
      <div className="cond-list">
        {conds.map((c, i) => (
          <CondRow key={i} c={c} canRemove={conds.length > 1} onChange={(nc) => setCond(i, nc)} onRemove={() => removeCond(i)} />
        ))}
      </div>
      <button className="btn ghost tiny" onClick={addCond}>+ condition</button>

      {err && <div className="banner err">{err}</div>}
      <div className="kind-hint"><span className="rot-label">Rule of thumb</span><b>{hint.k}</b> — {hint.t}</div>

      <div className="editor-foot">
        <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy || !canEdit} title={!canEdit ? 'Set an operator name first' : ''}>
          {busy ? 'Saving…' : (rule?.id ? 'Save rule' : 'Create rule')}
        </button>
      </div>
    </div>
  );
}

// ---- rule row (list) -----------------------------------------------------
function magnitude(r) {
  if (r.kind === 'hardHit') return `floor ${r.floor}`;
  if (r.kind === 'hardBenign') return `ceil ${r.ceil}`;
  const w = Number(r.weight);
  return (w > 0 ? '+' : '') + w;
}
const kindClass = (r) => (r.kind === 'hardHit' ? 'kind-hit' : r.kind === 'hardBenign' ? 'kind-benign' : Number(r.weight) < 0 ? 'kind-benign' : 'kind-risk');

function RuleRow({ r, canEdit, busy, onToggle, onEdit, onDelete, onReset }) {
  const enabled = !r.disabled;
  return (
    <div className={`rule-row ${enabled ? '' : 'off'}`}>
      <label className="switch" title={canEdit ? (enabled ? 'Disable this rule' : 'Enable this rule') : 'Set an operator name first'}>
        <input type="checkbox" checked={enabled} disabled={!canEdit || busy} onChange={() => onToggle(r, !enabled)} />
        <span className="slider" />
      </label>
      <span className={`rule-kind ${kindClass(r)}`} title={r.kind}>{magnitude(r)}</span>
      <div className="rule-main">
        <div className="rule-name">
          {r.name}
          {r.overridden && <span className="rule-tag" title="a user rule overrides this built-in">overridden</span>}
          {r.source === 'user' && <span className="rule-tag user" title="custom rule">custom</span>}
        </div>
        {r.why && <div className="rule-why">{r.why}</div>}
      </div>
      <div className="rule-actions">
        <button className="btn ghost tiny" disabled={!canEdit} onClick={() => onEdit(r)}>Edit</button>
        {r.source === 'user' && <button className="btn ghost tiny danger" disabled={!canEdit} onClick={() => onDelete(r)}>Delete</button>}
        {r.overridden && <button className="btn ghost tiny" disabled={!canEdit} onClick={() => onReset(r)} title="remove the override, revert to built-in">Reset</button>}
      </div>
    </div>
  );
}

// ---- modal ---------------------------------------------------------------
export function RulesModal({ operator, canEdit, reloadKey, onClose, notify }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(null); // null = list · {} = new · rule = edit

  const load = useCallback(async () => {
    try { setData(await api.rules()); setErr(''); }
    catch (e) { setErr(String(e.message || e)); }
  }, []);
  useEffect(() => { load(); }, [load, reloadKey]);

  const toggle = useCallback(async (r, enable) => {
    setBusy(r.id);
    try { await api.ruleDisable(r.id, !enable, operator); await load(); if (notify) notify(`${enable ? 'Enabled' : 'Disabled'}: ${r.name}`); }
    catch (e) { if (notify) notify(String(e.message || e), 'err'); }
    finally { setBusy(''); }
  }, [operator, load, notify]);

  const save = useCallback(async (rule) => {
    setBusy('save');
    try { const r = await api.ruleUpsert(rule, operator); setEditing(null); await load(); if (notify) notify(`Saved rule: ${r.rule.name}`); }
    catch (e) { if (notify) notify(String(e.message || e), 'err'); }
    finally { setBusy(''); }
  }, [operator, load, notify]);

  const del = useCallback(async (r) => {
    if (!window.confirm(`Delete rule "${r.name}"?`)) return;
    setBusy(r.id);
    try { await api.ruleDelete(r.id, operator); await load(); if (notify) notify(`Deleted rule: ${r.name}`); }
    catch (e) { if (notify) notify(String(e.message || e), 'err'); }
    finally { setBusy(''); }
  }, [operator, load, notify]);

  const reset = useCallback(async (r) => {
    if (!window.confirm(`Reset "${r.name}" to its built-in default?`)) return;
    setBusy(r.id);
    try { await api.ruleDelete(r.id, operator); await load(); if (notify) notify(`Reset to default: ${r.name}`); }
    catch (e) { if (notify) notify(String(e.message || e), 'err'); }
    finally { setBusy(''); }
  }, [operator, load, notify]);

  // Editing an overridden built-in should load the override's actual definition.
  const startEdit = (r) => {
    if (r.source === 'builtin' && r.overridden && data) {
      const ov = (data.overrides || []).find((o) => o.id === r.id && o.all && o.all.length);
      setEditing(ov ? { ...ov, source: 'builtin' } : r);
    } else setEditing(r);
  };

  const builtins = data ? data.builtins : [];
  const user = data ? data.user : [];
  const activeCount = [...builtins, ...user].filter((r) => !r.disabled).length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{editing ? (editing.id ? 'Edit rule' : 'New rule') : 'Classifier rules'}</h3>
          <div className="head-actions">
            {!editing && <button className="btn primary" disabled={!canEdit} title={!canEdit ? 'Set an operator name first' : ''} onClick={() => setEditing({})}>+ New rule</button>}
            <button className="btn ghost" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="modal-body">
          {err && <div className="banner err">Could not load rules: {err}</div>}
          {!data && !err && <div className="muted" style={{ padding: 16 }}>loading…</div>}

          {data && editing && (
            <RuleEditor rule={editing} canEdit={canEdit} busy={busy === 'save'} onSave={save} onCancel={() => setEditing(null)} />
          )}

          {data && !editing && (
            <>
              <div className="rules-summary muted small">
                {activeCount} active · {builtins.length} built-in · {user.length} custom
                {data.knowngood && ` · known-good index: ${data.knowngood.ready ? data.knowngood.size + ' hashes' : 'building…'}`}
                {!canEdit && <span className="op-hint"> — set an operator name to add/edit/toggle rules</span>}
              </div>

              <div className="rules-group-head">Built-in rules</div>
              {builtins.map((r) => (
                <RuleRow key={r.id} r={r} canEdit={canEdit} busy={busy === r.id}
                  onToggle={toggle} onEdit={startEdit} onDelete={del} onReset={reset} />
              ))}

              <div className="rules-group-head">Custom rules {user.length === 0 && <span className="muted small">— none yet</span>}</div>
              {user.map((r) => (
                <RuleRow key={r.id} r={r} canEdit={canEdit} busy={busy === r.id}
                  onToggle={toggle} onEdit={startEdit} onDelete={del} onReset={reset} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
