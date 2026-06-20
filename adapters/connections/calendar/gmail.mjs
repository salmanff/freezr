// freezr.info - Calendar connector: Google Calendar API
// Pure data-API wrapper for Google Calendar v3. No OAuth flow, no persistence —
// just takes an already-refreshed accessToken and returns NORMALIZED data so apps
// see the same shape regardless of provider.
//
// Rate-limit contract (see adapters/connections/_shared.mjs for full text):
//   - Every Calendar HTTP call goes through fetchWithRetry, which retries 429/5xx/network
//     with exponential backoff and honors Retry-After.
//
// Normalized shapes (also used by future Graph calendar adapter):
//
//   calendar -> {
//     id,                     // Google calendarId (often the user's email)
//     name,                   // summary
//     description,
//     color,                  // backgroundColor (string|null)
//     timezone,
//     accessRole,             // 'owner'|'writer'|'reader'|'freeBusyReader'
//     isPrimary               // bool
//   }
//
//   event -> {
//     id,                     // Google eventId
//     calendarId,             // the calendar this event belongs to
//     title,                  // summary
//     description,
//     location,
//     startAt,                // ms timestamp | null (null for date-only all-day)
//     endAt,                  // ms timestamp | null
//     isAllDay,               // bool — based on dateTime vs date
//     timezone,
//     organizer,              // { address, name } | null
//     attendees,              // [{ address, name, status, responseStatus }]
//     isRecurring,            // bool
//     recurrenceRule,         // string[] (RRULE/EXDATE/...) | null
//     status,                 // 'confirmed' | 'tentative' | 'cancelled'
//     htmlLink,               // string (Google web URL)
//     updatedAt,              // ms timestamp | null
//     etag                    // string (needed for optimistic-concurrency on update)
//   }

import { fetchWithRetry } from '../_shared.mjs'

const CAL_BASE = 'https://www.googleapis.com/calendar/v3'

// ---------- helpers ----------

const authHeaders = (accessToken) => ({
  Authorization: 'Bearer ' + accessToken,
  Accept: 'application/json'
})

const calendarFetch = async (url, accessToken, { method = 'GET', body } = {}) => {
  const headers = authHeaders(accessToken)
  const init = { method, headers }
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json'
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const res = await fetchWithRetry(url, init, {
    onRetry: ({ status, attempt, delayMs }) => {
      console.warn('Calendar ' + (status || 'network') + ' — retrying in ' + delayMs + 'ms (attempt ' + attempt + ')')
    }
  })
  if (res.status === 204) return null
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (_) { /* leave null */ }
  if (!res.ok) {
    const err = new Error('Calendar ' + res.status + ': ' + (data?.error?.message || text || res.statusText))
    err.status = res.status
    err.calendarError = data?.error || null
    throw err
  }
  return data
}

const parseRfc3339 = (s) => {
  if (!s) return null
  const n = Date.parse(s)
  return Number.isFinite(n) ? n : null
}

const normalizeCalendar = (c) => {
  if (!c) return null
  return {
    id: c.id || null,
    name: c.summary || c.summaryOverride || null,
    description: c.description || null,
    color: c.backgroundColor || null,
    timezone: c.timeZone || null,
    accessRole: c.accessRole || null,
    isPrimary: !!c.primary
  }
}

