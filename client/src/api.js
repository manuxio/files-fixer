async function j(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const post = (url, body) =>
  j(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  health: () => j('/api/health'),
  diff: (refresh) => j('/api/diff' + (refresh ? '?refresh=1' : '')),
  file: (side, path) => j(`/api/file?side=${side}&path=${encodeURIComponent(path)}`),
  del: (path, operator, note) => post('/api/delete', { path, operator, note }),
  overwrite: (path, operator, note) => post('/api/overwrite', { path, operator, note }),
  save: (path, content, operator, note) => post('/api/save', { path, content, operator, note }),
  setFixed: (path, fixed, operator, note) => post('/api/fixed', { path, fixed, operator, note }),
  audit: () => j('/api/audit'),
};
