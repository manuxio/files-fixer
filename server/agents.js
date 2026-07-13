'use strict';
// Claude-based automation: server-spawned "agents" that triage and remediate
// the unresolved changed files of ONE website. Each agent ("Claude 1"…"Claude N")
// loops:
//   1. claim the next changed file that is not fixed and not claimed by any
//      other agent (in-memory claim set — nothing is ever double-worked),
//   2. broadcast presence for that file (kind:'agent' → the UI renders ✦),
//   3. local classifier first: known-good sha or content-tier LOW band → mark
//      fixed without spending a Claude call,
//   4. otherwise escalate to terminal.analyze() (`claude -p` in the hardened
//      sandbox, unchanged) and apply the outcome:
//        keep → mark fixed · left → overwrite right from left · delete →
//        delete right · dontknow/uncertain → leave for a human (counted, not touched),
//      also applying the same action to every byte-identical file (same sha),
//   5. release the claim and continue until no work is left or the run is
//      stopped. A 429 from analyze() (all accounts at usage limits) stops the
//      whole run — agents never hammer exhausted accounts.
// All mutations go through actions.js (the same code the HTTP routes run), so
// audit records, backups and live SSE events are identical to a human's.

const fsp = require('fs/promises');
const config = require('./config');
const { getDiff, sameSha, findFile } = require('./diff');
const { resolveSide } = require('./paths');
const classify = require('./classify');
const knowngood = require('./knowngood');
const terminal = require('./terminal');
const actions = require('./actions');
const audit = require('./audit');
const events = require('./events');

const MAX_READ = 8 * 1024 * 1024; // same content cap as /api/file
const MAX_AGENTS = 5;
const MAX_CONSECUTIVE_ERRORS = 3; // an agent that keeps failing quits instead of burning through the queue

const runs = new Map();   // website -> run
const claims = new Set(); // absolute_path currently worked by ANY agent (across runs)

const auditPath = (website) => `${config.csvPrefix}/${website}/`;

function statusOf(run) {
  return {
    website: run.website,
    count: run.count,
    by: run.by,
    startedAt: run.startedAt,
    stopping: run.stopping,
    agents: [...run.agents.values()].map((a) => ({ name: a.name, path: a.path })),
    stats: { ...run.stats },
  };
}

function status() {
  const t = terminal.status();
  return {
    enabled: !!t.enabled,
    loggedIn: (t.profiles || []).some((p) => p.configured),
    maxAgents: MAX_AGENTS,
    runs: [...runs.values()].map(statusOf),
  };
}

const broadcastRun = (run, op) => events.broadcast('agents', { op, ...statusOf(run) });

// --- claiming --------------------------------------------------------------
// Files an agent can act on: not fixed, not claimed, not already handled this
// run. 'deleted' entries (left only — nothing on the right to keep/delete) are
// left for a human. The scan-and-claim has no await between check and add, so
// two agents can never claim the same path.
function claimNext(run, website) {
  for (const f of website.files) {
    if (f.fixed || f.status === 'deleted') continue;
    if (claims.has(f.absolute_path) || run.done.has(f.absolute_path)) continue;
    claims.add(f.absolute_path);
    return f;
  }
  return null;
}

// --- local classifier gate ---------------------------------------------------
// "Safe" = byte-identical to a pristine upstream file (known-good sha), or the
// CONTENT-tier score lands in the low band. Manifest-tier low is not enough to
// auto-resolve on — if the body cannot be read (missing/too large), escalate.
async function classifierVerdict(file) {
  const sha = classify.contentSha(file);
  if (knowngood.has(sha)) return { safe: true, why: 'known-good sha256 (pristine upstream file)' };
  try {
    const side = file.right ? 'right' : 'left';
    const full = resolveSide(side, file.absolute_path);
    const st = await fsp.stat(full);
    if (st.isFile() && st.size <= MAX_READ) {
      const body = await fsp.readFile(full, 'utf8');
      const risk = classify.scoreContent(file, body);
      if (risk.band === 'low') return { safe: true, why: `classifier low risk (${risk.score}/100, content tier)` };
      return { safe: false, risk };
    }
  } catch { /* unreadable — escalate to Claude */ }
  return { safe: false };
}

// --- acting on an outcome ----------------------------------------------------
// Same viability rules as the manual same-sha flow in the UI.
function siblingViable(m, outcome) {
  if (m.fixed) return false;
  if (outcome === 'delete') return m.status !== 'deleted'; // needs a right file
  if (outcome === 'left') return m.status === 'modified';  // needs a left baseline AND a right file
  return true; // keep: just mark fixed
}

