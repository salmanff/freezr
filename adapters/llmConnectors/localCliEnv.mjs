// freezr.info - Shared child-environment policy for the local-CLI LLM connectors.
//
// claudeLocal and codexLocal spawn the owner's `claude` / `codex` CLI. The freezr server's own
// environment carries things a subprocess has no business seeing — FREEZR_ENV_KEY (which
// decrypts EVERY stored credential, for every user), COOKIE_SECRET, DB_PASS,
// FS_MS_CONNECTION_STRING — and codex in particular executes model-generated shell commands,
// so a prompt injection reaches whatever the child can read.
//
// ALLOWLIST, NOT BLOCKLIST. A blocklist is wrong by construction here: it protects only the
// secrets someone remembered to name, so every env var a future freezr feature introduces is
// exposed by default until someone notices. Two cases that a blocklist of the provider API
// keys specifically misses:
//   - ANTHROPIC_BASE_URL / OPENAI_BASE_URL: if either is ever set in the server environment,
//     the CLI sends the owner's OAuth-authenticated requests to that host. That is credential
//     exfiltration one stray env var away, and it defeats the "never calls out except as the
//     owner" property the connectors are built around.
//   - NODE_OPTIONS: the codex CLI is a `#!/usr/bin/env node` script, so this injects arbitrary
//     code into the child process.
// Neither is listed below, and neither is anything added to the server env in future.
//
// This also SUBSUMES the old billing guarantee. The connectors used to `delete env.ANTHROPIC_API_KEY`
// et al so a server-configured key could never be silently billed; with an allowlist those
// variables simply never reach the child, and the guarantee now holds for keys nobody thought
// to delete.
//
// PATH is passed THROUGH rather than hardcoded to something minimal like /usr/bin:/bin. The
// codex CLI is a node script, so it needs `node` on PATH — and on a typical dev machine node
// is in /usr/local/bin or /opt/homebrew/bin, neither of which a hardcoded minimal PATH covers.
// Hardcoding it breaks the connector outright. PATH is not a secret.

const BASE_ALLOWLIST = [
  'HOME', // where the CLI's own credentials live (~/.claude, ~/.codex) — required for auth
  'PATH', // see note above
  'TMPDIR',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ'
]

/**
 * Build the environment for a local-CLI child process.
 * @param {string[]} [extraKeys] connector-specific additions (e.g. CODEX_HOME for codex auth)
 * @returns {Object} a fresh env object containing ONLY the allowlisted variables that are set
 */
export const buildLocalCliEnv = (extraKeys = []) => {
  const env = {}
  for (const key of [...BASE_ALLOWLIST, ...extraKeys]) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export const LOCAL_CLI_ENV_ALLOWLIST = [...BASE_ALLOWLIST]

/**
 * Kill a spawned CLI **and everything it spawned**.
 *
 * `child.kill()` signals only the immediate child. Codex runs its commands via `/bin/zsh -lc`,
 * so a plain kill on timeout or abort can leave that shell — and whatever it started — running
 * against the owner's machine with nobody listening. Spawning `detached: true` makes the child
 * its own process-group leader, so a negative-PID signal reaches the whole group.
 *
 * Trade-off accepted: a detached group no longer receives the terminal's Ctrl-C alongside the
 * server. Both connectors always kill in a `finally`, so the group is reaped on every normal
 * and error path; only a hard `SIGKILL` of freezr itself could strand one, and that was already
 * true of an un-detached child (Unix reparents orphans to init either way).
 */
export const killProcessTree = (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, 'SIGKILL') // negative pid = the whole process group
  } catch (e) {
    // ESRCH (already gone) or EPERM/unsupported — fall back to the direct child.
    try { child.kill('SIGKILL') } catch (e2) { /* already gone */ }
  }
}

export default { buildLocalCliEnv, LOCAL_CLI_ENV_ALLOWLIST, killProcessTree }