// `calendarId` is needed in the normalized event because Calendar API's event
// resource doesn't include it inline. The route/service layer passes it through.
const normalizeEvent = (e, calendarId) => {
  if (!e) return null

  const startDt = e.start?.dateTime || null
  const startDate = e.start?.date || null
  const endDt = e.end?.dateTime || null
  const endDate = e.end?.date || null
  const isAllDay = !!startDate && !startDt

  // For all-day events Google sends `date` as YYYY-MM-DD. Parse to midnight in
  // the event's timezone (or UTC if not specified) — Date.parse on 'YYYY-MM-DD'
  // is fine for the unified timestamp.
  const startMs = startDt ? parseRfc3339(startDt) : (startDate ? Date.parse(startDate) : null)
  const endMs = endDt ? parseRfc3339(endDt) : (endDate ? Date.parse(endDate) : null)

  const organizer = e.organizer
    ? { address: e.organizer.email || null, name: e.organizer.displayName || null }
    : null

  const attendees = Array.isArray(e.attendees)
    ? e.attendees.map(a => ({
      address: a?.email || null,
      name: a?.displayName || null,
      status: a?.responseStatus || null,
      responseStatus: a?.responseStatus || null,
      optional: !!a?.optional,
      organizer: !!a?.organizer
    })).filter(a => a.address)
    : []

  const recurrence = Array.isArray(e.recurrence) ? e.recurrence : null
  const isRecurring = (recurrence && recurrence.length > 0) || !!e.recurringEventId

  return {
    id: e.id || null,
    calendarId: calendarId || null,
    title: e.summary || '(no title)',
    description: e.description || null,
    location: e.location || null,
    startAt: Number.isFinite(startMs) ? startMs : null,
    endAt: Number.isFinite(endMs) ? endMs : null,
    isAllDay,
    timezone: e.start?.timeZone || e.end?.timeZone || null,
    organizer,
    attendees,
    isRecurring,
    recurrenceRule: recurrence,
    recurringEventId: e.recurringEventId || null,
    status: e.status || null,
    htmlLink: e.htmlLink || null,
    updatedAt: parseRfc3339(e.updated),
    etag: e.etag || null
  }
}

// ---------- public API: calendars ----------

/**
 * List the user's calendars. Returns `{ calendars: [...] }`.
 * The primary calendar carries `isPrimary: true`.
 */
export const listCalendars = async (accessToken) => {
  const data = await calendarFetch(CAL_BASE + '/users/me/calendarList', accessToken)
  const list = Array.isArray(data?.items) ? data.items : []
  return { calendars: list.map(normalizeCalendar).filter(Boolean) }
}

// ---------- public API: events ----------

/**
 * List events on a calendar with a time-window. Returns
 * `{ events, nextPageToken }`.
 *
 * Time bounds (since/before) are unix ms — translated to RFC3339 for Google.
 * If `since` is omitted Calendar API defaults to no lower bound; we keep that
 * behavior since clients typically request rolling windows.
 *
 * @param {string} accessToken
 * @param {string} calendarId        Calendar ID — `'primary'` is a magic alias.
 * @param {Object} [options]
 * @param {number} [options.since]   Unix ms — only events that end on/after this.
 * @param {number} [options.before]  Unix ms — only events that start strictly before this.
 * @param {number} [options.limit=50]  1..2500.
 * @param {string} [options.pageToken]
 * @param {boolean}[options.singleEvents=true]   Expand recurring series into instances.
 * @param {string} [options.q]       Free-text search across summary/description/location/attendees.
 */
export const listEvents = async (accessToken, calendarId, options = {}) => {
  if (!calendarId) throw new Error('calendarId is required')
  const limit = Math.max(1, Math.min(2500, options.limit || 50))
  const params = [
    'maxResults=' + limit,
    'singleEvents=' + (options.singleEvents !== false ? 'true' : 'false'),
    'orderBy=' + (options.singleEvents !== false ? 'startTime' : 'updated')
  ]
  if (options.pageToken) params.push('pageToken=' + encodeURIComponent(options.pageToken))
  if (options.q) params.push('q=' + encodeURIComponent(options.q))
  if (Number.isFinite(options.since)) {
    params.push('timeMin=' + encodeURIComponent(new Date(options.since).toISOString()))
  }
  if (Number.isFinite(options.before)) {
    params.push('timeMax=' + encodeURIComponent(new Date(options.before).toISOString()))
  }

  const url = CAL_BASE + '/calendars/' + encodeURIComponent(calendarId) + '/events?' + params.join('&')
  const data = await calendarFetch(url, accessToken)

  const events = Array.isArray(data?.items)
    ? data.items.map(e => normalizeEvent(e, calendarId)).filter(Boolean)
    : []
  return { events, nextPageToken: data?.nextPageToken || null }
}

