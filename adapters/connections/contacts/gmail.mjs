// freezr.info - Contacts connector: Google People API
// Pure data-API wrapper for Google's People API. No OAuth flow, no persistence —
// just takes an already-refreshed accessToken and returns NORMALIZED data so apps
// see the same shape regardless of provider.
//
// Rate-limit contract (see adapters/connections/_shared.mjs for full text):
//   - Per-item fan-out (none today, since People API returns full contact objects
//     in a single list call) — primitives wired up for future deltaSync detail fetches.
//   - Every People API HTTP call goes through fetchWithRetry, which retries 429/5xx/network
//     with exponential backoff and honors Retry-After.
//
// Normalized contact shape (also used by future Graph contacts adapter):
//
//   {
//     id,                     // People API resourceName (e.g. "people/c123...")
//     displayName,
//     givenName,
//     familyName,
//     emails:    [{ address, type, primary }],     // type: 'work'|'home'|'other'|null
//     phones:    [{ number, type, primary }],
//     organization,                                  // { name, title } | null
//     photoUrl,                                      // string | null
//     updatedAt                                      // ms timestamp | null
//   }

import { fetchWithRetry } from '../_shared.mjs'

const PEOPLE_BASE = 'https://people.googleapis.com/v1'

// Fields we ask the People API to return on list / get. Keeping this explicit:
//   - matches everything the normalized shape needs (no over-fetching).
//   - any new normalized field requires adding the matching personFields here.
const DEFAULT_PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,photos,metadata'

// ---------- helpers ----------

const authHeaders = (accessToken) => ({
  Authorization: 'Bearer ' + accessToken,
  Accept: 'application/json'
})

const peopleFetch = async (url, accessToken, { method = 'GET', body } = {}) => {
  const headers = authHeaders(accessToken)
  const init = { method, headers }
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json'
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const res = await fetchWithRetry(url, init, {
    onRetry: ({ status, attempt, delayMs }) => {
      console.warn('People ' + (status || 'network') + ' — retrying in ' + delayMs + 'ms (attempt ' + attempt + ')')
    }
  })
  if (res.status === 204) return null
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (_) { /* leave null */ }
  if (!res.ok) {
    const err = new Error('People ' + res.status + ': ' + (data?.error?.message || text || res.statusText))
    err.status = res.status
    err.peopleError = data?.error || null
    throw err
  }
  return data
}

// Pick the "primary" entry from a typed array, falling back to the first.
const pickPrimary = (arr) => {
  if (!Array.isArray(arr) || arr.length === 0) return null
  const primary = arr.find(x => x?.metadata?.primary)
  return primary || arr[0]
}

// Normalize a People API person resource to our shared shape.
const normalizeContact = (p) => {
  if (!p) return null
  const namePrimary = pickPrimary(p.names) || {}
  const orgPrimary = pickPrimary(p.organizations) || {}
  const photoPrimary = pickPrimary(p.photos) || {}

  const emails = Array.isArray(p.emailAddresses)
    ? p.emailAddresses.map(e => ({
      address: e?.value || null,
      type: e?.type || null,
      primary: !!e?.metadata?.primary
    })).filter(e => e.address)
    : []

  const phones = Array.isArray(p.phoneNumbers)
    ? p.phoneNumbers.map(ph => ({
      number: ph?.value || null,
      type: ph?.type || null,
      primary: !!ph?.metadata?.primary
    })).filter(ph => ph.number)
    : []

  const orgPart = (orgPrimary && (orgPrimary.name || orgPrimary.title))
    ? { name: orgPrimary.name || null, title: orgPrimary.title || null }
    : null

  // metadata.sources[0].updateTime is RFC3339 — convert to ms for parity with
  // the message shape's receivedAt (also ms).
  const sources = Array.isArray(p.metadata?.sources) ? p.metadata.sources : []
  const updatedRfc = sources.find(s => s?.updateTime)?.updateTime || null
  const updatedAt = updatedRfc ? Date.parse(updatedRfc) : null

  return {
    id: p.resourceName || null,
    displayName: namePrimary.displayName || namePrimary.unstructuredName || null,
    givenName: namePrimary.givenName || null,
    familyName: namePrimary.familyName || null,
    emails,
    phones,
    organization: orgPart,
    photoUrl: photoPrimary.url || null,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : null
  }
}

// ---------- public API ----------

/**
 * List the authenticated user's contacts, paginated.
 *
 * Uses `people.connections.list` against the implicit /me resource. The first
 * call returns up to `limit` contacts + a `nextPageToken` (opaque). Pass that
 * back via `pageToken` for the next page.
 *
 * @param {string} accessToken
 * @param {Object} [options]
 * @param {number} [options.limit=100]    1..1000 (People API cap).
 * @param {string} [options.pageToken]
 * @returns {Promise<{ contacts: Array, nextPageToken: string|null }>}
 */
