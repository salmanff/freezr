// freezr.info - Contacts feature: FEPS routes
// Mounted at /feps/connections/contacts by froutes/index.mjs.
//
// Endpoint catalogue:
//
// Reads (mounted with markReadOnly — granted use_contacts with scope 'read' is enough):
//   GET    /:connectionName/contacts
//          ?limit&pageToken
//   GET    /:connectionName/contacts/:contactId
//   GET    /:connectionName/search
//          ?query&limit
//   GET    /:connectionName/lookup
//          ?email=<address>
//   GET    /:connectionName/newer
//          ?lastToken&limit                          (delta sync — first call seeds)
//
// Writes (no markReadOnly — contactsContext enforces granted.scopes.includes('write')
// AND connection.access.contacts === 'readwrite'):
//   POST   /:connectionName/contacts                 (create)
//   PATCH  /:connectionName/contacts/:contactId      (update)
//   DELETE /:connectionName/contacts/:contactId
//
// Security model mirrors mail's:
//   - matchesConnection in the shared connectionsContext factory fails closed.
//   - markReadOnly opts out of the default write-required check on reads.
//   - The connection record's `services` array must include 'contacts' (403 if not).

import { Router } from 'express'
import { createSetupGuard, createGetAppTokenInfoFromheaderForApi } from '../../../middleware/auth/basicAuth.mjs'
import { sendApiSuccess, sendFailure } from '../../../adapters/http/responses.mjs'
import { createContactsContext, markReadOnly } from './middleware/contactsContext.mjs'
import {
  listContacts, getContact, searchContacts, lookupByEmail, getNewer,
  createContact, updateContact, deleteContact
} from './services/contactsService.mjs'

const sendTokenExpired = (req, res) => res.status(401).json({
  success: false,
  error: 'token_expired',
  connectionName: req.params.connectionName,
  reauth_url: '/account/resources?focus=' + encodeURIComponent(req.params.connectionName)
})

