import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

const STATUS_LABEL = { added: 'A', modified: 'M', deleted: 'D' };
const LIMIT = 200;

// Harmfulness score badge (0–100), coloured by band. Advisory — a tooltip lists
// the rules that fired so the reviewer can judge the suggestion.
export function RiskChip({ risk }) {
  if (!risk) return null;
  const title = `harmfulness ${risk.score}/100 · ${risk.band} (${risk.tier})`
    + (risk.reasons && risk.reasons.length ? '\n' + risk.reasons.map((r) => `• ${r.name} (${r.weight > 0 ? '+' : ''}${r.weight})`).join('\n') : '');
  return <span className={`risk-chip band-${risk.band}`} title={title}>{risk.score}</span>;
}

function FileRow({ f, selected, onSelect, isFixed, viewers, checked, onToggle }) {
  const fx = isFixed(f);
  const isSel = selected && selected.absolute_path === f.absolute_path;
  const humans = (viewers || []).filter((v) => v.kind !== 'agent');
  const agents = (viewers || []).filter((v) => v.kind === 'agent');
  const editing = humans.some((v) => v.mode === 'edit');
  return (
    <div
      className={`file ${f.status} ${isSel ? 'selected' : ''} ${fx ? 'fixed' : ''} ${checked ? 'checked' : ''}`}
      onClick={() => onSelect(f)}
      title={f.absolute_path}
    >
      <input
        type="checkbox" className="file-check" checked={!!checked}
        onClick={(e) => e.stopPropagation()} onChange={() => onToggle && onToggle(f)}
      />
      <span className={`badge ${f.status}`}>{STATUS_LABEL[f.status]}</span>
      <RiskChip risk={f.risk} />
      <span className="fname">{f.filename}</span>
      {humans.length > 0 && (
        <span className={`viewer-badge ${editing ? 'on' : ''}`} title={'here now: ' + humans.map((v) => `${v.operator || 'anon'}${v.mode === 'edit' ? ' (editing)' : ''}`).join(', ')}>👤</span>
      )}
      {agents.length > 0 && (
        <span className="agent-badge" title={'Claude agent working here: ' + agents.map((v) => v.operator || 'Claude').join(', ')}>✦</span>
      )}
      {fx && <span className="tick">✔</span>}
    </div>
  );
}

function PatchedLabel({ p }) {
  if (!p) return null;
  const cls = p.status === 'patched' || p.status === 'already' ? 'ok' : 'bad';
  return <span className={`patched-label ${cls}`} title={`patched: JCE ${p.status}${p.jce ? ' ' + p.jce : ''}${p.at ? ' @ ' + p.at : ''}`}>&lt;P&gt;</span>;
}