export const listContacts = async (accessToken, options = {}) => {
  const limit = Math.max(1, Math.min(1000, options.limit || 100))
  const params = [
    'pageSize=' + limit,
    'personFields=' + encodeURIComponent(DEFAULT_PERSON_FIELDS),
    'sortOrder=LAST_MODIFIED_DESCENDING'
  ]
  if (options.pageToken) params.push('pageToken=' + encodeURIComponent(options.pageToken))

  const url = PEOPLE_BASE + '/people/me/connections?' + params.join('&')
  const data = await peopleFetch(url, accessToken)

  const contacts = Array.isArray(data?.connections)
    ? data.connections.map(normalizeContact).filter(Boolean)
    : []
  const nextPageToken = data?.nextPageToken || null

  return { contacts, nextPageToken }
}

/**
 * Get one contact by id. `contactId` is the People API resourceName
 * (e.g. "people/c1234567890123456789") — pass it through verbatim.
 */
export const getContact = async (accessToken, contactId) => {
  if (!contactId) throw new Error('contactId is required')
  // resourceName already contains a "/" — encode the whole thing.
  const url = PEOPLE_BASE + '/' + encodeURIComponent(contactId) +
    '?personFields=' + encodeURIComponent(DEFAULT_PERSON_FIELDS)
  const data = await peopleFetch(url, accessToken)
  return normalizeContact(data)
}

/**
 * Free-text search across the authenticated user's contacts. People API
 * `people:searchContacts` (warmup-then-query model). The first call returns
 * up to `pageSize` matches; there's no pagination cursor in the API today.
 *
 * @param {string} accessToken
 * @param {string} query     Free-text query (substring match across all fields).
 * @param {Object} [options]
 * @param {number} [options.limit=30]   1..30 (People API cap on this endpoint).
 */
export const searchContacts = async (accessToken, query, options = {}) => {
  if (!query) return { contacts: [] }
  const limit = Math.max(1, Math.min(30, options.limit || 30))
  const params = [
    'query=' + encodeURIComponent(query),
    'readMask=' + encodeURIComponent(DEFAULT_PERSON_FIELDS),
    'pageSize=' + limit
  ]
  const url = PEOPLE_BASE + '/people:searchContacts?' + params.join('&')
  const data = await peopleFetch(url, accessToken)
  // searchContacts returns { results: [{ person, ... }] } — unwrap.
  const results = Array.isArray(data?.results) ? data.results : []
  const contacts = results.map(r => normalizeContact(r?.person)).filter(Boolean)
  return { contacts }
}

/**
 * Lookup by email address. Returns ALL contacts whose emails include the address.
 * Implemented as searchContacts with the email as query — People API's
 * `searchContacts` matches across emailAddresses values too.
 */
export const lookupByEmail = async (accessToken, emailAddress) => {
  if (!emailAddress) return { contacts: [] }
  const { contacts } = await searchContacts(accessToken, emailAddress, { limit: 30 })
  // Filter to exact email matches (case-insensitive) — searchContacts also matches
  // partial names / phone numbers etc.
  const target = emailAddress.toLowerCase()
  const filtered = contacts.filter(c => (c.emails || []).some(e => (e.address || '').toLowerCase() === target))
  return { contacts: filtered }
}

/**
 * Incremental sync via People API `syncToken`.
 * Returns `{ changes, nextToken, expired }`.
 *
 * `lastToken` is an opaque `syncToken` returned by a prior call (or by the
 * seeding mode below). When absent we seed by listing connections with
 * `requestSyncToken=true` and returning the syncToken with `changes: []`.
 *
 * People API expires unused tokens after 7 days; on expiry it returns
 * `400 FAILED_PRECONDITION`. We surface that as `expired: true` so the caller
 * knows to do a full re-fetch via listContacts and seed a fresh token.
 *
 * Change shape:
 *   { type: 'contactUpdated', contact: <normalized> }     // added or modified
 *   { type: 'contactDeleted', contactId }
 *
 * (People API doesn't distinguish add vs update on the wire — both come back as
 * the contact object with no deletion flag. We collapse them to contactUpdated.)
 */
