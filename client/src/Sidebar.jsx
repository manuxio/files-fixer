import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

const STATUS_LABEL = { added: 'A', modified: 'M', deleted: 'D' };
const LIMIT = 200;

function FileRow({ f, selected, onSelect, isFixed, viewers }) {
  const fx = isFixed(f);
  const isSel = selected && selected.absolute_path === f.absolute_path;
  const editing = viewers && viewers.some((v) => v.mode === 'edit');
  return (
    <div
      className={`file ${f.status} ${isSel ? 'selected' : ''} ${fx ? 'fixed' : ''}`}
      onClick={() => onSelect(f)}
      title={f.absolute_path}
    >
      <span className={`badge ${f.status}`}>{STATUS_LABEL[f.status]}</span>
      <span className="fname">{f.filename}</span>
      {viewers && viewers.length > 0 && (
        <span className={`viewer-badge ${editing ? 'on' : ''}`} title={'here now: ' + viewers.map((v) => `${v.operator || 'anon'}${v.mode === 'edit' ? ' (editing)' : ''}`).join(', ')}>👤</span>
      )}
      {fx && <span className="tick">✔</span>}
    </div>
  );
}

export function Sidebar({ summary, query, setQuery, statusFilter, setStatusFilter, selected, onSelect, isFixed, reloadToken, viewersByPath = {} }) {
  const [expanded, setExpanded] = useState({});
  const [browse, setBrowse] = useState({});   // name -> { files, total, offset, loading }
  const [search, setSearch] = useState(null); // { files, total, offset, loading }
  const [dq, setDq] = useState('');           // debounced query

  // debounce the search box
  useEffect(() => {
    const t = setTimeout(() => setDq(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // invalidate loaded pages when the status filter or dataset changes
  useEffect(() => { setBrowse({}); }, [statusFilter, reloadToken]);

  // search across all websites (paged), grouped by website in render
  useEffect(() => {
    if (!dq) { setSearch(null); return undefined; }
    let alive = true;
    setSearch({ files: [], total: 0, offset: 0, loading: true });
    api.files({ q: dq, status: statusFilter, offset: 0, limit: LIMIT })
      .then((r) => { if (alive) setSearch({ files: r.files, total: r.total, offset: r.files.length, loading: false }); })
      .catch(() => { if (alive) setSearch({ files: [], total: 0, offset: 0, loading: false }); });
    return () => { alive = false; };
  }, [dq, statusFilter, reloadToken]);

  const ensureBrowse = (name) => {
    setBrowse((prev) => {
      if (prev[name]) return prev;
      api.files({ website: name, status: statusFilter, offset: 0, limit: LIMIT })
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

  const loadMoreBrowse = (name) => {
    const cur = browse[name];
    if (!cur || cur.loading) return;
    setBrowse((b) => ({ ...b, [name]: { ...cur, loading: true } }));
    api.files({ website: name, status: statusFilter, offset: cur.offset, limit: LIMIT })
      .then((r) => setBrowse((b) => ({ ...b, [name]: { files: [...cur.files, ...r.files], total: r.total, offset: cur.offset + r.files.length, loading: false } })));
  };

  const loadMoreSearch = () => {
    if (!search || search.loading) return;
    setSearch((s) => ({ ...s, loading: true }));
    api.files({ q: dq, status: statusFilter, offset: search.offset, limit: LIMIT })
      .then((r) => setSearch((s) => ({ files: [...s.files, ...r.files], total: r.total, offset: s.offset + r.files.length, loading: false })));
  };

  // websites to show in browse mode (hide those with 0 for the active filter)
  const sites = useMemo(() => {
    if (!summary) return [];
    return summary.websites.filter((w) =>
      statusFilter === 'all'
        ? (w.counts.added + w.counts.modified + w.counts.deleted) > 0
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
                <div className="site-head static"><span className="site-name" title={g.name}>{g.name}</span></div>
                <div className="files">
                  {g.files.map((f) => <FileRow key={f.absolute_path} f={f} selected={selected} onSelect={onSelect} isFixed={isFixed} viewers={viewersByPath[f.absolute_path]} />)}
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
          return (
            <div className="site" key={w.name}>
              <div className="site-head" onClick={() => toggleSite(w.name)}>
                <span className="caret">{isOpen ? '▾' : '▸'}</span>
                <span className="site-name" title={w.name}>{w.name}</span>
                <Counts c={w.counts} />
              </div>
              {isOpen && (
                <div className="files">
                  {page && page.loading && page.files.length === 0 && <div className="loading small">loading…</div>}
                  {page && page.files.map((f) => <FileRow key={f.absolute_path} f={f} selected={selected} onSelect={onSelect} isFixed={isFixed} viewers={viewersByPath[f.absolute_path]} />)}
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