async function applyOne(run, agent, abs, outcome, note) {
  if (outcome === 'keep') {
    await actions.setFixed(abs, true, agent.name, { note });
    run.stats.kept += 1;
  } else if (outcome === 'left') {
    await actions.overwriteFromLeft(abs, agent.name, { note });
    await actions.setFixed(abs, true, agent.name, { note });
    run.stats.reverted += 1;
  } else if (outcome === 'delete') {
    await actions.deleteRight(abs, agent.name, { note });
    await actions.setFixed(abs, true, agent.name, { note });
    run.stats.deleted += 1;
  }
  run.stats.processed += 1;
}

// Apply the decided outcome to every byte-identical file (any website). The
// sha index reads the CSV snapshot, so it still resolves after the original
// was deleted/overwritten on disk.
async function applySameSha(run, agent, abs, outcome, note) {
  let matches;
  try { matches = sameSha(abs).files; } catch { return; }
  for (const m of matches) {
    if (!siblingViable(m, outcome) || claims.has(m.absolute_path)) continue;
    claims.add(m.absolute_path);
    try {
      const cur = findFile(m.absolute_path); // re-check: a human may have handled it meanwhile
      if (!cur || cur.fixed) continue;
      await applyOne(run, agent, m.absolute_path, outcome, `${note} (same-sha as ${abs})`);
    } catch (e) {
      run.stats.errors += 1;
      console.error(`[agents] ${agent.name} same-sha ${m.absolute_path}: ${e.message}`);
    } finally {
      run.done.add(m.absolute_path);
      claims.delete(m.absolute_path);
    }
  }
}

// --- one file, start to finish ----------------------------------------------
async function processFile(run, agent, f) {
  const abs = f.absolute_path;
  // Re-check right before acting — a human (or a same-sha pass from another
  // run) may have resolved it since it was listed.
  const cur = findFile(abs);
  if (!cur || cur.fixed) { run.stats.skipped += 1; return; }

  const verdict = await classifierVerdict(cur);
  if (verdict.safe) {
    await actions.setFixed(abs, true, agent.name, { note: `agent: ${verdict.why}` });
    run.stats.safeFixed += 1;
    run.stats.processed += 1;
    return;
  }

  // Escalate to `claude -p` (hardened sandbox, prepared prompt — used as-is).
  const result = await terminal.analyze(abs); // throws 429 when every account is unavailable
  let outcome = result.outcome;
  const reason = (result.brief_reason || '').slice(0, 300);

  // 'left' needs a baseline to revert to; an added file has none — human call.
  if (outcome === 'left' && !cur.left) outcome = 'uncertain';

  // Claude abstained ('dontknow') or we couldn't parse a decision ('uncertain'):
  // leave the file unresolved for a human — never guess.
  if (outcome === 'dontknow' || outcome === 'uncertain') {
    run.stats.uncertain += 1;
    await audit.event({ operation: 'agent-uncertain', absPath: abs, actor: agent.name, note: `needs human review (${outcome}): ${reason}` });
    return;
  }

  const note = `agent: claude → ${outcome} (account #${result.profile}) — ${reason}`;
  await applyOne(run, agent, abs, outcome, note);
  await applySameSha(run, agent, abs, outcome, note);
}

// --- the agent loop ----------------------------------------------------------
async function agentLoop(run, agent) {
  try {
    while (!run.stopping) {
      let site;
      try { site = (await getDiff()).websites.find((w) => w.name === run.website); }
      catch (e) { console.error(`[agents] diff unavailable: ${e.message}`); break; }
      if (!site) break;
      const f = claimNext(run, site);
      if (!f) break; // nothing left that is unresolved, unclaimed and viable

      agent.path = f.absolute_path;
      events.setPresence(agent.clientId, { operator: agent.name, path: f.absolute_path, mode: 'agent', kind: 'agent' });
      broadcastRun(run, 'progress');

      try {
        await processFile(run, agent, f);
        agent.consecErrors = 0;
      } catch (e) {
        if (e.status === 429) {
          // Every Claude account is out (usage limits/credits): stop the whole
          // run cleanly instead of retrying — surface why.
          run.stopping = true;
          run.stopReason = 'all Claude accounts unavailable (usage limits) — automation stopped';
          run.stopKind = 'limit';
          console.error(`[agents] ${run.website}: ${e.message}`);
        } else {
          run.stats.errors += 1;
          agent.consecErrors = (agent.consecErrors || 0) + 1;
          const msg = (e.message || String(e)).slice(0, 300);
          if (run.errorLog.length < 20) run.errorLog.push({ path: f.absolute_path, agent: agent.name, message: msg });
          console.error(`[agents] ${agent.name} failed on ${f.absolute_path}: ${e.message}`);
        }
      } finally {
        run.done.add(f.absolute_path); // never re-claimed this run (uncertain/errors included)
        claims.delete(f.absolute_path);
        agent.path = null;
      }

      broadcastRun(run, 'progress');
      if (agent.consecErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`[agents] ${agent.name} quitting after ${agent.consecErrors} consecutive errors`);
        if (!run.stopReason) {
          run.stopReason = `an agent stopped after ${MAX_CONSECUTIVE_ERRORS} consecutive errors`;
          run.stopKind = 'error';
        }
        break;
      }
      await new Promise((r) => setImmediate(r)); // yield between files
    }
  } finally {
    run.agents.delete(agent.name);
    events.removePresence(agent.clientId);
    if (run.agents.size === 0) finishRun(run);
    else broadcastRun(run, 'progress');
  }
}