/**
 * Get one event by id.
 */
export const getEvent = async (accessToken, calendarId, eventId) => {
  if (!calendarId) throw new Error('calendarId is required')
  if (!eventId) throw new Error('eventId is required')
  const url = CAL_BASE + '/calendars/' + encodeURIComponent(calendarId) +
    '/events/' + encodeURIComponent(eventId)
  const data = await calendarFetch(url, accessToken)
  return normalizeEvent(data, calendarId)
}

/**
 * Structured search across events on a calendar. Identical shape to listEvents;
 * delegates with `q` set.
 */
export const searchEvents = async (accessToken, calendarId, params = {}) => {
  return listEvents(accessToken, calendarId, {
    q: params.text || params.q || undefined,
    since: params.since,
    before: params.before,
    limit: params.limit,
    pageToken: params.pageToken
  })
}

/**
 * Incremental sync for one calendar via Google's `syncToken`.
 * Returns `{ changes, nextToken, expired }`.
 *
 * `lastToken` is an opaque `syncToken` from a prior call (or seeded by the
 * first call: pass `lastToken=undefined`).
 *
 * Google Calendar tokens expire when the user's calendar resets / clears OR
 * after extended periods of inactivity (multi-month). On expiry Calendar API
 * returns 410 Gone — surfaced here as `expired: true`.
 *
 * Change shape:
 *   { type: 'eventUpdated', event: <normalized> }     // includes added + modified
 *   { type: 'eventDeleted', eventId }                  // status === 'cancelled'
 */
export const getNewer = async (accessToken, calendarId, lastToken, options = {}) => {
  if (!calendarId) throw new Error('calendarId is required')
  const limit = Math.max(1, Math.min(2500, options.limit || 250))

  // First-call seed: ask for a syncToken with no event detail.
  if (!lastToken) {
    // singleEvents must be true and orderBy omitted to obtain a syncToken.
    const url = CAL_BASE + '/calendars/' + encodeURIComponent(calendarId) +
      '/events?singleEvents=true&maxResults=' + limit
    const data = await calendarFetch(url, accessToken)
    // The first response includes nextSyncToken only on the last page; if we
    // got a nextPageToken instead we'd need to walk to the end. To keep the
    // seed cheap, just return whatever syncToken was given — caller can re-seed.
    return { changes: [], nextToken: data?.nextSyncToken || null, expired: false }
  }

  const url = CAL_BASE + '/calendars/' + encodeURIComponent(calendarId) +
    '/events?singleEvents=true&maxResults=' + limit +
    '&syncToken=' + encodeURIComponent(lastToken)

  let data
  try {
    data = await calendarFetch(url, accessToken)
  } catch (err) {
    if (err?.status === 410) return { changes: [], nextToken: null, expired: true }
    throw err
  }

  const items = Array.isArray(data?.items) ? data.items : []
  const changes = []
  items.forEach(e => {
    if (e.status === 'cancelled') {
      changes.push({ type: 'eventDeleted', eventId: e.id || null })
    } else {
      const normalized = normalizeEvent(e, calendarId)
      if (normalized) changes.push({ type: 'eventUpdated', event: normalized })
    }
  })

  return { changes, nextToken: data?.nextSyncToken || lastToken, expired: false }
}

// ---------- writes ----------