export function Sidebar({ summary, query, setQuery, statusFilter, setStatusFilter, selected, onSelect, isFixed, reloadToken, viewersByPath = {}, patchedMap = {}, agentRuns = {}, onAgents = null, onPatch = null, onRefreshSite = null, multiSel = {}, onToggleMulti = null }) {
  const [expanded, setExpanded] = useState({});
  const [browse, setBrowse] = useState({});   // name -> { files, total, offset, loading }
  const [search, setSearch] = useState(null); // { files, total, offset, loading }
  const [dq, setDq] = useState('');           // debounced query
  const [sort, setSort] = useState('risk');   // 'risk' (harmful first) | 'name'

  // debounce the search box
  useEffect(() => {
    const t = setTimeout(() => setDq(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // invalidate loaded pages when the status filter, sort, or dataset changes
  useEffect(() => { setBrowse({}); }, [statusFilter, sort, reloadToken]);

  // search across all websites (paged), grouped by website in render
  useEffect(() => {
    if (!dq) { setSearch(null); return undefined; }
    let alive = true;
    setSearch({ files: [], total: 0, offset: 0, loading: true });
    api.files({ q: dq, status: statusFilter, sort, offset: 0, limit: LIMIT })
      .then((r) => { if (alive) setSearch({ files: r.files, total: r.total, offset: r.files.length, loading: false }); })
      .catch(() => { if (alive) setSearch({ files: [], total: 0, offset: 0, loading: false }); });
    return () => { alive = false; };
  }, [dq, statusFilter, sort, reloadToken]);

  const ensureBrowse = (name) => {
    setBrowse((prev) => {
      if (prev[name]) return prev;
      api.files({ website: name, status: statusFilter, sort, offset: 0, limit: LIMIT })
        .then((r) => setBrowse((b) => ({ ...b, [name]: { files: r.files, total: r.total, offset: r.files.length, loading: false } })))
        .catch(() => setBrowse((b) => ({ ...b, [name]: { files: [], total: 0, offset: 0, loading: false } })));
      return { ...prev, [name]: { files: [], total: 0, offset: 0, loading: true } };
    });
  };

  const toggleSite = (name) => {
    const willExpand = !expanded[name];
    setExpanded((e) => ({ ...e, [name]: willExpand }));
    if (willExpand) ensureBrowse(name);
  };

  // Per-folder refresh: reload just this folder's file page from the server and
  // ask the parent to refresh its counts — a light re-sync for one directory,
  // without the global "Refresh CSVs" full recompute.
  const refreshSite = (name) => {
    setBrowse((b) => ({ ...b, [name]: { ...(b[name] || { files: [], total: 0, offset: 0 }), loading: true } }));
    api.files({ website: name, status: statusFilter, sort, offset: 0, limit: LIMIT })
      .then((r) => setBrowse((b) => ({ ...b, [name]: { files: r.files, total: r.total, offset: r.files.length, loading: false } })))
      .catch(() => setBrowse((b) => ({ ...b, [name]: { ...(b[name] || { files: [], total: 0, offset: 0 }), loading: false } })));
    if (onRefreshSite) onRefreshSite(name);
  };

  const loadMoreBrowse = (name) => {
    const cur = browse[name];
    if (!cur || cur.loading) return;
    setBrowse((b) => ({ ...b, [name]: { ...cur, loading: true } }));
    api.files({ website: name, status: statusFilter, sort, offset: cur.offset, limit: LIMIT })
      .then((r) => setBrowse((b) => ({ ...b, [name]: { files: [...cur.files, ...r.files], total: r.total, offset: cur.offset + r.files.length, loading: false } })));
  };

  const loadMoreSearch = () => {
    if (!search || search.loading) return;
    setSearch((s) => ({ ...s, loading: true }));
    api.files({ q: dq, status: statusFilter, sort, offset: search.offset, limit: LIMIT })
      .then((r) => setSearch((s) => ({ files: [...s.files, ...r.files], total: r.total, offset: s.offset + r.files.length, loading: false })));
  };

  // websites to show in browse mode (hide those with 0 for the active filter)
  const sites = useMemo(() => {
    if (!summary) return [];
    return summary.websites.filter((w) =>
      statusFilter === 'all'
        ? (w.counts.added + w.counts.modified + w.counts.deleted + (w.counts.fixed || 0)) > 0
        : w.counts[statusFilter] > 0);
  }, [summary, statusFilter]);

  // group search results by website, preserving server order
  const searchGroups = useMemo(() => {
    if (!search) return [];
    const map = new Map();
    for (const f of search.files) {
      if (!map.has(f.website)) map.set(f.website, []);
      map.get(f.website).push(f);
    }
    return [...map.entries()].map(([name, files]) => ({ name, files }));
  }, [search]);

  const Counts = ({ c }) => (
    <span className="site-counts">
      {c.added > 0 && <span className="dot added" title="added">{c.added}</span>}
      {c.modified > 0 && <span className="dot modified" title="modified">{c.modified}</span>}
      {c.deleted > 0 && <span className="dot deleted" title="deleted">{c.deleted}</span>}
      {c.fixed > 0 && <span className="dot fixedcount" title="fixed">✔{c.fixed}</span>}
    </span>
  );

  return (
    <aside className="sidebar">
      <div className="brand">files-fixer</div>

      <input
        className="search"
        placeholder="Search website or filename…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
      />

      <div className="filters">
        {['all', 'added', 'modified', 'deleted'].map((s) => (
          <button key={s} className={`chip ${s} ${statusFilter === s ? 'active' : ''}`} onClick={() => setStatusFilter(s)}>
            {s}{summary && s !== 'all' ? ` ${summary.totals[s]}` : ''}
          </button>
        ))}
      </div>

      <div className="sort-row">
        <span className="sort-label">sort</span>
        <button className={`chip ${sort === 'risk' ? 'active' : ''}`} onClick={() => setSort('risk')} title="Most harmful first (server-scored)">⚠ risk</button>
        <button className={`chip ${sort === 'name' ? 'active' : ''}`} onClick={() => setSort('name')} title="Alphabetical by path">name</button>
      </div>

      <div className="tree">
        {!summary && <div className="empty">loading…</div>}

        {/* search mode */}
        {summary && dq && (
          <>
            <div className="search-head">
              {search && search.loading && search.files.length === 0
                ? 'searching…'
                : `${search ? search.total : 0} match${search && search.total === 1 ? '' : 'es'} for "${dq}"`}
            </div>
            {searchGroups.map((g) => (
              <div className="site" key={g.name}>
                <div className="site-head static"><span className="site-name" title={g.name}>{g.name}</span><PatchedLabel p={patchedMap[g.name]} /></div>
                <div className="files">
                  {g.files.map((f) => <FileRow key={f.absolute_path} f={f} selected={selected} onSelect={onSelect} isFixed={isFixed} viewers={viewersByPath[f.absolute_path]} checked={!!multiSel[f.absolute_path]} onToggle={onToggleMulti} />)}
                </div>
              </div>
            ))}
            {search && search.files.length < search.total && (
              <button className="load-more" disabled={search.loading} onClick={loadMoreSearch}>
                {search.loading ? 'loading…' : `Load more (${search.total - search.files.length} left)`}
              </button>
            )}
            {search && search.total === 0 && !search.loading && <div className="empty">No matches.</div>}
          </>
        )}

        {/* browse mode */}
        {summary && !dq && sites.map((w) => {
          const isOpen = !!expanded[w.name];
          const page = browse[w.name];
          const run = agentRuns[w.name];
          return (
            <div className="site" key={w.name}>
              <div className="site-head" onClick={() => toggleSite(w.name)}>
                <span className="caret">{isOpen ? '▾' : '▸'}</span>
                <span className="site-name" title={w.name}>{w.name}</span>
                <PatchedLabel p={patchedMap[w.name]} />
                {onRefreshSite && (
                  <button
                    className={`refresh-btn ${page && page.loading ? 'spinning' : ''}`}
                    title="Refresh this folder (reload its files & counts)"
                    onClick={(e) => { e.stopPropagation(); refreshSite(w.name); }}
                  >↻</button>
                )}
                {onAgents && (
                  <button
                    className={`agent-btn ${run ? 'running' : ''}`}
                    title={run
                      ? `${run.agents ? run.agents.length : run.count} Claude agent(s) working — ${run.stopping ? 'stopping…' : 'click to stop'}`
                      : 'Start Claude automation: agents triage & remediate this site\'s unresolved files'}
                    onClick={(e) => { e.stopPropagation(); onAgents(w.name); }}
                  >✦{run ? (run.agents ? run.agents.length : run.count) : ''}</button>
                )}
                {onPatch && (
                  <button
                    className="patch-btn" title="Patch JCE to 2.9.99.8"
                    onClick={(e) => { e.stopPropagation(); onPatch(w.name); }}
                  >⛨</button>
                )}
                <Counts c={w.counts} />
              </div>
              {isOpen && (
                <div className="files">
                  {page && page.loading && page.files.length === 0 && <div className="loading small">loading…</div>}
                  {page && page.files.map((f) => <FileRow key={f.absolute_path} f={f} selected={selected} onSelect={onSelect} isFixed={isFixed} viewers={viewersByPath[f.absolute_path]} checked={!!multiSel[f.absolute_path]} onToggle={onToggleMulti} />)}
                  {page && page.files.length < page.total && (
                    <button className="load-more" disabled={page.loading} onClick={() => loadMoreBrowse(w.name)}>
                      {page.loading ? 'loading…' : `Load more (${page.total - page.files.length} left)`}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {summary && !dq && sites.length === 0 && <div className="empty">No differences.</div>}
      </div>
    </aside>
  );
}
