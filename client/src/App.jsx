import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, clientId } from './api.js';
import { Sidebar } from './Sidebar.jsx';
import { CodeView, DiffView } from './Editors.jsx';

const short = (h) => (h ? h.slice(0, 12) : '—');
const base = (p) => (p ? p.split('/').pop() : '');
const defaultMode = (f) => (f.status === 'added' ? 'right' : f.status === 'deleted' ? 'left' : 'diff');

export default function App() {
  const [summary, setSummary] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [loadErr, setLoadErr] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const [operator, setOperator] = useState(() => localStorage.getItem('ff.operator') || '');
  useEffect(() => localStorage.setItem('ff.operator', operator), [operator]);
  const canEdit = operator.trim().length > 0;
  const operatorRef = useRef(null);

  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState('diff');
  const [contents, setContents] = useState({ left: null, right: null });
  const [loadingFile, setLoadingFile] = useState(false);
  const [version, setVersion] = useState(0); // bumps to force editor rebuilds after ops
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [fixedOverride, setFixedOverride] = useState({}); // path -> bool (optimistic, over server state)
  const [history, setHistory] = useState(null);
  const [viewers, setViewers] = useState([]); // live presence from other clients

  const draftRef = useRef('');
  const toastTimer = useRef(null);
  const selectedRef = useRef(null);
  const summaryTimer = useRef(null);

  const notify = useCallback((msg, kind = 'ok') => {
    setToast({ msg, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const loadSummary = useCallback(async (refresh) => {
    try {
      setLoadErr('');
      const s = await api.summary(refresh);
      setSummary(s);
      if (refresh) { setFixedOverride({}); setReloadToken((t) => t + 1); }
    } catch (e) {
      setLoadErr(String(e.message || e));
    }
  }, []);

  useEffect(() => { loadSummary(false); }, [loadSummary]);

  selectedRef.current = selected;

  // Debounced counts refresh (coalesces bursts of remote events).
  const scheduleSummaryRefresh = useCallback(() => {
    clearTimeout(summaryTimer.current);
    summaryTimer.current = setTimeout(() => { api.summary(false).then(setSummary).catch(() => {}); }, 300);
  }, []);

  // Subscribe to live updates from other operators (once).
  useEffect(() => {
    const es = new EventSource(api.eventsUrl());
    es.addEventListener('presence', (e) => setViewers(JSON.parse(e.data).viewers || []));
    es.addEventListener('fixed', (e) => {
      const d = JSON.parse(e.data);
      if (d.clientId === clientId) return; // ignore our own echo
      setFixedOverride((o) => ({ ...o, [d.path]: d.fixed }));
      scheduleSummaryRefresh();
      notify(`${d.by || 'someone'} ${d.fixed ? 'marked fixed' : 'unmarked'}: ${base(d.path)}`);
    });
    es.addEventListener('mutated', (e) => {
      const d = JSON.parse(e.data);
      if (d.clientId === clientId) return;
      const cur = selectedRef.current;
      if (cur && cur.absolute_path === d.path) reloadSelected(cur);
      scheduleSummaryRefresh();
      notify(`${d.by || 'someone'}: ${d.operation} ${base(d.path)}`);
    });
    es.onerror = () => { /* EventSource reconnects automatically */ };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Broadcast our presence (what file/mode we're on) + heartbeat.
  useEffect(() => {
    const send = () => api.presence(operator, selected ? selected.absolute_path : null, selected ? mode : null).catch(() => {});
    send();
    const t = setInterval(send, 15000);
    return () => clearInterval(t);
  }, [operator, selected, mode]);

  const others = useMemo(() => viewers.filter((v) => v.id !== clientId), [viewers]);
  const viewersByPath = useMemo(() => {
    const m = {};
    for (const v of others) if (v.path) (m[v.path] = m[v.path] || []).push(v);
    return m;
  }, [others]);

  const isFixed = useCallback((file) => {
    if (!file) return false;
    const p = file.absolute_path;
    return p in fixedOverride ? fixedOverride[p] : !!file.fixed;
  }, [fixedOverride]);

  const loadContents = useCallback(async (file, forReload) => {
    setLoadingFile(true);
    try {
      const [left, right] = await Promise.all([
        !forReload && file.status === 'added' ? Promise.resolve({ exists: false }) : api.file('left', file.absolute_path).catch(() => ({ exists: false })),
        !forReload && file.status === 'deleted' ? Promise.resolve({ exists: false }) : api.file('right', file.absolute_path).catch(() => ({ exists: false })),
      ]);
      setContents({ left, right });
    } finally {
      setLoadingFile(false);
    }
  }, []);

  const selectFile = useCallback(async (file) => {
    setSelected(file);
    setMode(defaultMode(file));
    setVersion((v) => v + 1);
    await loadContents(file, false);
  }, [loadContents]);

  const reloadSelected = useCallback(async (file) => {
    setVersion((v) => v + 1);
    await loadContents(file, true);
  }, [loadContents]);

  const hasLeft = !!(contents.left && contents.left.exists);
  const hasRight = !!(contents.right && contents.right.exists);

  useEffect(() => {
    if (mode === 'edit') draftRef.current = (contents.right && contents.right.content) || '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, version, selected]);

  const ensureOperator = () => {
    if (canEdit) return true;
    notify('Set an operator name (top-right) before making changes', 'err');
    if (operatorRef.current) operatorRef.current.focus();
    return false;
  };

  const toggleFixed = useCallback(async (file, value) => {
    if (!file) return;
    const prev = file.absolute_path in fixedOverride ? fixedOverride[file.absolute_path] : !!file.fixed;
    try {
      await api.setFixed(file.absolute_path, value, operator, '');
      setFixedOverride((o) => ({ ...o, [file.absolute_path]: value }));
      if (value !== prev) setSummary((s) => {
        if (!s) return s;
        const delta = value ? 1 : -1;
        return {
          ...s,
          totals: { ...s.totals, fixed: Math.max(0, s.totals.fixed + delta) },
          websites: s.websites.map((w) => (w.name === file.website
            ? { ...w, counts: { ...w.counts, fixed: Math.max(0, (w.counts.fixed || 0) + delta) } }
            : w)),
        };
      });
    } catch (e) { notify(String(e.message || e), 'err'); }
  }, [operator, notify, fixedOverride]);

  const doDelete = async () => {
    if (!selected || !ensureOperator()) return;
    if (!window.confirm(`Delete RIGHT file?\n\n${selected.absolute_path}\n\nA backup is written to /evidence.`)) return;
    setBusy(true);
    try {
      await api.del(selected.absolute_path, operator, '');
      await toggleFixed(selected, true);
      notify('Deleted (backed up to /evidence)');
      await reloadSelected(selected);
      setMode('left');
    } catch (e) { notify(String(e.message || e), 'err'); }
    finally { setBusy(false); }
  };

  const doOverwrite = async () => {
    if (!selected || !ensureOperator()) return;
    const verb = hasRight ? 'Overwrite' : 'Restore';
    if (!window.confirm(`${verb} RIGHT with LEFT source?\n\n${selected.absolute_path}\n\nA backup is written to /evidence.`)) return;
    setBusy(true);
    try {
      await api.overwrite(selected.absolute_path, operator, '');
      await toggleFixed(selected, true);
      notify(`${verb} done (backed up to /evidence)`);
      await reloadSelected(selected);
      setMode('right');
    } catch (e) { notify(String(e.message || e), 'err'); }
    finally { setBusy(false); }
  };

  const doSave = async () => {
    if (!selected || !ensureOperator()) return;
    setBusy(true);
    try {
      await api.save(selected.absolute_path, draftRef.current, operator, '');
      await toggleFixed(selected, true);
      notify('Saved (backed up to /evidence)');
      await reloadSelected(selected);
      setMode('right');
    } catch (e) { notify(String(e.message || e), 'err'); }
    finally { setBusy(false); }
  };

  const onToggleFixedClick = () => {
    if (!ensureOperator()) return;
    toggleFixed(selected, !isFixed(selected));
  };

  const openHistory = async () => {
    try { setHistory((await api.audit()).records); }
    catch (e) { notify(String(e.message || e), 'err'); }
  };

  const docKey = selected ? `${selected.absolute_path}::${mode}::${version}` : 'none';

  const sha = useMemo(() => {
    if (!selected) return null;
    return { left: selected.left && selected.left.sha256, right: selected.right && selected.right.sha256 };
  }, [selected]);

  const selFixed = isFixed(selected);

  return (
    <div className="app">
      <Sidebar
        summary={summary}
        query={query} setQuery={setQuery}
        statusFilter={statusFilter} setStatusFilter={setStatusFilter}
        selected={selected} onSelect={selectFile}
        isFixed={isFixed} reloadToken={reloadToken}
        viewersByPath={viewersByPath}
      />

      <main className="main">
        <div className="topbar">
          <div className="totals">
            {summary ? (
              <>
                <span className="dot added">{summary.totals.added} added</span>
                <span className="dot modified">{summary.totals.modified} modified</span>
                <span className="dot deleted">{summary.totals.deleted} deleted</span>
                <span className="muted">· {summary.totals.fixed} fixed · {summary.totals.websites} sites · {summary.totals.unchanged} unchanged</span>
              </>
            ) : <span className="muted">loading…</span>}
          </div>
          <div className="spacer" />
          <span
            className="presence"
            title={others.length ? others.map((v) => `${v.operator || 'anonymous'}${v.path ? ' · ' + base(v.path) : ''}`).join('\n') : 'just you'}
          >
            👤 {others.length + 1} online
          </span>
          <label className={`operator ${canEdit ? '' : 'required'}`}>
            operator
            <input ref={operatorRef} value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="name required" spellCheck={false} />
            {!canEdit && <span className="op-hint">required for changes</span>}
          </label>
          <button className="btn ghost" onClick={openHistory}>History</button>
          <button className="btn ghost" onClick={() => loadSummary(true)}>Refresh CSVs</button>
        </div>

        {loadErr && (
          <div className="banner err">
            Could not load: {loadErr}. Check the CSV paths &amp; mounts, then Refresh.
          </div>
        )}

        {!selected && !loadErr && (
          <div className="placeholder">
            <h2>Select a changed file</h2>
            <p>Websites load collapsed; expand one (or search) to fetch its files on demand. Set an operator name before you can delete / overwrite / edit.</p>
          </div>
        )}

        {selected && (
          <>
            <div className="filebar">
              <span className={`badge ${selected.status}`}>{selected.status}</span>
              <span className="path" title={selected.absolute_path}>{selected.absolute_path}</span>
              <span className="sha" title="left sha256 → right sha256">
                {short(sha && sha.left)} → {short(sha && sha.right)}
              </span>
              {viewersByPath[selected.absolute_path] && (
                <span className="also" title="other operators on this file right now">
                  ⚠ also here: {viewersByPath[selected.absolute_path].map((v) => `${v.operator || 'anon'}${v.mode === 'edit' ? ' (editing)' : ''}`).join(', ')}
                </span>
              )}
            </div>

            <div className="actions">
              <div className="modes">
                <button className={`btn ${mode === 'diff' ? 'active' : ''}`} disabled={!(hasLeft && hasRight)} onClick={() => setMode('diff')}>Diff</button>
                <button className={`btn ${mode === 'left' ? 'active' : ''}`} disabled={!hasLeft} onClick={() => setMode('left')}>Left</button>
                <button className={`btn ${mode === 'right' ? 'active' : ''}`} disabled={!hasRight} onClick={() => setMode('right')}>Right</button>
                <button className={`btn ${mode === 'edit' ? 'active' : ''}`} disabled={!hasRight} onClick={() => setMode('edit')}>Edit right</button>
              </div>
              <div className="spacer" />
              <button
                className={`btn fixed-toggle ${selFixed ? 'on' : ''}`}
                disabled={busy || !canEdit}
                title={!canEdit ? 'Set an operator name first'
                  : selFixed ? 'Unmark fixed' : 'Mark this entry as fixed (persisted to /evidence + right CSV)'}
                onClick={onToggleFixedClick}
              >
                {selFixed ? '✔ Fixed' : 'Mark fixed'}
              </button>
              {mode === 'edit' && <button className="btn primary" disabled={busy || !canEdit} onClick={doSave}>Save</button>}
              <button className="btn warn" disabled={busy || !canEdit || !hasLeft} onClick={doOverwrite}>
                {hasRight ? 'Overwrite from left' : 'Restore from left'}
              </button>
              <button className="btn danger" disabled={busy || !canEdit || !hasRight} onClick={doDelete}>Delete right</button>
            </div>

            <div className="viewer">
              {loadingFile && <div className="loading">loading file…</div>}
              {!loadingFile && mode === 'diff' && hasLeft && hasRight && (
                <DiffView left={contents.left.content} right={contents.right.content} path={selected.absolute_path} docKey={docKey} />
              )}
              {!loadingFile && mode === 'left' && (
                <SideBody side={contents.left} path={selected.absolute_path} docKey={docKey} />
              )}
              {!loadingFile && mode === 'right' && (
                <SideBody side={contents.right} path={selected.absolute_path} docKey={docKey} />
              )}
              {!loadingFile && mode === 'edit' && hasRight && (
                <CodeView value={contents.right.content} path={selected.absolute_path} docKey={docKey} editable onChange={(v) => { draftRef.current = v; }} />
              )}
            </div>
          </>
        )}

        {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
      </main>

      {history && <HistoryModal records={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function SideBody({ side, path, docKey }) {
  if (!side || !side.exists) return <div className="loading">file not present on this side.</div>;
  if (side.tooLarge) return <div className="loading">file too large to display ({side.size} bytes).</div>;
  return <CodeView value={side.content} path={path} docKey={docKey} />;
}

function HistoryModal({ records, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Audit trail — /evidence/audit.log</h3>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <div className="modal-body">
          {records.length === 0 && <div className="muted">No operations logged yet.</div>}
          {records.map((r, i) => (
            <div className="logrow" key={i}>
              <span className={`badge op-${r.operation}`}>{r.operation}</span>
              <span className="log-time">{r.timestamp}</span>
              <span className="log-actor">{r.actor}</span>
              <span className="log-path" title={r.absolute_path}>{r.absolute_path}</span>
              <span className="log-sha">{short(r.before && r.before.sha256)} → {short(r.after && r.after.sha256)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