export const createContactsApiRoutes = ({ dsManager, freezrPrefs }) => {
  const router = Router()

  const setupGuard = createSetupGuard(dsManager)
  const getAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager)
  const contactsContext = createContactsContext(dsManager, freezrPrefs)

  /**
   * GET /feps/connections/contacts/:connectionName/contacts
   *   ?limit=N (1..1000, default 100)
   *   &pageToken=...     (opaque cursor, optional)
   */
  router.get('/:connectionName/contacts', setupGuard, getAppTokenInfo, markReadOnly, contactsContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.contactsConnection

      const rawLimit = Number(req.query.limit)
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(1000, Math.floor(rawLimit)) : 100

      const options = {
        limit,
        pageToken: typeof req.query.pageToken === 'string' && req.query.pageToken ? req.query.pageToken : undefined
      }

      const { contacts, nextPageToken } = await listContacts({ dsManager, freezrPrefs, userId, connection, options })
      return sendApiSuccess(res, { connectionName: connection.connectionName, contacts, nextPageToken })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in contacts/:connectionName/contacts:', error)
      return sendFailure(res, error, 'contacts/listContacts', 500)
    }
  })

  /**
   * GET /feps/connections/contacts/:connectionName/contacts/:contactId
   * Returns one full contact.
   *
   * Note: People API resourceNames contain a slash (`people/c1234...`). The
   * SDK URL-encodes them to a single path segment so the route param captures
   * the whole encoded value.
   */
  router.get('/:connectionName/contacts/:contactId', setupGuard, getAppTokenInfo, markReadOnly, contactsContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.contactsConnection
      const contactId = req.params.contactId

      const contact = await getContact({ dsManager, freezrPrefs, userId, connection, contactId })
      return sendApiSuccess(res, { connectionName: connection.connectionName, contact })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in contacts/.../:contactId:', error)
      return sendFailure(res, error, 'contacts/getContact', 500)
    }
  })

  /**
   * GET /feps/connections/contacts/:connectionName/search
   *   ?query=<text>&limit=N
   */
  router.get('/:connectionName/search', setupGuard, getAppTokenInfo, markReadOnly, contactsContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.contactsConnection

      const query = typeof req.query.query === 'string' ? req.query.query : ''
      if (!query) {
        return sendFailure(res, 'searchContacts: query is required', 'contacts/searchContacts', 400)
      }
      const rawLimit = Number(req.query.limit)
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(30, Math.floor(rawLimit)) : 30

      const { contacts } = await searchContacts({ dsManager, freezrPrefs, userId, connection, query, options: { limit } })
      return sendApiSuccess(res, { connectionName: connection.connectionName, contacts })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in contacts/:connectionName/search:', error)
      return sendFailure(res, error, 'contacts/searchContacts', 500)
    }
  })

  /**
   * GET /feps/connections/contacts/:connectionName/lookup
   *   ?email=<address>
   *
   * Returns: { connectionName, contacts: [...] } — all contacts whose emails
   * include the address (exact, case-insensitive). Used by mail-feature
   * sender enrichment.
   */
  router.get('/:connectionName/lookup', setupGuard, getAppTokenInfo, markReadOnly, contactsContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.contactsConnection

      const emailAddress = typeof req.query.email === 'string' ? req.query.email : ''
      if (!emailAddress) {
        return sendFailure(res, 'lookupByEmail: email is required', 'contacts/lookupByEmail', 400)
      }

      const { contacts } = await lookupByEmail({ dsManager, freezrPrefs, userId, connection, emailAddress })
      return sendApiSuccess(res, { connectionName: connection.connectionName, contacts })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in contacts/:connectionName/lookup:', error)
      return sendFailure(res, error, 'contacts/lookupByEmail', 500)
    }
  })

  /**
   * GET /feps/connections/contacts/:connectionName/newer
   *   ?lastToken=...&limit=N
   * Returns: { connectionName, changes, nextToken, expired }
   */
  router.get('/:connectionName/newer', setupGuard, getAppTokenInfo, markReadOnly, contactsContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.contactsConnection

      const lastToken = typeof req.query.lastToken === 'string' && req.query.lastToken ? req.query.lastToken : undefined
      const rawLimit = Number(req.query.limit)
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(1000, Math.floor(rawLimit)) : undefined

      const result = await getNewer({ dsManager, freezrPrefs, userId, connection, lastToken, limit })
      return sendApiSuccess(res, { connectionName: connection.connectionName, ...result })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in contacts/:connectionName/newer:', error)
      return sendFailure(res, error, 'contacts/getNewer', 500)
    }
  })

  // ============================================
  // WRITE-SIDE ROUTES (no markReadOnly → contactsContext enforces write gate)
  // ============================================

  /**
   * POST /feps/connections/contacts/:connectionName/contacts
   *   body: { displayName, givenName, familyName, emails, phones, organization }
   * Returns: { contact }
   */
  router.post('/:connectionName/contacts', setupGuard, getAppTokenInfo, contactsContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.contactsConnection
      const params = req.body || {}
      const contact = await createContact({ dsManager, freezrPrefs, userId, connection, params })
      return sendApiSuccess(res, { connectionName: connection.connectionName, contact })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in contacts POST /contacts:', error)
      return sendFailure(res, error, 'contacts/createContact', 500)
    }
  })

  /**
   * PATCH /feps/connections/contacts/:connectionName/contacts/:contactId
   *   body: same fields as create; only present fields are touched.
   *         Pass `etag` (from a prior get) for optimistic concurrency.
   * Returns: { contact }
   */
  router.patch('/:connectionName/contacts/:contactId', setupGuard, getAppTokenInfo, contactsContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.contactsConnection
      const contactId = req.params.contactId
      const params = req.body || {}
      const contact = await updateContact({ dsManager, freezrPrefs, userId, connection, contactId, params })
      return sendApiSuccess(res, { connectionName: connection.connectionName, contact })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in contacts PATCH /contacts/:contactId:', error)
      return sendFailure(res, error, 'contacts/updateContact', 500)
    }
  })

  /**
   * DELETE /feps/connections/contacts/:connectionName/contacts/:contactId
   * Returns: { contactId }
   */
  router.delete('/:connectionName/contacts/:contactId', setupGuard, getAppTokenInfo, contactsContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.contactsConnection
      const contactId = req.params.contactId
      const result = await deleteContact({ dsManager, freezrPrefs, userId, connection, contactId })
      return sendApiSuccess(res, { connectionName: connection.connectionName, ...result })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in contacts DELETE /contacts/:contactId:', error)
      return sendFailure(res, error, 'contacts/deleteContact', 500)
    }
  })

  return router
}

export default { createContactsApiRoutes }
