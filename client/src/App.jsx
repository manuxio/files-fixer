import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { Sidebar } from './Sidebar.jsx';
import { CodeView, DiffView } from './Editors.jsx';

const short = (h) => (h ? h.slice(0, 12) : '—');
const defaultMode = (f) => (f.status === 'added' ? 'right' : f.status === 'deleted' ? 'left' : 'diff');

export default function App() {
  const [data, setData] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const [operator, setOperator] = useState(() => localStorage.getItem('ff.operator') || '');
  useEffect(() => localStorage.setItem('ff.operator', operator), [operator]);

  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState('diff');
  const [contents, setContents] = useState({ left: null, right: null });
  const [loadingFile, setLoadingFile] = useState(false);
  const [version, setVersion] = useState(0); // bumps to force editor rebuilds after ops
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [fixedMap, setFixedMap] = useState({}); // absolute_path -> { at, by } (persistent)
  const [history, setHistory] = useState(null);

  const draftRef = useRef('');
  const toastTimer = useRef(null);

  const notify = useCallback((msg, kind = 'ok') => {
    setToast({ msg, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const loadDiff = useCallback(async (refresh) => {
    try {
      setLoadErr('');
      const d = await api.diff(refresh);
      setData(d);
      const fm = {};
      for (const w of d.websites) for (const f of w.files) if (f.fixed) fm[f.absolute_path] = { at: f.fixedAt, by: f.fixedBy };
      setFixedMap(fm);
    } catch (e) {
      setLoadErr(String(e.message || e));
    }
  }, []);

  useEffect(() => { loadDiff(false); }, [loadDiff]);

  const loadContents = useCallback(async (file) => {
    setLoadingFile(true);
    try {
      const [left, right] = await Promise.all([
        file.status === 'added' ? Promise.resolve({ exists: false }) : api.file('left', file.absolute_path),
        file.status === 'deleted' ? Promise.resolve({ exists: false }) : api.file('right', file.absolute_path),
      ]);
      setContents({ left, right });
    } catch (e) {
      notify(String(e.message || e), 'err');
      setContents({ left: null, right: null });
    } finally {
      setLoadingFile(false);
    }
  }, [notify]);

  const selectFile = useCallback(async (file) => {
    setSelected(file);
    setMode(defaultMode(file));
    setVersion((v) => v + 1);
    await loadContents(file);
  }, [loadContents]);

  const reloadSelected = useCallback(async (file) => {
    setVersion((v) => v + 1);
    setLoadingFile(true);
    try {
      const [left, right] = await Promise.all([
        api.file('left', file.absolute_path).catch(() => ({ exists: false })),
        api.file('right', file.absolute_path).catch(() => ({ exists: false })),
      ]);
      setContents({ left, right });
    } finally {
      setLoadingFile(false);
    }
  }, []);

  const hasLeft = !!(contents.left && contents.left.exists);
  const hasRight = !!(contents.right && contents.right.exists);

  useEffect(() => {
    if (mode === 'edit') draftRef.current = (contents.right && contents.right.content) || '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, version, selected]);

  const toggleFixed = useCallback(async (file, value) => {
    if (!file) return;
    try {
      const r = await api.setFixed(file.absolute_path, value, operator, '');
      setFixedMap((m) => {
        const n = { ...m };
        if (value) n[file.absolute_path] = { at: r.at, by: r.by };
        else delete n[file.absolute_path];
        return n;
      });
    } catch (e) { notify(String(e.message || e), 'err'); }
  }, [operator, notify]);

  const doDelete = async () => {
    if (!selected || !window.confirm(`Delete RIGHT file?\n\n${selected.absolute_path}\n\nA backup is written to /evidence.`)) return;
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
    const verb = hasRight ? 'Overwrite' : 'Restore';
    if (!selected || !window.confirm(`${verb} RIGHT with LEFT source?\n\n${selected.absolute_path}\n\nA backup is written to /evidence.`)) return;
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
    if (!selected) return;
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

  const openHistory = async () => {
    try { setHistory((await api.audit()).records); }
    catch (e) { notify(String(e.message || e), 'err'); }
  };

  const docKey = selected ? `${selected.absolute_path}::${mode}::${version}` : 'none';

  const sha = useMemo(() => {
    if (!selected) return null;
    return { left: selected.left && selected.left.sha256, right: selected.right && selected.right.sha256 };
  }, [selected]);

  return (
    <div className="app">
      <Sidebar
        data={data}
        query={query} setQuery={setQuery}
        statusFilter={statusFilter} setStatusFilter={setStatusFilter}
        selected={selected} onSelect={selectFile}
        fixedMap={fixedMap}
      />

      <main className="main">
        <div className="topbar">
          <div className="totals">
            {data ? (
              <>
                <span className="dot added">{data.totals.added} added</span>
                <span className="dot modified">{data.totals.modified} modified</span>
                <span className="dot deleted">{data.totals.deleted} deleted</span>
                <span className="muted">· {data.totals.fixed} fixed · {data.totals.websites} sites · {data.totals.unchanged} unchanged</span>
              </>
            ) : <span className="muted">loading…</span>}
          </div>
          <div className="spacer" />
          <label className="operator">
            operator
            <input value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="your name" spellCheck={false} />
          </label>
          <button className="btn ghost" onClick={openHistory}>History</button>
          <button className="btn ghost" onClick={() => loadDiff(true)}>Refresh CSVs</button>
        </div>

        {loadErr && (
          <div className="banner err">
            Could not load diff: {loadErr}. Check the CSV paths &amp; mounts, then Refresh.
          </div>
        )}

        {!selected && !loadErr && (
          <div className="placeholder">
            <h2>Select a changed file</h2>
            <p>Files are grouped by website. Filter by status or search by website / filename on the left.</p>
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
                className={`btn fixed-toggle ${fixedMap[selected.absolute_path] ? 'on' : ''}`}
                disabled={busy}
                title={fixedMap[selected.absolute_path]
                  ? `fixed by ${fixedMap[selected.absolute_path].by || '?'} @ ${fixedMap[selected.absolute_path].at || ''}`
                  : 'Mark this entry as fixed (persisted to /evidence + right CSV)'}
                onClick={() => toggleFixed(selected, !fixedMap[selected.absolute_path])}
              >
                {fixedMap[selected.absolute_path] ? '✔ Fixed' : 'Mark fixed'}
              </button>
              {mode === 'edit' && <button className="btn primary" disabled={busy} onClick={doSave}>Save</button>}
              <button className="btn warn" disabled={busy || !hasLeft} onClick={doOverwrite}>
                {hasRight ? 'Overwrite from left' : 'Restore from left'}
              </button>
              <button className="btn danger" disabled={busy || !hasRight} onClick={doDelete}>Delete right</button>
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
