import React, { useMemo, useState } from 'react';

const STATUS_LABEL = { added: 'A', modified: 'M', deleted: 'D' };

function matches(file, website, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  return website.toLowerCase().includes(s)
    || file.filename.toLowerCase().includes(s)
    || file.absolute_path.toLowerCase().includes(s);
}

export function Sidebar({ data, query, setQuery, statusFilter, setStatusFilter, selected, onSelect, handled }) {
  // Websites are collapsed by default; toggling flips an entry in `expanded`.
  // While a search/filter is active we force-expand so matches stay visible.
  const [expanded, setExpanded] = useState({});
  const filtering = query.trim() !== '' || statusFilter !== 'all';

  const websites = useMemo(() => {
    if (!data) return [];
    return data.websites
      .map((w) => ({
        ...w,
        files: w.files.filter((f) => (statusFilter === 'all' || f.status === statusFilter) && matches(f, w.name, query)),
      }))
      .filter((w) => w.files.length > 0 || (query === '' && statusFilter === 'all'));
  }, [data, query, statusFilter]);

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
          <button
            key={s}
            className={`chip ${s} ${statusFilter === s ? 'active' : ''}`}
            onClick={() => setStatusFilter(s)}
          >
            {s}
            {data && s !== 'all' ? ` ${data.totals[s]}` : ''}
          </button>
        ))}
      </div>

      <div className="tree">
        {websites.map((w) => {
          const isCollapsed = filtering ? false : !expanded[w.name];
          return (
            <div className="site" key={w.name}>
              <div className="site-head" onClick={() => setExpanded((e) => ({ ...e, [w.name]: !e[w.name] }))}>
                <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
                <span className="site-name" title={w.name}>{w.name}</span>
                <span className="site-counts">
                  {w.counts.added > 0 && <span className="dot added" title="added">{w.counts.added}</span>}
                  {w.counts.modified > 0 && <span className="dot modified" title="modified">{w.counts.modified}</span>}
                  {w.counts.deleted > 0 && <span className="dot deleted" title="deleted">{w.counts.deleted}</span>}
                </span>
              </div>
              {!isCollapsed && (
                <div className="files">
                  {w.files.map((f) => {
                    const h = handled[f.absolute_path];
                    const isSel = selected && selected.absolute_path === f.absolute_path;
                    return (
                      <div
                        key={f.absolute_path}
                        className={`file ${f.status} ${isSel ? 'selected' : ''} ${h ? 'handled' : ''}`}
                        onClick={() => onSelect(f)}
                        title={f.absolute_path}
                      >
                        <span className={`badge ${f.status}`}>{STATUS_LABEL[f.status]}</span>
                        <span className="fname">{f.filename}</span>
                        {h && <span className="tick" title={`${h.op} @ ${h.at}`}>✔</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {data && websites.length === 0 && <div className="empty">No matches.</div>}
      </div>
    </aside>
  );
}
