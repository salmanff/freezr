// freezr.info - Calendar feature: middleware
//
// Thin per-service binding to the shared connections-context factory. See
// features/connections/shared/middleware/connectionsContext.mjs for the
// security invariants (fail-closed matchesConnection, write-required default,
// two-level write gate, token_expired short-circuit).
//
// Sets res.locals.freezr.calendarPermission and res.locals.freezr.calendarConnection.

import { createConnectionsContext, createMarkReadOnly } from '../../shared/middleware/connectionsContext.mjs'

export const createCalendarContext = createConnectionsContext('calendar')

/**
 * Mount BEFORE createCalendarContext on read routes. Without it, calendarContext
 * defaults to write-required and enforces both granted.scopes includes 'write'
 * AND connection.access.calendar === 'readwrite'.
 */
export const markReadOnly = createMarkReadOnly('calendar')

export default { createCalendarContext, markReadOnly }
