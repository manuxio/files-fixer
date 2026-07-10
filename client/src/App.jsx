import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, clientId } from './api.js';
import { Sidebar, RiskChip } from './Sidebar.jsx';
import { CodeView, DiffView } from './Editors.jsx';
import { RulesModal } from './Rules.jsx';
import { ClaudeShellModal } from './ClaudeShell.jsx';

const short = (h) => (h ? h.slice(0, 12) : '—');
const base = (p) => (p ? p.split('/').pop() : '');
const defaultMode = (f) => (f.status === 'added' ? 'right' : f.status === 'deleted' ? 'left' : 'diff');

export default function App() {
  const [summary, setSummary] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [loadErr, setLoadErr] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem('ff.sidebarWidth')) || 320);
  useEffect(() => localStorage.setItem('ff.sidebarWidth', String(sidebarWidth)), [sidebarWidth]);
  const startResize = (e) => {
    e.preventDefault();
    const onMove = (ev) => setSidebarWidth(Math.min(700, Math.max(200, ev.clientX)));
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

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
  const [multiSel, setMultiSel] = useState({}); // path -> file (bulk selection, scoped to one website)
  const [shaPropose, setShaPropose] = useState(null); // { sha, files } — identical files to also mark fixed
  const [history, setHistory] = useState(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [claudeAsk, setClaudeAsk] = useState(null); // { loading, file, result?, error? } — Ask claude modal
  const [rulesReload, setRulesReload] = useState(0); // bumps to refetch the rules panel
  const [viewers, setViewers] = useState([]); // live presence from other clients

  const [joomlaVersions, setJoomlaVersions] = useState([]);
  const [joomlaVersion, setJoomlaVersion] = useState(() => localStorage.getItem('ff.joomlaVersion') || '');
  useEffect(() => { if (joomlaVersion) localStorage.setItem('ff.joomlaVersion', joomlaVersion); }, [joomlaVersion]);
  const [joomla, setJoomla] = useState(null); // pristine-file lookup for the selected file

  const [jceSources, setJceSources] = useState([]);
  const [jceSourceVersion, setJceSourceVersion] = useState(() => localStorage.getItem('ff.jceSourceVersion') || '');
  useEffect(() => { if (jceSourceVersion) localStorage.setItem('ff.jceSourceVersion', jceSourceVersion); }, [jceSourceVersion]);
  const [jceSrc, setJceSrc] = useState(null); // pristine JCE-file lookup for the selected file

  const [agentRuns, setAgentRuns] = useState({});     // website -> live automation run status
  const [agentsEnabled, setAgentsEnabled] = useState(false); // Claude automation available on the server?
  const [agentTarget, setAgentTarget] = useState(null); // website name -> opens the "how many agents" dialog
  const [agentBusy, setAgentBusy] = useState(false);

  const [jceAvailable, setJceAvailable] = useState(false);
  const [patchedMap, setPatchedMap] = useState({});   // website -> { status, at, jce }
  const [patchTarget, setPatchTarget] = useState(null); // website name -> opens the dialog
  const [patchForm, setPatchForm] = useState({ baseUrl: '', ip: '', basicUser: '', basicPass: '' });
  const [patchBusy, setPatchBusy] = useState(false);
  const [patchResult, setPatchResult] = useState(null);

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
      const pm = {};
      for (const w of s.websites) if (w.patched) pm[w.name] = w.patched;
      setPatchedMap(pm);
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
    es.addEventListener('patched', (e) => {
      const d = JSON.parse(e.data);
      setPatchedMap((m) => ({ ...m, [d.website]: { status: d.status, at: d.at, jce: d.jce_after } }));
      if (d.clientId !== clientId) notify(`${d.by || 'someone'}: JCE patch ${d.status} on ${d.website}${d.jce_after ? ' (' + d.jce_after + ')' : ''}`);
    });
    es.addEventListener('rules', (e) => {
      const d = JSON.parse(e.data);
      setRulesReload((t) => t + 1); // refresh an open rules panel
      if (d.clientId !== clientId) notify(`${d.by || 'someone'}: ${d.op} rule ${d.id}`);
    });
    es.addEventListener('agents', (e) => {
      const d = JSON.parse(e.data);
      setAgentRuns((m) => {
        const n = { ...m };
        if (d.op === 'stopped') delete n[d.website]; else n[d.website] = d;
        return n;
      });
      if (d.op === 'started') notify(`${d.by || 'someone'} started ${d.count} Claude agent(s) on ${d.website}`);
      if (d.op === 'stopped') {
        notify(`✦ ${d.website}: ${d.reason}`, /unavailable|error/i.test(d.reason) ? 'err' : 'ok');
        scheduleSummaryRefresh();
      }
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

  // is the JCE remediation feature available (dropper + packages bundled)?
  useEffect(() => { api.jceStatus().then((s) => setJceAvailable(!!s.available)).catch(() => {}); }, []);

  // Claude automation: availability + any runs already in flight (page reload).
  useEffect(() => {
    api.agents().then((r) => {
      setAgentsEnabled(!!r.enabled);
      const m = {};
      for (const run of r.runs || []) m[run.website] = run;
      setAgentRuns(m);
    }).catch(() => {});
  }, []);

  // discover pristine Joomla versions available on the server
  useEffect(() => {
    api.joomlaVersions()
      .then((r) => {
        const vs = r.versions || [];
        setJoomlaVersions(vs);
        setJoomlaVersion((cur) => cur || (vs[0] ? vs[0].id : ''));
      })
      .catch(() => {});
  }, []);

  // discover pristine JCE sources (the packages the dropper installs)
  useEffect(() => {
    api.jceSources()
      .then((r) => {
        const s = r.sources || [];
        setJceSources(s);
        setJceSourceVersion((cur) => cur || (s[0] ? s[0].id : ''));
      })
      .catch(() => {});
  }, []);

  // look up the pristine JCE file when in JCE-compare mode
  useEffect(() => {
    if (mode !== 'jce' || !selected || !jceSourceVersion) return undefined;
    let alive = true;
    setJceSrc({ loading: true });
    api.jceSrcFile(jceSourceVersion, selected.absolute_path)
      .then((r) => { if (alive) setJceSrc({ loading: false, ...r }); })
      .catch((e) => { if (alive) setJceSrc({ loading: false, error: String(e.message || e) }); });
    return () => { alive = false; };
  }, [mode, selected, jceSourceVersion, version]);

  // look up the pristine core file when in Joomla-compare mode
  useEffect(() => {
    if (mode !== 'joomla' || !selected || !joomlaVersion) return undefined;
    let alive = true;
    setJoomla({ loading: true });
    api.joomlaFile(joomlaVersion, selected.absolute_path)
      .then((r) => { if (alive) setJoomla({ loading: false, ...r }); })
      .catch((e) => { if (alive) setJoomla({ loading: false, error: String(e.message || e) }); });
    return () => { alive = false; };
  }, [mode, selected, joomlaVersion, version]);

  const others = useMemo(() => viewers.filter((v) => v.id !== clientId), [viewers]);
  const humans = useMemo(() => others.filter((v) => v.kind !== 'agent'), [others]);
  const agentViewers = useMemo(() => others.filter((v) => v.kind === 'agent'), [others]);
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
        const d = value ? 1 : -1;      // fixed +1 / status -1  (and reverse on unmark)
        const st = file.status;
        const adj = (c) => ({ ...c, fixed: Math.max(0, (c.fixed || 0) + d), [st]: Math.max(0, (c[st] || 0) - d) });
        return {
          ...s,
          totals: adj(s.totals),
          websites: s.websites.map((w) => (w.name === file.website ? { ...w, counts: adj(w.counts) } : w)),
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
      await proposeSameSha(selected.absolute_path, 'delete');
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

  // Ask Claude to triage the selected file (claude -p in the hardened sandbox).
  // Fetch same-checksum siblings in parallel so the modal can offer bulk apply.
  const askClaude = useCallback(async () => {
    const file = selectedRef.current;
    if (!file) return;
    setClaudeAsk({ loading: true, file });
    try {
      const [r, sh] = await Promise.all([
        api.claudeAnalyze(file.absolute_path),
        api.sameSha(file.absolute_path).catch(() => ({ sha: null, files: [] })),
      ]);
      setClaudeAsk({ loading: false, file, result: r, sha: sh.sha, matches: sh.files || [] });
    } catch (e) {
      setClaudeAsk({ loading: false, file, error: String(e.message || e) });
    }
  }, []);

  // Act on Claude's proposal — on the selected file plus any same-checksum
  // siblings the user opted into (matches).
  const applyProposal = async (outcome, matches) => {
    if (!selected) return;
    const files = [selected, ...(matches || [])];
    if (outcome === 'delete' || outcome === 'left') {
      const verb = outcome === 'delete' ? 'Delete' : 'Revert (overwrite from left)';
      const list = files.map((f) => f.absolute_path).slice(0, 8).join('\n');
      const more = files.length > 8 ? `\n…and ${files.length - 8} more` : '';
      if (!window.confirm(`${verb} ${files.length} file(s)?\n\n${list}${more}\n\nBackups are written to /evidence.`)) return;
    }
    if (!ensureOperator()) return;
    setClaudeAsk(null);
    setBusy(true);
    const note = matches && matches.length ? 'ask-claude (same-sha)' : 'ask-claude';
    try {
      if (outcome === 'keep') {
        await Promise.all(files.map((f) => toggleFixed(f, true)));
        notify(`Marked ${files.length} file(s) fixed`);
      } else if (outcome === 'left') {
        await Promise.all(files.map(async (f) => { await api.overwrite(f.absolute_path, operator, note); await toggleFixed(f, true); }));
        notify(`Reverted ${files.length} file(s) from left (backed up)`);
      } else if (outcome === 'delete') {
        await Promise.all(files.map(async (f) => { await api.del(f.absolute_path, operator, note); await toggleFixed(f, true); }));
        notify(`Deleted ${files.length} file(s) (backed up)`);
      }
      await reloadSelected(selected);
    } catch (e) { notify(String(e.message || e), 'err'); }
    finally { setBusy(false); }
  };

  const doSave = async () => {
    if (!selected || !ensureOperator()) return;
    const savedContent = draftRef.current;
    setBusy(true);
    try {
      await api.save(selected.absolute_path, savedContent, operator, '');
      await toggleFixed(selected, true);
      notify('Saved (backed up to /evidence)');
      await reloadSelected(selected);
      setMode('right');
      await proposeSameSha(selected.absolute_path, 'edit', { content: savedContent });
    } catch (e) { notify(String(e.message || e), 'err'); }
    finally { setBusy(false); }
  };

  // After an action on one file, offer to apply it to byte-identical copies
  // (same content sha) elsewhere. `sameSha` reads the CSV snapshot, so it still
  // finds the originals even though we just changed this one on disk.
  const proposeSameSha = async (path, action, extra) => {
    try {
      const r = await api.sameSha(path);
      let matches = r.files || [];
      if (action === 'fixed') matches = matches.filter((f) => !isFixed(f));
      else matches = matches.filter((f) => f.status !== 'deleted'); // has a right file to delete/edit
      if (matches.length) setShaPropose({ sha: r.sha, files: matches, action, ...(extra || {}) });
    } catch { /* ignore */ }
  };

  const onToggleFixedClick = async () => {
    if (!ensureOperator()) return;
    const turningOn = !isFixed(selected);
    await toggleFixed(selected, turningOn);
    if (turningOn) await proposeSameSha(selected.absolute_path, 'fixed');
  };

  const doProposedAction = async () => {
    const p = shaPropose;
    setShaPropose(null);
    if (!p) return;
    setBusy(true);
    try {
      if (p.action === 'fixed') {
        await Promise.all(p.files.map((f) => toggleFixed(f, true)));
        notify(`Marked ${p.files.length} identical file(s) fixed`);
      } else if (p.action === 'delete') {
        await Promise.all(p.files.map(async (f) => { await api.del(f.absolute_path, operator, 'same-sha bulk'); await toggleFixed(f, true); }));
        notify(`Deleted ${p.files.length} identical file(s) (backed up to /evidence)`);
      } else if (p.action === 'edit') {
        await Promise.all(p.files.map(async (f) => { await api.save(f.absolute_path, p.content, operator, 'same-sha bulk'); await toggleFixed(f, true); }));
        notify(`Applied the edit to ${p.files.length} identical file(s) (backed up to /evidence)`);
      }
    } catch (e) { notify(String(e.message || e), 'err'); }
    finally { setBusy(false); }
  };

  // --- bulk multi-select (same website): mark fixed / delete only ---
  const toggleMulti = useCallback((file) => {
    setMultiSel((prev) => {
      if (prev[file.absolute_path]) { const n = { ...prev }; delete n[file.absolute_path]; return n; }
      const first = Object.values(prev)[0];
      if (first && first.website !== file.website) return { [file.absolute_path]: file }; // switch website
      return { ...prev, [file.absolute_path]: file };
    });
  }, []);
  const clearMulti = () => setMultiSel({});
  const multiFiles = Object.values(multiSel);
  const multiWebsite = multiFiles.length ? multiFiles[0].website : null;

  const bulkFixed = async () => {
    if (!ensureOperator()) return;
    setBusy(true);
    try { await Promise.all(multiFiles.map((f) => toggleFixed(f, true))); notify(`Marked ${multiFiles.length} fixed`); clearMulti(); }
    catch (e) { notify(String(e.message || e), 'err'); }
    finally { setBusy(false); }
  };

  const bulkDelete = async () => {
    if (!ensureOperator()) return;
    const del = multiFiles.filter((f) => f.status !== 'deleted');
    if (!del.length) { notify('No deletable right-side files in selection', 'err'); return; }
    if (!window.confirm(`Delete ${del.length} RIGHT file(s) in ${multiWebsite}?\n\nEach is backed up to /evidence.`)) return;
    setBusy(true);
    try {
      await Promise.all(del.map(async (f) => { await api.del(f.absolute_path, operator, ''); await toggleFixed(f, true); }));
      notify(`Deleted ${del.length} (backed up to /evidence)`);
      if (selected && multiSel[selected.absolute_path]) await reloadSelected(selected);
      clearMulti();
    } catch (e) { notify(String(e.message || e), 'err'); }
    finally { setBusy(false); }
  };

  const openHistory = async () => {
    try { setHistory((await api.audit()).records); }
    catch (e) { notify(String(e.message || e), 'err'); }
  };

  // The sidebar ✦ button: idle -> open the "how many agents" dialog; running ->
  // confirm, then stop that website's agents.
  const onAgentsClick = (website) => {
    if (!ensureOperator()) return;
    const run = agentRuns[website];
    if (run) {
      const inFlight = (run.agents || []).filter((a) => a.path).length;
      if (!window.confirm(`Stop the ${run.count} Claude agent(s) on ${website}?${inFlight ? `\n\n${inFlight} file(s) currently in flight will finish first.` : ''}`)) return;
      api.agentsStop(website, operator).catch((e) => notify(String(e.message || e), 'err'));
    } else {
      setAgentTarget(website);
    }
  };

  const startAgents = async (count) => {
    if (!ensureOperator()) return;
    setAgentBusy(true);
    try {
      await api.agentsStart(agentTarget, count, operator);
      setAgentTarget(null);
    } catch (e) { notify(String(e.message || e), 'err'); }
    finally { setAgentBusy(false); }
  };

  const openPatch = (website) => {
    if (!ensureOperator()) return;
    setPatchTarget(website);
    setPatchForm({ baseUrl: '', ip: '', basicUser: '', basicPass: '' });
    setPatchResult(null);
  };

  const runPatch = async () => {
    if (!ensureOperator()) return;
    if (!patchForm.baseUrl.trim()) { notify('Base URL required', 'err'); return; }
    setPatchBusy(true); setPatchResult(null);
    try {
      const r = await api.patchJce({
        website: patchTarget, baseUrl: patchForm.baseUrl.trim(),
        ip: patchForm.ip.trim() || undefined,
        basicUser: patchForm.basicUser || undefined, basicPass: patchForm.basicPass || undefined,
        operator,
      });
      setPatchResult({ ...r.record, detail: r.detail });
      setPatchedMap((m) => ({ ...m, [patchTarget]: { status: r.record.status, at: r.record.timestamp, jce: r.record.jce_after } }));
      const good = r.record.status === 'patched' || r.record.status === 'already';
      notify(`JCE ${r.record.status}: ${patchTarget}`, good ? 'ok' : 'err');
    } catch (e) {
      setPatchResult({ status: 'failed', note: String(e.message || e) });
      notify(String(e.message || e), 'err');
    } finally { setPatchBusy(false); }
  };

  const docKey = selected ? `${selected.absolute_path}::${mode}::${version}` : 'none';

  const sha = useMemo(() => {
    if (!selected) return null;
    return { left: selected.left && selected.left.sha256, right: selected.right && selected.right.sha256 };
  }, [selected]);

  const selFixed = isFixed(selected);
  // Best harmfulness score for the open file: the content-tier score from the
  // read (if present) wins over the manifest-tier score carried in the list.
  const selRisk = (contents.right && contents.right.risk)
    || (contents.left && contents.left.risk)
    || (selected && selected.risk) || null;

  return (
    <div className="app" style={{ gridTemplateColumns: `${sidebarWidth}px 5px 1fr` }}>
      <Sidebar
        summary={summary}
        query={query} setQuery={setQuery}
        statusFilter={statusFilter} setStatusFilter={setStatusFilter}
        selected={selected} onSelect={selectFile}
        isFixed={isFixed} reloadToken={reloadToken}
        viewersByPath={viewersByPath}
        patchedMap={patchedMap}
        agentRuns={agentRuns}
        onAgents={agentsEnabled ? onAgentsClick : null}
        onPatch={jceAvailable ? openPatch : null}
        multiSel={multiSel} onToggleMulti={toggleMulti}
      />

      <div className="resizer" onMouseDown={startResize} title="Drag to resize the sidebar" />

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
            title={others.length ? others.map((v) => `${v.kind === 'agent' ? '✦' : '👤'} ${v.operator || 'anonymous'}${v.path ? ' · ' + base(v.path) : ''}`).join('\n') : 'just you'}
          >
            👤 {humans.length + 1} online{agentViewers.length > 0 && <span className="presence-agents"> · ✦ {agentViewers.length} agent{agentViewers.length === 1 ? '' : 's'}</span>}
          </span>
          <label className={`operator ${canEdit ? '' : 'required'}`}>
            operator
            <input ref={operatorRef} value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="name required" spellCheck={false} />
            {!canEdit && <span className="op-hint">required for changes</span>}
          </label>
          <button
            className="btn ghost"
            disabled={!selected}
            onClick={() => selected && setClaudeOpen(true)}
            title={selected ? 'Open a hardened Claude session for this file' : 'Select a file first'}
          >Claude</button>
          <button className="btn ghost" onClick={() => setRulesOpen(true)}>Rules</button>
          <button className="btn ghost" onClick={openHistory}>History</button>
          <button className="btn ghost" onClick={() => loadSummary(true)}>Refresh CSVs</button>
        </div>

        {multiFiles.length > 0 && (
          <div className="bulkbar">
            <span><b>{multiFiles.length}</b> selected · {multiWebsite}</span>
            <div className="spacer" />
            <button className="btn fixed-toggle on" disabled={busy || !canEdit} onClick={bulkFixed}>Mark fixed</button>
            <button className="btn danger" disabled={busy || !canEdit} onClick={bulkDelete}>Delete right</button>
            <button className="btn ghost" onClick={clearMulti}>Clear</button>
          </div>
        )}

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
              {selRisk && (
                <span className="risk-inline" title="server-computed harmfulness — advisory only">
                  <RiskChip risk={selRisk} />
                  <span className={`risk-label band-${selRisk.band}`}>{selRisk.band}</span>
                </span>
              )}
              <span className="path" title={selected.absolute_path}>{selected.absolute_path}</span>
              <span className="sha" title="left sha256 → right sha256">
                {short(sha && sha.left)} → {short(sha && sha.right)}
              </span>
              {viewersByPath[selected.absolute_path] && (
                <span className="also" title="other operators on this file right now">
                  ⚠ also here: {viewersByPath[selected.absolute_path].map((v) => `${v.kind === 'agent' ? '✦ ' : ''}${v.operator || 'anon'}${v.mode === 'edit' ? ' (editing)' : ''}`).join(', ')}
                </span>
              )}
            </div>

            {selRisk && selRisk.reasons && selRisk.reasons.length > 0 && (
              <div className="rule-hits" title="classifier rules that fired for this file (server-computed)">
                <span className="label">matched</span>
                {selRisk.reasons.map((r) => (
                  <span key={r.id} className={`hit ${r.weight < 0 ? 'neg' : 'pos'}`} title={r.why || r.name}>
                    {r.name} <span className="w">({r.weight > 0 ? '+' : ''}{r.weight})</span>
                  </span>
                ))}
              </div>
            )}

            <div className="actions">
              <div className="modes">
                <button className={`btn ${mode === 'diff' ? 'active' : ''}`} disabled={!(hasLeft && hasRight)} onClick={() => setMode('diff')}>Diff</button>
                <button className={`btn ${mode === 'left' ? 'active' : ''}`} disabled={!hasLeft} onClick={() => setMode('left')}>Left</button>
                <button className={`btn ${mode === 'right' ? 'active' : ''}`} disabled={!hasRight} onClick={() => setMode('right')}>Right</button>
                <button className={`btn ${mode === 'edit' ? 'active' : ''}`} disabled={!hasRight} onClick={() => setMode('edit')}>Edit right</button>
                {joomlaVersions.length > 0 && (
                  <>
                    <button
                      className={`btn ${mode === 'joomla' ? 'active' : ''}`}
                      disabled={!(hasRight || hasLeft)}
                      title="Diff the current file against pristine Joomla core"
                      onClick={() => setMode('joomla')}
                    >vs Joomla</button>
                    <select className="jversion" value={joomlaVersion} onChange={(e) => setJoomlaVersion(e.target.value)} title="Joomla version to compare against">
                      {joomlaVersions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                    </select>
                  </>
                )}
                {jceSources.length > 0 && (
                  <>
                    <button
                      className={`btn ${mode === 'jce' ? 'active' : ''}`}
                      disabled={!(hasRight || hasLeft)}
                      title="Diff the current file against the pristine JCE package the dropper installs"
                      onClick={() => setMode('jce')}
                    >vs JCE</button>
                    <select className="jversion" value={jceSourceVersion} onChange={(e) => setJceSourceVersion(e.target.value)} title="JCE source to compare against">
                      {jceSources.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                    </select>
                  </>
                )}
              </div>
              <div className="spacer" />
              <button
                className="btn ask-claude"
                disabled={busy || (claudeAsk && claudeAsk.loading) || !(hasRight || hasLeft)}
                title="Ask Claude to analyze this file and propose a remediation"
                onClick={askClaude}
              >
                {claudeAsk && claudeAsk.loading ? 'Asking…' : '✦ Ask claude'}
              </button>
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
              {!loadingFile && mode === 'joomla' && (
                <JoomlaBody
                  joomla={joomla}
                  current={hasRight ? contents.right : (hasLeft ? contents.left : null)}
                  currentSide={hasRight ? 'right' : 'left'}
                  path={selected.absolute_path}
                  version={joomlaVersion}
                  docKey={`${selected.absolute_path}::joomla::${joomlaVersion}::${version}`}
                />
              )}
              {!loadingFile && mode === 'jce' && (
                <JceBody
                  jce={jceSrc}
                  current={hasRight ? contents.right : (hasLeft ? contents.left : null)}
                  currentSide={hasRight ? 'right' : 'left'}
                  path={selected.absolute_path}
                  version={jceSourceVersion}
                  docKey={`${selected.absolute_path}::jce::${jceSourceVersion}::${version}`}
                />
              )}
            </div>
          </>
        )}

        {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
      </main>

      {shaPropose && (
        <SameShaModal sha={shaPropose.sha} files={shaPropose.files} action={shaPropose.action} onConfirm={doProposedAction} onClose={() => setShaPropose(null)} />
      )}
      {history && <HistoryModal records={history} onClose={() => setHistory(null)} />}
      {rulesOpen && (
        <RulesModal
          operator={operator} canEdit={canEdit} reloadKey={rulesReload}
          onClose={() => setRulesOpen(false)} notify={notify}
        />
      )}
      {claudeOpen && selected && <ClaudeShellModal file={selected} onClose={() => setClaudeOpen(false)} />}
      {claudeAsk && (
        <AnalyzeModal
          state={claudeAsk} hasRight={hasRight} hasLeft={hasLeft} isFixed={isFixed}
          onApply={applyProposal} onRetry={askClaude} onClose={() => setClaudeAsk(null)}
        />
      )}
      {agentTarget && (
        <AgentsModal
          website={agentTarget} busy={agentBusy} onStart={startAgents}
          onClose={() => { if (!agentBusy) setAgentTarget(null); }}
        />
      )}
      {patchTarget && (
        <PatchModal
          website={patchTarget} form={patchForm} setForm={setPatchForm}
          busy={patchBusy} result={patchResult} onRun={runPatch}
          onClose={() => { if (!patchBusy) setPatchTarget(null); }}
        />
      )}
    </div>
  );
}

const OUTCOME_UI = {
  keep: { label: 'KEEP', cls: 'keep', headline: 'Safe to keep as-is', action: 'Mark fixed', actCls: 'fixed-toggle on' },
  left: { label: 'REVERT', cls: 'left', headline: 'Revert to the previous version', action: 'Overwrite from left', actCls: 'warn' },
  delete: { label: 'DELETE', cls: 'delete', headline: 'Malicious — delete it', action: 'Delete right', actCls: 'danger' },
  dontknow: { label: "DON'T KNOW", cls: 'uncertain', headline: 'Claude could not decide — review manually', action: null, actCls: '' },
  uncertain: { label: 'UNCERTAIN', cls: 'uncertain', headline: 'Uncertain — review manually', action: null, actCls: '' },
};

function AnalyzeModal({ state, hasRight, hasLeft, isFixed, onApply, onRetry, onClose }) {
  const { loading, file, result, error } = state;
  const [applyAll, setApplyAll] = useState(false);
  const name = base(file && file.absolute_path);
  const ui = result ? (OUTCOME_UI[result.outcome] || OUTCOME_UI.uncertain) : null;
  const canAct = result && (
    result.outcome === 'keep'
    || (result.outcome === 'left' && hasLeft)
    || (result.outcome === 'delete' && hasRight)
  );
  // Same-checksum siblings the proposed action can apply to.
  const applicable = (result && ui && ui.action ? (state.matches || []) : []).filter((m) => {
    if (m.absolute_path === (file && file.absolute_path)) return false;
    if (result.outcome === 'delete') return m.status !== 'deleted';
    if (result.outcome === 'left') return m.status === 'modified'; // needs a left baseline to revert to
    if (result.outcome === 'keep') return !isFixed(m);
    return false;
  });
  const nExtra = applyAll ? applicable.length : 0;
  return (
    <div className="modal-backdrop" onClick={() => { if (!loading) onClose(); }}>
      <div className="modal small" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>✦ Ask Claude · {name}</h3>
          <button className="btn ghost" disabled={loading} onClick={onClose}>Close</button>
        </div>
        <div className="modal-body pad">
          {loading && (
            <div className="analyze-loading">
              <span className="spinner" />
              <div>
                <div>Analyzing <code>current</code> vs <code>previous</code> in a hardened sandbox…</div>
                <div className="muted small">Running <code>claude -p</code> on a random account — this can take up to a minute.</div>
              </div>
            </div>
          )}

          {!loading && error && (
            <>
              <div className="banner err">{error}</div>
              <div className="muted small">
                {/limit|unavailable|429/i.test(error)
                  ? 'Every account was tried and none were available. Try again later, or open the shell to check /login.'
                  : 'The analysis could not complete.'}
              </div>
              <div className="analyze-actions">
                <button className="btn ghost" onClick={onClose}>Close</button>
                <button className="btn" onClick={onRetry}>Retry</button>
              </div>
            </>
          )}

          {!loading && result && (
            <>
              <div className={`analyze-verdict ${ui.cls}`}>
                <span className="analyze-badge">{ui.label}</span>
                <span className="analyze-headline">{ui.headline}</span>
              </div>
              <p className="analyze-reason">{result.brief_reason || '(no reason given)'}</p>

              {ui.action && applicable.length > 0 && (
                <label className="analyze-samesha">
                  <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />
                  <span>
                    Apply the same action to <b>{applicable.length}</b> other file{applicable.length === 1 ? '' : 's'} with the same checksum
                    {state.sha ? <span className="muted"> · sha {String(state.sha).slice(0, 10)}</span> : null}
                  </span>
                </label>
              )}

              <div className="muted small">
                Answered by account #{result.profile}. Claude ran locked to a throwaway sandbox on copies only — no live files were touched.
              </div>
              <div className="analyze-actions">
                <button className="btn ghost" onClick={onClose}>Dismiss</button>
                {ui.action && (
                  <button
                    className={`btn ${ui.actCls}`}
                    disabled={!canAct}
                    title={canAct ? `Apply Claude's proposal: ${ui.action}` : 'Proposed action is not available for this file'}
                    onClick={() => onApply(result.outcome, applyAll ? applicable : [])}
                  >
                    {ui.action}{nExtra ? ` · ${nExtra + 1} files` : ''}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentsModal({ website, busy, onStart, onClose }) {
  const [count, setCount] = useState(2);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal small" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>✦ Claude automation · {website}</h3>
          <button className="btn ghost" disabled={busy} onClick={onClose}>Close</button>
        </div>
        <div className="modal-body pad">
          <p className="muted">
            Spawns agents that work through this site's unresolved changed files, one file at a time:
            files the local classifier deems safe (known-good checksum or low risk) are marked fixed;
            the rest are triaged by <code>claude -p</code> in the hardened sandbox and the proposal is
            applied — <b>keep</b> → mark fixed, <b>revert</b> → overwrite from left, <b>delete</b> → delete right —
            including every byte-identical copy. Uncertain files are left for a human. Every change is
            attributed to the agent, backed up to /evidence and broadcast live.
          </p>
          <div className="agent-count">
            <span className="muted">Agents to spawn</span>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} className={`chip ${count === n ? 'active' : ''}`} disabled={busy} onClick={() => setCount(n)}>{n}</button>
            ))}
          </div>
          <div className="muted small">
            More agents = more files processed in parallel — they share the logged-in Claude accounts.
            The same ✦ button stops them while they run.
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={() => onStart(count)}>
            {busy ? 'Starting…' : `Start ${count} agent${count === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function PatchModal({ website, form, setForm, busy, result, onRun, onClose }) {
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal small" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Patch JCE → 2.9.99.8 · {website}</h3>
          <button className="btn ghost" disabled={busy} onClick={onClose}>Close</button>
        </div>
        <div className="modal-body pad">
          <p className="muted">
            Temporarily drops the remediation tool + packages into this site's docroot on the right,
            drives it over HTTP (preflight → install → verify), then removes them. TLS is not verified.
          </p>
          <div className="field-row">
            <label className="field">Base URL (site docroot)
              <input autoFocus placeholder="https://example.com" value={form.baseUrl} onChange={set('baseUrl')} spellCheck={false} disabled={busy} />
            </label>
            <label className="field" style={{ flex: '0 0 40%' }}>Host IP (optional)
              <input placeholder="e.g. 203.0.113.5" value={form.ip} onChange={set('ip')} spellCheck={false} disabled={busy} autoComplete="off" />
            </label>
          </div>
          <div className="muted small">If set, the connection dials this IP while keeping the URL's hostname for <code>Host</code>/SNI (bypass DNS/CDN/WAF — hit the origin). Port comes from the scheme.</div>
          <div className="field-row">
            <label className="field">Basic auth user (optional)
              <input value={form.basicUser} onChange={set('basicUser')} spellCheck={false} disabled={busy} autoComplete="off" />
            </label>
            <label className="field">Basic auth password (optional)
              <input type="password" value={form.basicPass} onChange={set('basicPass')} disabled={busy} autoComplete="off" />
            </label>
          </div>
          {result && (
            <div className={`patch-result ${result.status}`}>
              <div>
                <b>{result.status}</b>
                {result.package ? ` · ${result.package}` : ''}
                {result.jce_before || result.jce_after ? ` · JCE ${result.jce_before || '?'} → ${result.jce_after || '?'}` : ''}
                {result.php_version ? ` · PHP ${result.php_version}` : ''}
              </div>
              {result.note ? <div className="note">{result.note}</div> : null}
              {result.detail && result.detail.dropper_url ? <div className="mono muted">tried: {result.detail.dropper_url}{result.detail.connect_ip ? ` (via ${result.detail.connect_ip})` : ''}</div> : null}
              {result.detail && result.detail.phases ? (
                <div className="phases">
                  {['preflight', 'install', 'verify'].map((k) => (result.detail.phases[k]
                    ? <span key={k} className={`phase-chip ${result.detail.phases[k].json ? 'ok' : 'bad'}`}>{k} · HTTP {result.detail.phases[k].http_status ?? '—'}</span>
                    : null))}
                </div>
              ) : null}
              <div className="muted small">Full server log: <code>docker compose logs -f</code></div>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span className="muted">{busy ? 'running… (install can take a minute)' : 'target 2.9.99.8'}</span>
          <button className="btn primary" disabled={busy || !form.baseUrl.trim()} onClick={onRun}>
            {busy ? 'Patching…' : 'Patch now'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SideBody({ side, path, docKey }) {
  if (!side || !side.exists) return <div className="loading">file not present on this side.</div>;
  if (side.tooLarge) return <div className="loading">file too large to display ({side.size} bytes).</div>;
  return <CodeView value={side.content} path={path} docKey={docKey} />;
}

function JoomlaBody({ joomla, current, currentSide, path, version, docKey }) {
  if (!joomla || joomla.loading) return <div className="loading">looking up {version}…</div>;
  if (joomla.error) return <div className="loading">Joomla lookup failed: {joomla.error}</div>;
  if (!joomla.exists) return <div className="loading">No matching file in <b>{version}</b> — this path is not part of that Joomla version’s core (custom file, or wrong version).</div>;
  if (joomla.tooLarge) return <div className="loading">pristine file too large to display ({joomla.size} bytes).</div>;
  const cur = current && current.exists ? current.content : '';
  return (
    <div className="joomla-wrap">
      <div className="joomla-note">
        pristine <code>{version}/{joomla.joomlaPath}</code> &nbsp;→&nbsp; current <b>{currentSide}</b> file
        {(!current || !current.exists) && ' (current side missing — showing empty)'}
      </div>
      <div className="joomla-diff"><DiffView left={joomla.content} right={cur} path={path} docKey={docKey} /></div>
    </div>
  );
}

function JceBody({ jce, current, currentSide, path, version, docKey }) {
  if (!jce || jce.loading) return <div className="loading">looking up pristine JCE source…</div>;
  if (jce.error) return <div className="loading">JCE lookup failed: {jce.error}</div>;
  if (!jce.exists) return <div className="loading">Not part of the JCE package — this path doesn’t match a file in the selected JCE source (not a JCE file, or renamed).</div>;
  if (jce.tooLarge) return <div className="loading">pristine file too large to display ({jce.size} bytes).</div>;
  const cur = current && current.exists ? current.content : '';
  return (
    <div className="joomla-wrap">
      <div className="joomla-note">
        pristine JCE <code>{jce.jcePath}</code> &nbsp;→&nbsp; current <b>{currentSide}</b> file
        {(!current || !current.exists) && ' (current side missing — showing empty)'}
      </div>
      <div className="joomla-diff"><DiffView left={jce.content} right={cur} path={path} docKey={docKey} /></div>
    </div>
  );
}

function SameShaModal({ sha, files, action, onConfirm, onClose }) {
  const n = files.length;
  const cfg = ({
    fixed: { title: `${n} other file${n === 1 ? '' : 's'} with the same checksum`, sub: `Byte-identical to the file you just marked fixed.`, btn: `Mark all ${n} fixed`, cls: 'fixed-toggle on' },
    delete: { title: `${n} identical file${n === 1 ? '' : 's'} elsewhere`, sub: `The same file (same sha256) exists on other sites — delete them too? Each is backed up to /evidence.`, btn: `Delete all ${n}`, cls: 'danger' },
    edit: { title: `${n} identical file${n === 1 ? '' : 's'} elsewhere`, sub: `Apply the same edit (overwrite with your new content) to these identical files? Each is backed up to /evidence.`, btn: `Apply to all ${n}`, cls: 'primary' },
  })[action] || {};
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal small" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{cfg.title}</h3>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <div className="modal-body pad">
          <div className="muted mono">sha256 {String(sha).slice(0, 16)}…</div>
          <div className="sha-list">
            {files.map((f) => (
              <div key={f.absolute_path} className="sha-row" title={f.absolute_path}>
                <span className={`badge ${f.status}`}>{f.status.charAt(0).toUpperCase()}</span>
                <span className="mono">{f.website} / {f.filename}</span>
              </div>
            ))}
          </div>
          <div className="muted small">{cfg.sub}</div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Not now</button>
          <button className={`btn ${cfg.cls}`} onClick={onConfirm}>{cfg.btn}</button>
        </div>
      </div>
    </div>
  );
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
