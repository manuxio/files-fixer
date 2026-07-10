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
  files: ({ website, status, q, sort, offset = 0, limit = 200 } = {}) => {
    const p = new URLSearchParams();
    if (website) p.set('website', website);
    if (status && status !== 'all') p.set('status', status);
    if (q) p.set('q', q);
    if (sort) p.set('sort', sort);
    p.set('offset', offset);
    p.set('limit', limit);
    return j('/api/files?' + p.toString());
  },
  file: (side, path) => j(`/api/file?side=${side}&path=${encodeURIComponent(path)}`),
  del: (path, operator, note) => post('/api/delete', { path, operator, note }),
  overwrite: (path, operator, note) => post('/api/overwrite', { path, operator, note }),
  save: (path, content, operator, note) => post('/api/save', { path, content, operator, note }),
  setFixed: (path, fixed, operator, note) => post('/api/fixed', { path, fixed, operator, note }),
  sameSha: (path) => j(`/api/same-sha?path=${encodeURIComponent(path)}`),
  presence: (operator, path, mode) => post('/api/presence', { operator, path, mode }),
  eventsUrl: () => '/api/events?clientId=' + encodeURIComponent(clientId),
  joomlaVersions: () => j('/api/joomla/versions'),
  joomlaFile: (version, path) => j(`/api/joomla/file?version=${encodeURIComponent(version)}&path=${encodeURIComponent(path)}`),
  jceStatus: () => j('/api/jce/status'),
  jceSources: () => j('/api/jce/sources'),
  jceSrcFile: (version, path) => j(`/api/jce/file?version=${encodeURIComponent(version)}&path=${encodeURIComponent(path)}`),
  patchJce: ({ website, baseUrl, ip, basicUser, basicPass, operator }) =>
    post('/api/patch-jce', { website, baseUrl, ip, basicUser, basicPass, operator }),
  audit: () => j('/api/audit'),
  // restore / undo from a backup snapshot
  backups: (limit) => j('/api/backups' + (limit ? '?limit=' + limit : '')),
  restore: (backup, operator, note) => post('/api/restore', { backup, operator, note }),
  // claude web shell
  claudeStatus: () => j('/api/claude/status'),
  claudeUsage: () => j('/api/claude/usage'),
  claudeAnalyze: (path) => post('/api/claude/analyze', { path }),
  // claude automation agents
  agents: () => j('/api/agents'),
  agentsStart: (website, count, operator) => post('/api/agents/start', { website, count, operator }),
  agentsStop: (website, operator) => post('/api/agents/stop', { website, operator }),
  // classifier rules
  rules: () => j('/api/rules'),
  ruleDisable: (id, disabled, operator) => post('/api/rules/disable', { id, disabled, operator }),
  ruleUpsert: (rule, operator) => post('/api/rules', { rule, operator }),
  ruleDelete: (id, operator) =>
    j('/api/rules/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'x-operator': operator || '' } }),
};
