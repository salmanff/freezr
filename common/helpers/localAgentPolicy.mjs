// freezr.info - Which apps may use the LOCAL-CLI LLM connectors (ClaudeLocal / CodexLocal).
//
// These connectors spend the server owner's Claude / ChatGPT SUBSCRIPTION by driving the CLI
// installed on this machine. By default only the creator app may use them. Two independent
// reasons point the same way:
//
//   1. TERMS. Anthropic permits a subscription owner to use headless Claude Code for their own
//      personal projects, and prohibits offering claude.ai login or subscription rate limits to
//      third parties. An ordinary app serving its users from the owner's subscription is much
//      closer to that prohibited pattern than a developer using it to build an app is. OpenAI is
//      less restrictive but recommends API keys for automation.
//
//   2. PROMPT INJECTION. CodexLocal runs an agent: `--disable shell_tool` turns command
//      execution off and is verified, but nobody has established a switch that makes Codex an
//      exclusively text-only client with every action surface removed. The danger only
//      materialises when a prompt carries UNTRUSTED third-party text — email bodies, chat
//      messages, transcripts — which is exactly what ordinary apps feed an LLM and exactly what
//      app-building does not. See local_cli_llm_connectors.md.
//
// This gate is INDEPENDENT of, and additional to, the existing ones (admin master pref
// `local_llm_cli_enabled` + the requesting user being an admin). All must pass.
//
// ESCAPE HATCH: set the environment variable SHOW_LOCAL_AGENT_IN_APPS=true to lift the
// restriction and let any app use them. It is an env var rather than an admin preference on
// purpose — changing it requires access to the server process, which is a deliberate act by
// someone who has read this file, not a checkbox someone clicks past. A developer with a good
// reason can take the risk knowingly; nobody does it by accident.
//
// If Anthropic's or OpenAI's terms change, or Codex gains a proven text-only mode, revisit the
// default here rather than scattering exceptions elsewhere.

/** Apps allowed to use local-CLI connectors when the escape hatch is off. */
export const LOCAL_AGENT_ALLOWED_APPS = ['info.freezr.creator']

/** True when the env escape hatch is set — any app may then use the local connectors. */
export const localAgentsAllowedEverywhere = () => process.env.SHOW_LOCAL_AGENT_IN_APPS === 'true'

/**
 * May this app use the local-CLI LLM connectors?
 * @param {string} appName the requesting app (tokenInfo.app_name)
 * @returns {boolean}
 */
export const localAgentsAllowedForApp = (appName) => {
  if (localAgentsAllowedEverywhere()) return true
  return LOCAL_AGENT_ALLOWED_APPS.includes(appName)
}

export default { localAgentsAllowedForApp, localAgentsAllowedEverywhere, LOCAL_AGENT_ALLOWED_APPS }