function finishRun(run) {
  runs.delete(run.website);
  const s = run.stats;
  const kind = run.stopKind || 'completed'; // completed | stopped | limit | error
  const reason = run.stopReason
    || (run.stopping ? 'stopped by operator' : 'finished — no unresolved files left to process');
  const summary = `${reason} · processed ${s.processed} (safe ${s.safeFixed}, keep ${s.kept}, revert ${s.reverted}, delete ${s.deleted}) · needs review ${s.uncertain} · errors ${s.errors}`;
  console.log(`[agents] ${run.website}: ${summary}`);
  audit.event({ operation: 'agents-stop', absPath: auditPath(run.website), actor: run.by, note: summary })
    .catch((e) => console.error('[agents] audit failed:', e.message));
  events.broadcast('agents', { op: 'stopped', website: run.website, reason, kind, stats: s, errorLog: run.errorLog, by: run.by });
}

// --- lifecycle ---------------------------------------------------------------
async function start(website, count, operator) {
  if (!config.claudeShell) { const e = new Error('Claude is disabled (CLAUDE_SHELL=0)'); e.status = 400; throw e; }
  if (runs.has(website)) { const e = new Error(`automation already running on ${website}`); e.status = 409; throw e; }
  const n = Math.min(MAX_AGENTS, Math.max(1, Number(count) || 1));

  const t = terminal.status();
  if (!(t.profiles || []).some((p) => p.configured)) {
    const e = new Error('no logged-in Claude account — open the shell and run /login on a profile first');
    e.status = 409; throw e;
  }

  const diff = await getDiff();
  const site = diff.websites.find((w) => w.name === website);
  if (!site) { const e = new Error(`unknown website: ${website}`); e.status = 404; throw e; }
  const workable = site.files.filter((f) => !f.fixed && f.status !== 'deleted' && !claims.has(f.absolute_path));
  if (!workable.length) { const e = new Error(`${website} has no unresolved files to process`); e.status = 400; throw e; }

  const run = {
    website,
    count: Math.min(n, workable.length),
    by: operator,
    startedAt: new Date().toISOString(),
    stopping: false,
    stopReason: null,
    stopKind: null, // completed | stopped | limit | error (set when the run ends)
    errorLog: [],   // { path, agent, message } per failed file (capped at 20) — surfaced in the finish popup
    agents: new Map(),
    done: new Set(), // paths this run already handled (incl. uncertain/errors) — never re-claimed
    stats: { processed: 0, safeFixed: 0, kept: 0, reverted: 0, deleted: 0, uncertain: 0, skipped: 0, errors: 0 },
  };
  runs.set(website, run);

  for (let i = 1; i <= run.count; i++) {
    const agent = { name: `Claude ${i}`, clientId: `agent:${website}:${i}`, path: null, consecErrors: 0 };
    run.agents.set(agent.name, agent);
  }

  await audit.event({ operation: 'agents-start', absPath: auditPath(website), actor: operator, note: `${run.count} agent(s), ${workable.length} unresolved file(s)` });
  broadcastRun(run, 'started');
  for (const agent of run.agents.values()) {
    agentLoop(run, agent).catch((e) => console.error(`[agents] ${agent.name} crashed: ${e.message}`));
  }
  return statusOf(run);
}

function stop(website, operator) {
  const run = runs.get(website);
  if (!run) { const e = new Error(`no automation running on ${website}`); e.status = 404; throw e; }
  run.stopping = true;
  run.stopReason = `stopped by ${operator}`;
  run.stopKind = 'stopped';
  broadcastRun(run, 'progress'); // clients show "stopping…" until in-flight files finish
  return statusOf(run);
}

module.exports = { start, stop, status };