// Build a Google Calendar event body from a writeable subset of normalized fields.
// Accepts EITHER startAt/endAt + isAllDay OR pre-built start/end objects.
const buildEventBody = (params) => {
  const body = {}
  if (params.title !== undefined) body.summary = params.title
  if (params.description !== undefined) body.description = params.description
  if (params.location !== undefined) body.location = params.location

  const buildEnd = (ms, isAllDay, tz) => {
    if (ms == null) return undefined
    if (isAllDay) return { date: new Date(ms).toISOString().slice(0, 10) }
    return tz ? { dateTime: new Date(ms).toISOString(), timeZone: tz } : { dateTime: new Date(ms).toISOString() }
  }

  if (Number.isFinite(params.startAt) || Number.isFinite(params.endAt)) {
    if (Number.isFinite(params.startAt)) body.start = buildEnd(params.startAt, !!params.isAllDay, params.timezone)
    if (Number.isFinite(params.endAt)) body.end = buildEnd(params.endAt, !!params.isAllDay, params.timezone)
  } else if (params.start || params.end) {
    if (params.start) body.start = params.start
    if (params.end) body.end = params.end
  }

  if (Array.isArray(params.attendees)) {
    body.attendees = params.attendees.map(a => ({
      email: a.address || a.email,
      displayName: a.name || a.displayName || undefined,
      optional: !!a.optional
    })).filter(a => a.email)
  }

  if (Array.isArray(params.recurrenceRule)) {
    body.recurrence = params.recurrenceRule
  }

  return body
}

/**
 * Create an event on a calendar. Returns the normalized event.
 *
 * Required: `calendarId` + at least one of (title, startAt, endAt). For all-day
 * events pass `isAllDay: true` along with startAt/endAt as ms timestamps.
 */
export const createEvent = async (accessToken, calendarId, params = {}) => {
  if (!calendarId) throw new Error('createEvent: calendarId is required')
  const body = buildEventBody(params)
  if (Object.keys(body).length === 0) {
    throw new Error('createEvent: at least one field is required')
  }
  const url = CAL_BASE + '/calendars/' + encodeURIComponent(calendarId) + '/events'
  const data = await calendarFetch(url, accessToken, { method: 'POST', body })
  return normalizeEvent(data, calendarId)
}

/**
 * Patch-update an event. Passes only the fields provided; PATCH semantics.
 * Optional `params.etag` (from a prior getEvent) is sent as If-Match for
 * optimistic concurrency.
 */
export const updateEvent = async (accessToken, calendarId, eventId, params = {}) => {
  if (!calendarId) throw new Error('updateEvent: calendarId is required')
  if (!eventId) throw new Error('updateEvent: eventId is required')
  const body = buildEventBody(params)
  if (Object.keys(body).length === 0) {
    throw new Error('updateEvent: at least one updatable field is required')
  }
  const headers = authHeaders(accessToken)
  if (params.etag) headers['If-Match'] = params.etag
  const url = CAL_BASE + '/calendars/' + encodeURIComponent(calendarId) +
    '/events/' + encodeURIComponent(eventId)
  // Use peopleFetch-equivalent inline because we need a custom If-Match header.
  const init = { method: 'PATCH', headers, body: JSON.stringify(body) }
  headers['Content-Type'] = 'application/json'
  const res = await fetchWithRetry(url, init, {
    onRetry: ({ status, attempt, delayMs }) => {
      console.warn('Calendar ' + (status || 'network') + ' — retrying in ' + delayMs + 'ms (attempt ' + attempt + ')')
    }
  })
  if (res.status === 204) return { id: eventId, calendarId }
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (_) { /* leave null */ }
  if (!res.ok) {
    const err = new Error('Calendar ' + res.status + ': ' + (data?.error?.message || text || res.statusText))
    err.status = res.status
    err.calendarError = data?.error || null
    throw err
  }
  return normalizeEvent(data, calendarId)
}

/**
 * Delete an event. Returns `{ eventId }`.
 */
export const deleteEvent = async (accessToken, calendarId, eventId) => {
  if (!calendarId) throw new Error('deleteEvent: calendarId is required')
  if (!eventId) throw new Error('deleteEvent: eventId is required')
  const url = CAL_BASE + '/calendars/' + encodeURIComponent(calendarId) +
    '/events/' + encodeURIComponent(eventId)
  await calendarFetch(url, accessToken, { method: 'DELETE' })
  return { eventId, calendarId }
}

export default {
  listCalendars,
  listEvents,
  getEvent,
  searchEvents,
  getNewer,
  createEvent,
  updateEvent,
  deleteEvent
}
