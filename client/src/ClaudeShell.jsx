import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from './api.js';

// Dark theme tuned to the app's palette.
const THEME = {
  background: '#0e1116', foreground: '#d6deeb', cursor: '#7dd3fc',
  selectionBackground: '#264f78', black: '#1b1f27', brightBlack: '#5c6773',
};

function wsUrl(profile, path, cols, rows) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const p = new URLSearchParams({ profile: String(profile), path: String(path || ''), cols: String(cols), rows: String(rows) });
  return `${proto}://${location.host}/api/terminal?${p.toString()}`;
}

// The live terminal for one profile session. Remounts (fresh key) on restart /
// profile switch so xterm + socket are torn down and rebuilt cleanly.
function TerminalPane({ profile, path, onEnded, onBusy }) {
  const hostRef = useRef(null);
  // Keep the latest callbacks without them being effect dependencies — otherwise
  // a parent re-render (new inline callback) would tear down and respawn Claude.
  const endedRef = useRef(onEnded); endedRef.current = onEnded;
  const busyRef = useRef(onBusy); busyRef.current = onBusy;
  const fireEnded = useCallback(() => { if (endedRef.current) endedRef.current(); }, []);
  const fireBusy = useCallback((next) => { if (busyRef.current) busyRef.current(next); }, []);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true, fontSize: 13, scrollback: 5000, convertEol: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    try { fit.fit(); } catch { /* not laid out yet */ }
    term.focus();

    const ws = new WebSocket(wsUrl(profile, path, term.cols, term.rows));
    ws.binaryType = 'arraybuffer';
    let alive = true;

    const dim = (s) => term.writeln(`\x1b[2m${s}\x1b[0m`);
    dim(`connecting to Claude · profile #${profile}…`);

    ws.onopen = () => {
      // Push a real resize so the PTY matches the fitted terminal.
      const send = () => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows })); };
      send();
      term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'i', d })); });
      term.onResize(({ cols, rows }) => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'r', cols, rows })); });
    };
    let bounced = false;
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { term.write(new Uint8Array(ev.data)); return; }
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'busy') { bounced = true; alive = false; fireBusy(msg.next); }
      else if (msg.t === 'status') dim(`[${msg.level || 'info'}] ${msg.d}`);
      else if (msg.t === 'exit') { dim(`\r\nClaude exited (code ${msg.code}).`); fireEnded(); }
    };
    ws.onclose = () => { if (alive && !bounced) { dim('\r\n\x1b[33m— disconnected —\x1b[0m'); fireEnded(); } };
    ws.onerror = () => dim('\r\n\x1b[31mconnection error\x1b[0m');

    // Keep the PTY sized to the pane.
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* ignore */ } });
    ro.observe(hostRef.current);

    return () => {
      alive = false;
      ro.disconnect();
      try { ws.close(); } catch { /* already */ }
      term.dispose();
    };
  }, [profile, path, fireEnded, fireBusy]);

  return <div className="cs-term" ref={hostRef} />;
}

const baseName = (p) => (p ? String(p).replace(/\\/g, '/').split('/').pop() : '');

