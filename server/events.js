'use strict';
// Tiny Server-Sent-Events hub for multi-user live updates.
//   - broadcast(event, data): push to every connected browser
//   - presence: who is viewing/editing which file (pruned when stale)

const clients = new Map();   // clientId -> res (SSE response stream)
const presence = new Map();  // clientId -> { operator, path, mode, at }
const STALE_MS = 30000;

function addClient(id, res) { clients.set(id, res); }

function removeClient(id) {
  clients.delete(id);
  if (presence.delete(id)) broadcastPresence();
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients.values()) {
    try { res.write(payload); } catch { /* dead stream; cleaned up on close */ }
  }
}

function viewers() {
  const now = Date.now();
  for (const [id, p] of presence) if (now - Date.parse(p.at) > STALE_MS) presence.delete(id);
  return [...presence.entries()].map(([id, p]) => ({ id, operator: p.operator, path: p.path, mode: p.mode }));
}

function broadcastPresence() { broadcast('presence', { viewers: viewers() }); }

function setPresence(id, { operator, path, mode }) {
  presence.set(id, { operator: operator || '', path: path || null, mode: mode || null, at: new Date().toISOString() });
  broadcastPresence();
}

// Drop clients that went away without a clean close, so stale viewers disappear.
setInterval(() => {
  const before = presence.size;
  viewers();
  if (presence.size !== before) broadcastPresence();
}, 15000).unref();

module.exports = { addClient, removeClient, broadcast, broadcastPresence, setPresence, viewers };
