// Local dev access section for freezr-context.md (standalone-repo dev guidance).
// Only included in the generated context bundle (genContext.js) — NOT part of the
// in-browser creator's chat prompt, since it only applies when working on an app
// repo from the command line / an external coding agent.

export const DEV_ACCESS_PROMPT = `
### Programmatic dev access — \`.freezr-access.local.json\`

When developing a freezr app locally (the app folder lives inside the freezr server's
\`users_freezr/{user}/apps/{app-name}/\` directory), a file called
\`.freezr-access.local.json\` at the app root may hold dev API credentials:

\`\`\`json
{
  "baseUrl": "http://localhost:3000",
  "userId": "<freezr user id>",
  "appName": "<this app's name>",
  "appToken": "<long-lived CEPS app token, read+write on this app's own tables>",
  "appTokenExpires": "<ISO date>",
  "accountsToken": null,
  "accountsTokenExpires": null,
  "examples": { "queryTable": "<curl>", "writeRecord": "<curl>", "updateAppFromCode": "<how to re-install>" },
  "howToRegenerate": "<where the user regenerates these tokens>"
}
\`\`\`

Rules for using it:

- **Use the \`appToken\` as a Bearer token** to verify your work end-to-end against the
  running server, e.g. \`curl -H "Authorization: Bearer <appToken>" -X POST
  "<baseUrl>/ceps/query/<appName>.<collection>" -H "Content-Type: application/json" -d '{"count":5}'\`.
  It grants read/write on this app's own tables only. Ready-made curl examples are in the
  file's \`examples\` field.
- **This file is secret and must stay gitignored.** Never copy token values into committed
  files, docs, code, or memory — always reference the file by path and read values at run time.
- **If the file is missing, \`appToken\` is null, the expiry date has passed, or API calls
  return 401 (e.g. "Token not found" / "Token is expired"): do not try to mint a token
  yourself — ask the user to regenerate it.** The user does this in a logged-in browser at
  \`<baseUrl>/account/home\` → "Install Existing Apps" → **Dev** tab → select the app →
  **"Regenerate Tokens for App"**. That overwrites \`.freezr-access.local.json\` with fresh
  tokens (and keeps it gitignored).
- **After changing \`manifest.json\`** (new collections, permissions, pages), the app must be
  re-installed for the server to pick the changes up. There is no long-lived token for this
  action (\`accountsToken\` is null: account actions are session-only), so tell the user to
  open \`<baseUrl>/account/home?devUpdateApp=<appName>\` in their logged-in browser — that
  opens the Dev tab with the app pre-selected — and then press **"Regenerate App from
  Files"**. (Give them the full URL with the real app name filled in.)
`