export function ClaudeShellModal({ file, onClose }) {
  const filePath = file && file.absolute_path;
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState('');
  const [session, setSession] = useState(null); // { profile, key }
  const [ended, setEnded] = useState(false);
  const [notice, setNotice] = useState('');

  const reloadStatus = useCallback(() => {
    setErr('');
    return api.claudeStatus().then((s) => { setStatus(s); return s; }).catch((e) => { setErr(String(e.message || e)); return null; });
  }, []);
  useEffect(() => { reloadStatus(); }, [reloadStatus]);

  // Esc closes when not in a live session (so it can't clobber Claude's own Esc).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !session) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, onClose]);

  const start = useCallback((profile) => { if (!profile) return; setNotice(''); setEnded(false); setSession({ profile, key: Date.now() }); }, []);
  const restart = useCallback(() => { setEnded(false); setSession((s) => ({ profile: s.profile, key: Date.now() })); }, []);
  const back = useCallback(() => { setSession(null); setEnded(false); reloadStatus(); }, [reloadStatus]);
  // Server refused (only possible if a per-profile cap is configured): rotate.
  const onBusy = useCallback((next) => {
    setSession(null); setEnded(false);
    reloadStatus();
    setNotice(next ? `That account is at its configured cap — try #${next}.` : 'All accounts are at capacity.');
  }, [reloadStatus]);

  const profiles = (status && status.profiles) || [];
  const disabled = status && (!status.enabled || !status.available);
  const next = (status && status.next) || (profiles[0] && profiles[0].id) || 1;

  return (
    <div className="modal-backdrop" onClick={() => { if (!session) onClose(); }}>
      <div className="modal cs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            Claude web shell
            {file && <span className="cs-badge" title={filePath}>{baseName(filePath)}</span>}
            {session && <span className="cs-badge">profile #{session.profile}</span>}
          </h3>
          <div className="cs-head-actions">
            {session && <button className="btn ghost" onClick={back} title="Choose a different profile">Profiles</button>}
            {session && ended && <button className="btn" onClick={restart}>Restart</button>}
            {session && !ended && <button className="btn ghost" onClick={restart} title="Kill this session and start a fresh one">Restart</button>}
            <button className="btn ghost" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="modal-body cs-body">
          {err && <div className="banner err">Could not load shell status: {err}</div>}
          {!status && !err && <div className="cs-msg muted">loading…</div>}

          {status && disabled && (
            <div className="cs-msg">
              <p><b>The Claude web shell is unavailable.</b></p>
              <p className="muted">
                {!status.enabled ? 'Disabled via CLAUDE_SHELL=0.' : `Server reason: ${status.reason || 'node-pty not available'}.`}
              </p>
            </div>
          )}

          {status && !disabled && !session && (
            <div className="cs-pick">
              <p className="muted">
                Opens a <b>hardened, disposable</b> Claude session for <code>{baseName(filePath)}</code>.
                The file is copied into a throwaway sandbox dir as <code>current.ext</code> (and the
                baseline as <code>previous.ext</code>); Claude is locked to that dir and destroyed on
                close. Each profile is a <b>separate Claude account</b> — sessions are independent and
                any account can be reused any time; new sessions just rotate across accounts to spread
                credit usage.
                {status.idleMs > 0 && <> Idle sessions auto-close after {Math.round(status.idleMs / 60000)} min.</>}
              </p>

              {notice && <div className="banner warn">{notice}</div>}

              <div className="cs-rr">
                <button className="btn primary" onClick={() => start(next)}>
                  Open session · account #{next}
                </button>
                <button className="btn ghost" onClick={reloadStatus} title="Refresh account status">Refresh</button>
              </div>

              <div className="cs-profiles">
                {profiles.map((p) => (
                  <button
                    key={p.id}
                    className={`cs-profile ${p.id === next ? 'next' : ''}`}
                    title={`open a session on account #${p.id}${p.sessions ? ` (${p.sessions} running)` : ''}`}
                    onClick={() => start(p.id)}
                  >
                    <span className="cs-profile-n">#{p.id}</span>
                    <span className={`cs-profile-state ${p.configured ? 'on' : ''}`}>
                      {p.configured ? (p.sessions ? `${p.sessions} running` : 'ready') : 'not logged in'}
                    </span>
                    {p.id === next && <span className="cs-profile-tag">next</span>}
                  </button>
                ))}
              </div>

              <p className="muted small">
                First use of a profile: run <code>/login</code> inside the session (or it will prompt),
                then accept the <b>trust this folder</b> prompt. Credentials persist in the mounted
                <code>/claude-profiles</code> volume; the sandbox dir does not.
              </p>
            </div>
          )}

          {status && !disabled && session && (
            <TerminalPane key={session.key} profile={session.profile} path={filePath} onEnded={() => setEnded(true)} onBusy={onBusy} />
          )}
        </div>
      </div>
    </div>
  );
}
