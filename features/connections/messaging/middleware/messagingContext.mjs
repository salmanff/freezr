// freezr.info - Messaging feature: middleware
//
// Thin per-service binding to the shared connections-context factory, exactly
// like mail/contacts/calendar. All the real logic (matchesConnection
// fail-closed, write-required default, two-level write gate, token_expired
// short-circuit) lives in
// features/connections/shared/middleware/connectionsContext.mjs.
//
// Sets res.locals.freezr.messagingPermission (the matching granted perm) and
// res.locals.freezr.messagingConnection (decrypted), plus permGiven = true.

import { createConnectionsContext, createMarkReadOnly } from '../../shared/middleware/connectionsContext.mjs'

export const createMessagingContext = createConnectionsContext('messaging')

/**
 * Mount BEFORE createMessagingContext on read routes. Without it, the context
 * defaults to write-required and enforces both granted.scopes includes 'write'
 * AND connection.access.messaging === 'readwrite' (fail-closed default).
 */
export const markReadOnly = createMarkReadOnly('messaging')

export default { createMessagingContext, markReadOnly }
