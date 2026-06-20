// freezr.info - Contacts feature: middleware
//
// Thin per-service binding to the shared connections-context factory. See
// features/connections/shared/middleware/connectionsContext.mjs for the
// security invariants (fail-closed matchesConnection, write-required default,
// two-level write gate, token_expired short-circuit).
//
// Sets res.locals.freezr.contactsPermission and res.locals.freezr.contactsConnection.

import { createConnectionsContext, createMarkReadOnly } from '../../shared/middleware/connectionsContext.mjs'

export const createContactsContext = createConnectionsContext('contacts')

/**
 * Mount BEFORE createContactsContext on read routes. Without it, contactsContext
 * defaults to write-required and enforces both granted.scopes includes 'write'
 * AND connection.access.contacts === 'readwrite'.
 */
export const markReadOnly = createMarkReadOnly('contacts')

export default { createContactsContext, markReadOnly }