export const getNewer = async (accessToken, lastToken, options = {}) => {
  const limit = Math.max(1, Math.min(1000, options.limit || 100))
  const personFields = encodeURIComponent(DEFAULT_PERSON_FIELDS)

  // First-call seed: list current contacts but only return a syncToken.
  if (!lastToken) {
    const url = PEOPLE_BASE + '/people/me/connections?pageSize=' + limit +
      '&personFields=' + personFields + '&requestSyncToken=true'
    const data = await peopleFetch(url, accessToken)
    return { changes: [], nextToken: data?.nextSyncToken || null, expired: false }
  }

  const url = PEOPLE_BASE + '/people/me/connections?pageSize=' + limit +
    '&personFields=' + personFields +
    '&syncToken=' + encodeURIComponent(lastToken) +
    '&requestSyncToken=true'

  let data
  try {
    data = await peopleFetch(url, accessToken)
  } catch (err) {
    // FAILED_PRECONDITION on syncToken expiry — People API uses 400, not 410.
    // Distinguish from other 400s by looking at the error.status field in
    // the JSON body. Treat any 400 with an expired-sync-token hint as expired.
    if (err?.status === 400 && /sync ?token|FAILED_PRECONDITION/i.test(err?.peopleError?.message || '')) {
      return { changes: [], nextToken: null, expired: true }
    }
    throw err
  }

  const connections = Array.isArray(data?.connections) ? data.connections : []
  const changes = []
  // Process each person: a `metadata.deleted === true` flag marks deletions;
  // otherwise the row is an add-or-update.
  connections.forEach(p => {
    if (p?.metadata?.deleted === true) {
      changes.push({ type: 'contactDeleted', contactId: p.resourceName || null })
    } else {
      const normalized = normalizeContact(p)
      if (normalized) changes.push({ type: 'contactUpdated', contact: normalized })
    }
  })

  return { changes, nextToken: data?.nextSyncToken || lastToken, expired: false }
}

// ============================================
// WRITES — createContact / updateContact / deleteContact
// ============================================

// Build a People API person body from a writeable subset of normalized fields.
//   { displayName, givenName, familyName, emails:[{address,type}], phones:[{number,type}],
//     organization:{name,title} }
const buildPersonBody = ({ displayName, givenName, familyName, emails, phones, organization } = {}) => {
  const body = {}
  if (displayName || givenName || familyName) {
    body.names = [{
      givenName: givenName || null,
      familyName: familyName || null,
      displayName: displayName || null,
      unstructuredName: displayName || null
    }]
  }
  if (Array.isArray(emails) && emails.length > 0) {
    body.emailAddresses = emails.map(e => ({ value: e.address || e.value, type: e.type || null }))
      .filter(e => e.value)
  }
  if (Array.isArray(phones) && phones.length > 0) {
    body.phoneNumbers = phones.map(p => ({ value: p.number || p.value, type: p.type || null }))
      .filter(p => p.value)
  }
  if (organization && (organization.name || organization.title)) {
    body.organizations = [{ name: organization.name || null, title: organization.title || null }]
  }
  return body
}

// Field mask: the People API needs an explicit list of which fields the write touches.
const fieldMaskFor = (params) => {
  const fields = []
  if (params.displayName || params.givenName || params.familyName) fields.push('names')
  if (Array.isArray(params.emails)) fields.push('emailAddresses')
  if (Array.isArray(params.phones)) fields.push('phoneNumbers')
  if (params.organization) fields.push('organizations')
  return fields.join(',')
}

/**
 * Create a new contact. Returns the normalized created contact.
 */
export const createContact = async (accessToken, params = {}) => {
  const body = buildPersonBody(params)
  if (Object.keys(body).length === 0) {
    throw new Error('createContact: at least one field is required')
  }
  const url = PEOPLE_BASE + '/people:createContact'
  const data = await peopleFetch(url, accessToken, { method: 'POST', body })
  return normalizeContact(data)
}

/**
 * Update an existing contact. `contactId` is the resourceName. Pass only the
 * fields you want to change; the request's updatePersonFields mask is derived
 * from the present fields.
 *
 * Note: People API requires `etag` from the most recent read for optimistic
 * concurrency. We accept it as `params.etag` — the route layer must arrange a
 * read-before-write or pass through the etag from the prior getContact.
 */
export const updateContact = async (accessToken, contactId, params = {}) => {
  if (!contactId) throw new Error('updateContact: contactId is required')
  const mask = fieldMaskFor(params)
  if (!mask) throw new Error('updateContact: at least one updatable field is required')
  const body = buildPersonBody(params)
  if (params.etag) body.etag = params.etag
  const url = PEOPLE_BASE + '/' + encodeURIComponent(contactId) +
    ':updateContact?updatePersonFields=' + encodeURIComponent(mask) +
    '&personFields=' + encodeURIComponent(DEFAULT_PERSON_FIELDS)
  const data = await peopleFetch(url, accessToken, { method: 'PATCH', body })
  return normalizeContact(data)
}

/**
 * Delete a contact. Returns `{ contactId }`.
 */
export const deleteContact = async (accessToken, contactId) => {
  if (!contactId) throw new Error('deleteContact: contactId is required')
  const url = PEOPLE_BASE + '/' + encodeURIComponent(contactId) + ':deleteContact'
  await peopleFetch(url, accessToken, { method: 'DELETE' })
  return { contactId }
}

export default {
  listContacts,
  getContact,
  searchContacts,
  lookupByEmail,
  getNewer,
  createContact,
  updateContact,
  deleteContact
}
