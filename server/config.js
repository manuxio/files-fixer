'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- minimal .env loader (no dependency) ---------------------------------
(function loadDotenv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
})();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  // Mounted data roots (the real files live here)
  leftRoot: process.env.LEFT_ROOT || '/left',
  rightRoot: process.env.RIGHT_ROOT || '/right',
  // Evidence folder: audit log + backups are written here
  evidenceRoot: process.env.EVIDENCE_ROOT || '/evidence',
  // Checksum manifests
  leftCsv: process.env.LEFT_CSV || '',
  rightCsv: process.env.RIGHT_CSV || '',
  // Prefix present in every CSV absolute_path, stripped to map onto the mounts
  csvPrefix: process.env.CSV_PATH_PREFIX || '/mnt/data',
  // Pristine Joomla sources root: one subfolder per version (e.g. Joomla-3.9.21/)
  joomlaRoot: process.env.JOOMLA_ROOT || '/joomla',
  // JCE remediation dropper + packages (bundled under ./assets; override with JCE_ASSETS_ROOT)
  jceAssetsRoot: process.env.JCE_ASSETS_ROOT || path.join(__dirname, '..', 'assets'),
  jceDropper: process.env.JCE_DROPPER || 'dropper.5.3.php',
  jcePkgFull: process.env.JCE_PKG_FULL || 'pkg_jce_pro_29998.zip',   // full upgrade -> 2.9.99.8
  jcePkgPatch: process.env.JCE_PKG_PATCH || 'patch_jce_27x_29x.zip', // legacy file-patch (PHP < 7.4)
  jceTarget: process.env.JCE_TARGET || '2.9.99.8',
  // Sent on dropper requests — Node sends no User-Agent by default, which many
  // WAFs/proxies answer with 503/403. A real UA avoids that.
  patchUserAgent: process.env.PATCH_USER_AGENT
    || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  patchExpirySec: parseInt(process.env.PATCH_EXPIRY_SEC || '1800', 10), // dropper token lifetime
  patchesCsv: process.env.PATCHES_CSV || '',

  // --- Claude web shell -----------------------------------------------------
  // Interactive in-browser terminal that runs the Claude Code CLI under one of
  // N isolated profile dirs (each is a separate CLAUDE_CONFIG_DIR — separate
  // login/credentials/config). Set CLAUDE_SHELL=0 to disable the endpoint.
  claudeShell: process.env.CLAUDE_SHELL !== '0',
  claudeBin: process.env.CLAUDE_BIN || 'claude-bin', // real CLI, past the profile wrapper
  claudeProfilesRoot: process.env.CLAUDE_PROFILES_ROOT || '/claude-profiles',
  claudeProfileCount: parseInt(process.env.CLAUDE_PROFILE_COUNT || '3', 10),
  // Root that holds the per-session throwaway sandbox dirs. Each session gets a
  // fresh subdir (holding only current.<ext> / previous.<ext>) that Claude runs
  // in and that is destroyed when the shell closes. Kept OUTSIDE the data mounts
  // so traversing "up" never reaches the real /left or /right files.
  claudeShellSandbox: process.env.CLAUDE_SHELL_SANDBOX || path.join(os.tmpdir(), 'claude-shell'),
  // Cap per side when copying the file into the sandbox (webshells are tiny).
  claudeShellMaxBytes: parseInt(process.env.CLAUDE_SHELL_MAX_BYTES || String(32 * 1024 * 1024), 10),
  // Also engage Claude Code's built-in OS command sandbox (bubblewrap) via the
  // per-session --settings. Set CLAUDE_SHELL_OS_SANDBOX=0 to fall back to the
  // permission deny-rules only (still enforced) if bubblewrap misbehaves.
  claudeOsSandbox: process.env.CLAUDE_SHELL_OS_SANDBOX !== '0',
  // Auto-accept Claude's "trust this folder?" dialog for the throwaway sandbox
  // dir (it only ever holds current.*/previous.* — nothing that trust guards
  // against). Set CLAUDE_SHELL_AUTOTRUST=0 to show the dialog instead.
  claudeAutoTrust: process.env.CLAUDE_SHELL_AUTOTRUST !== '0',
  // Max concurrent web-shell sessions allowed on ONE profile. 0 = unlimited, so
  // several users can share the same profile. Round-robin still spreads new
  // sessions across profiles by default; this is just the hard ceiling per
  // profile. Sessions each get their own throwaway sandbox dir, so they don't
  // collide; they only share the profile's login/config.
  claudeMaxPerProfile: parseInt(process.env.CLAUDE_SHELL_MAX_PER_PROFILE || '0', 10),
  // Auto-close a session after this many ms with no user input (keystrokes), as
  // a precaution against abandoned sessions. 0 = never. Default 5 minutes.
  claudeIdleMs: parseInt(process.env.CLAUDE_SHELL_IDLE_MS || String(5 * 60 * 1000), 10),
  // Per-attempt timeout for a `claude -p` analysis (one account). Default 2 min.
  claudeAnalyzeTimeoutMs: parseInt(process.env.CLAUDE_ANALYZE_TIMEOUT_MS || String(2 * 60 * 1000), 10),
  // Model the analysis task runs on (passed to `claude -p --model`).
  claudeAnalyzeModel: process.env.CLAUDE_ANALYZE_MODEL || 'sonnet',
};

if (!config.leftCsv) config.leftCsv = path.join(config.evidenceRoot, 'left.csv');
if (!config.rightCsv) config.rightCsv = path.join(config.evidenceRoot, 'right.csv');
if (!config.patchesCsv) config.patchesCsv = path.join(config.evidenceRoot, 'patches.csv');

module.exports = config;
