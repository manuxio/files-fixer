async function j(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// Stable per-tab id so the server can attribute events and skip echoing them back.
export const clientId = (window.crypto && crypto.randomUUID)
  ? crypto.randomUUID()
  : 'c' + Math.random().toString(36).slice(2);

const post = (url, body) =>
  j(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId, ...body }) });

export const api = {
  health: () => j('/api/health'),
  summary: (refresh) => j('/api/summary' + (refresh ? '?refresh=1' : '')),
  files: ({ website, status, q, offset = 0, limit = 200 } = {}) => {
    const p = new URLSearchParams();
    if (website) p.set('website', website);
    if (status && status !== 'all') p.set('status', status);
    if (q) p.set('q', q);
    p.set('offset', offset);
    p.set('limit', limit);
    return j('/api/files?' + p.toString());
  },
  file: (side, path) => j(`/api/file?side=${side}&path=${encodeURIComponent(path)}`),
  del: (path, operator, note) => post('/api/delete', { path, operator, note }),
  overwrite: (path, operator, note) => post('/api/overwrite', { path, operator, note }),
  save: (path, content, operator, note) => post('/api/save', { path, content, operator, note }),
  setFixed: (path, fixed, operator, note) => post('/api/fixed', { path, fixed, operator, note }),
  presence: (operator, path, mode) => post('/api/presence', { operator, path, mode }),
  eventsUrl: () => '/api/events?clientId=' + encodeURIComponent(clientId),
  joomlaVersions: () => j('/api/joomla/versions'),
  joomlaFile: (version, path) => j(`/api/joomla/file?version=${encodeURIComponent(version)}&path=${encodeURIComponent(path)}`),
  audit: () => j('/api/audit'),
};
