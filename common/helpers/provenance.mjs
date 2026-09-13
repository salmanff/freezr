// Provenance stamping for app manifests — the manifest `authorship` key.
//
// Schema (every identity is { id, host, date } — date is ms epoch of the stamp):
//   "authorship": {
//     "main_author":   identity,        // original creator — set at creation/fork, never changed by edits
//     "last_modified": identity,        // most recent editor
//     "contributors":  [identity],      // everyone OTHER than main_author who has edited (date = first edit)
//     "forked_from":   {                // present only on apps cloned from another app
//       "app": "<source app id>", "author": identity|null,   // the source's main_author at fork time
//       "version": "<source version>|null", "date": ms },
//     "history": [                      // append-only coarse events, capped at HISTORY_CAP (oldest dropped)
//       { "event": "created", "by": identity, "date": ms },
//       { "event": "forked",  "by": identity, "date": ms,
//         "from_app": "...", "from_author": identity|null, "from_version": "...|null" },
//       { "event": "edited_by", "by": identity, "date": ms }   // ONLY when the editor CHANGES —
//         // i.e. last_modified flips to a different identity. Same-person re-edits record nothing,
//         // so history reads as a handover log: who worked on the app, in order.
//     ]
//   }
//
// This extends (additively) the ask-app authorship shape of freezr_askapp_sharing_summary.md §3 —
// main_author/last_modified/contributors keep their meaning and ask.js's client-side maintenance
// (syncManifest/samePerson) stays compatible. A fork copies the SOURCE's history and appends a
// 'forked' event, so lineage survives chained forks. main_author is never auto-assigned on edit
// of a legacy authorless app — that is a deliberate claim (the ask-app "Add me as author" flow).

const HISTORY_CAP = 50

export const identityOf = (id, host) => ({ id, host: host || null, date: Date.now() })

// Same normalization as ask.js samePerson: identity matches on id + host ignoring scheme/trailing slash.
const normHost = (h) => String(h || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
export const samePerson = (a, b) => !!a && !!b && a.id === b.id && normHost(a.host) === normHost(b.host)

const pushHistory = (authorship, event) => {
  if (!Array.isArray(authorship.history)) authorship.history = []
  authorship.history.push(event)
  if (authorship.history.length > HISTORY_CAP) authorship.history = authorship.history.slice(-HISTORY_CAP)
}

// New app created from scratch by `by`.
export const stampCreated = (manifest, by) => {
  manifest.authorship = {
    main_author: by,
    last_modified: by,
    contributors: [],
    history: [{ event: 'created', by, date: by.date }]
  }
  return manifest
}

// App cloned from sourceApp: the cloner OWNS the new app (main_author), the source is credited in
// forked_from, and the source's history travels along so lineage survives chained forks.
export const stampFork = (manifest, { by, sourceApp, sourceManifest }) => {
  const srcAuth = (sourceManifest && sourceManifest.authorship) || {}
  const fromAuthor = srcAuth.main_author || null
  const fromVersion = (sourceManifest && sourceManifest.version) || null
  manifest.authorship = {
    main_author: by,
    last_modified: by,
    contributors: [],
    forked_from: { app: sourceApp, author: fromAuthor, version: fromVersion, date: by.date },
    history: Array.isArray(srcAuth.history) ? srcAuth.history.slice(-(HISTORY_CAP - 1)) : []
  }
  pushHistory(manifest.authorship, { event: 'forked', by, date: by.date, from_app: sourceApp, from_author: fromAuthor, from_version: fromVersion })
  return manifest
}

// Called on every re-install-from-files. Mutates manifest and returns true when it CHANGED
// (caller persists it then — so same-author re-edits cause zero manifest churn).
export const stampEdit = (manifest, by) => {
  if (!manifest || typeof manifest !== 'object') return false
  if (!manifest.authorship || typeof manifest.authorship !== 'object') {
    // Legacy authorless app: record the edit, but leave main_author for an explicit claim.
    manifest.authorship = { last_modified: by, contributors: [], history: [{ event: 'edited_by', by, date: by.date }] }
    return true
  }
  const auth = manifest.authorship
  let changed = false
  if (!Array.isArray(auth.contributors)) { auth.contributors = []; changed = true }
  if (!samePerson(by, auth.last_modified)) {
    // The editor CHANGED — the one thing history records for edits (a handover log, not an edit log).
    auth.last_modified = by
    pushHistory(auth, { event: 'edited_by', by, date: by.date })
    changed = true
  }
  if (auth.main_author && !samePerson(by, auth.main_author) && !auth.contributors.some((c) => samePerson(c, by))) {
    auth.contributors.push(by)
    changed = true
  }
  return changed
}
