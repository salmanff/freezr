// freezr.info - Mail feature: middleware
//
// Thin per-service binding to the shared connections-context factory. All the
// real logic (matchesConnection fail-closed, write-required default, two-level
// write gate, token_expired short-circuit) lives in
// features/connections/shared/middleware/connectionsContext.mjs and is shared
// with contacts and calendar.
//
// Public surface is unchanged from before the factoring:
//   createMailContext(dsManager, freezrPrefs)  — middleware factory
//   markReadOnly                                — toggles fail-closed write check off
//
// Sets res.locals.freezr.mailPermission (the matching granted perm) and
// res.locals.freezr.mailConnection (decrypted), plus permGiven = true.
//
// The type-agnostic listing endpoint (GET /feps/connections/accounts) lives in
// features/connections/connectionsApiRoutes.mjs and does its own perm load —
// it crosses services and has no :connectionName, so it doesn't fit this shape.

import { createConnectionsContext, createMarkReadOnly } from '../../shared/middleware/connectionsContext.mjs'

export const createMailContext = createConnectionsContext('mail')

/**
 * Tiny utility middleware to mark the next mailContext check as read-only.
 * Mount BEFORE createMailContext on read routes. Without it, mailContext
 * defaults to write-required and enforces both granted.scopes includes 'write'
 * AND connection.access.mail === 'readwrite' (fail-closed default).
 */
export const markReadOnly = createMarkReadOnly('mail')

export default { createMailContext, markReadOnly }
