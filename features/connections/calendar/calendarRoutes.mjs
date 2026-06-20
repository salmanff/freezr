// freezr.info - Calendar feature: FEPS routes
// Mounted at /feps/connections/calendar by froutes/index.mjs.
//
// Endpoint catalogue:
//
// Reads (mounted with markReadOnly — granted use_calendar with scope 'read' is enough):
//   GET    /:connectionName/calendars
//   GET    /:connectionName/events
//          ?calendarId=&since=<ms>&before=<ms>&limit=N&pageToken=&q=
//   GET    /:connectionName/events/:eventId
//          ?calendarId=
//   GET    /:connectionName/search
//          ?calendarId=&text=&since=&before=&limit=&pageToken=
//   GET    /:connectionName/newer
//          ?calendarId=&lastToken=&limit=
//
// Writes (no markReadOnly — calendarContext enforces granted.scopes.includes('write')
// AND connection.access.calendar === 'readwrite'):
//   POST   /:connectionName/events                 (create — calendarId in body)
//   PATCH  /:connectionName/events/:eventId        (update — calendarId in body)
//   DELETE /:connectionName/events/:eventId        ?calendarId=
//
// calendarId convention: pass `'primary'` for the user's default calendar.
// Required on every event endpoint because Calendar API addresses events by
// (calendarId, eventId); the eventId alone is not globally unique.

import { Router } from 'express'
import { createSetupGuard, createGetAppTokenInfoFromheaderForApi } from '../../../middleware/auth/basicAuth.mjs'
import { sendApiSuccess, sendFailure } from '../../../adapters/http/responses.mjs'
import { createCalendarContext, markReadOnly } from './middleware/calendarContext.mjs'
import {
  listCalendars, listEvents, getEvent, searchEvents, getNewer,
  createEvent, updateEvent, deleteEvent
} from './services/calendarService.mjs'

const sendTokenExpired = (req, res) => res.status(401).json({
  success: false,
  error: 'token_expired',
  connectionName: req.params.connectionName,
  reauth_url: '/account/resources?focus=' + encodeURIComponent(req.params.connectionName)
})

// Extract calendarId from query (read paths) or body (write paths). Returns
// 'primary' as the default — explicit so the caller doesn't have to know which
// calendar is "primary" before listing calendars once.
const requireCalendarId = (source) => {
  const raw = source && typeof source.calendarId === 'string' ? source.calendarId : null
  if (raw && raw.length > 0) return raw
  return 'primary'
}

export const createCalendarApiRoutes = ({ dsManager, freezrPrefs }) => {
  const router = Router()

  const setupGuard = createSetupGuard(dsManager)
  const getAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager)
  const calendarContext = createCalendarContext(dsManager, freezrPrefs)

  /**
   * GET /feps/connections/calendar/:connectionName/calendars
   */
  router.get('/:connectionName/calendars', setupGuard, getAppTokenInfo, markReadOnly, calendarContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.calendarConnection
      const { calendars } = await listCalendars({ dsManager, freezrPrefs, userId, connection })
      return sendApiSuccess(res, { connectionName: connection.connectionName, calendars })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in calendar/:connectionName/calendars:', error)
      return sendFailure(res, error, 'calendar/listCalendars', 500)
    }
  })

  /**
   * GET /feps/connections/calendar/:connectionName/events
   *   ?calendarId='primary'    (default)
   *   &since=<ms>&before=<ms>
   *   &limit=N&pageToken=&q=
   */
  router.get('/:connectionName/events', setupGuard, getAppTokenInfo, markReadOnly, calendarContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.calendarConnection
      const calendarId = requireCalendarId(req.query)

      const rawLimit = Number(req.query.limit)
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(2500, Math.floor(rawLimit)) : 50
      const parseNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : undefined }

      const options = {
        limit,
        pageToken: typeof req.query.pageToken === 'string' && req.query.pageToken ? req.query.pageToken : undefined,
        since: parseNum(req.query.since),
        before: parseNum(req.query.before),
        q: typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined
      }

      const { events, nextPageToken } = await listEvents({ dsManager, freezrPrefs, userId, connection, calendarId, options })
      return sendApiSuccess(res, { connectionName: connection.connectionName, calendarId, events, nextPageToken })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in calendar/:connectionName/events:', error)
      return sendFailure(res, error, 'calendar/listEvents', 500)
    }
  })

  /**
   * GET /feps/connections/calendar/:connectionName/events/:eventId
   *   ?calendarId='primary'    (default)
   */
  router.get('/:connectionName/events/:eventId', setupGuard, getAppTokenInfo, markReadOnly, calendarContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.calendarConnection
      const calendarId = requireCalendarId(req.query)
      const eventId = req.params.eventId

      const event = await getEvent({ dsManager, freezrPrefs, userId, connection, calendarId, eventId })
      return sendApiSuccess(res, { connectionName: connection.connectionName, calendarId, event })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in calendar/.../:eventId:', error)
      return sendFailure(res, error, 'calendar/getEvent', 500)
    }
  })

  /**
   * GET /feps/connections/calendar/:connectionName/search
   *   ?calendarId=&text=&since=&before=&limit=&pageToken=
   */
  router.get('/:connectionName/search', setupGuard, getAppTokenInfo, markReadOnly, calendarContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.calendarConnection
      const calendarId = requireCalendarId(req.query)

      const parseNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : undefined }
      const rawLimit = Number(req.query.limit)
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(2500, Math.floor(rawLimit)) : 50

      const params = {
        text: typeof req.query.text === 'string' && req.query.text ? req.query.text : undefined,
        since: parseNum(req.query.since),
        before: parseNum(req.query.before),
        limit,
        pageToken: typeof req.query.pageToken === 'string' && req.query.pageToken ? req.query.pageToken : undefined
      }

      const { events, nextPageToken } = await searchEvents({ dsManager, freezrPrefs, userId, connection, calendarId, params })
      return sendApiSuccess(res, { connectionName: connection.connectionName, calendarId, events, nextPageToken })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in calendar/:connectionName/search:', error)
      return sendFailure(res, error, 'calendar/searchEvents', 500)
    }
  })

  /**
   * GET /feps/connections/calendar/:connectionName/newer
   *   ?calendarId=&lastToken=&limit=
   */
  router.get('/:connectionName/newer', setupGuard, getAppTokenInfo, markReadOnly, calendarContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.calendarConnection
      const calendarId = requireCalendarId(req.query)

      const lastToken = typeof req.query.lastToken === 'string' && req.query.lastToken ? req.query.lastToken : undefined
      const rawLimit = Number(req.query.limit)
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(2500, Math.floor(rawLimit)) : undefined

      const result = await getNewer({ dsManager, freezrPrefs, userId, connection, calendarId, lastToken, limit })
      return sendApiSuccess(res, { connectionName: connection.connectionName, calendarId, ...result })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in calendar/:connectionName/newer:', error)
      return sendFailure(res, error, 'calendar/getNewer', 500)
    }
  })

  // ============================================
  // WRITE-SIDE ROUTES (no markReadOnly → calendarContext enforces write gate)
  // ============================================

  /**
   * POST /feps/connections/calendar/:connectionName/events
   *   body: { calendarId?, title, description?, location?, startAt, endAt, isAllDay?,
   *           timezone?, attendees?, recurrenceRule? }
   *   calendarId in body defaults to 'primary'.
   */
  router.post('/:connectionName/events', setupGuard, getAppTokenInfo, calendarContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.calendarConnection
      const body = req.body || {}
      const calendarId = requireCalendarId(body)
      const { calendarId: _drop, ...params } = body
      const event = await createEvent({ dsManager, freezrPrefs, userId, connection, calendarId, params })
      return sendApiSuccess(res, { connectionName: connection.connectionName, calendarId, event })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in calendar POST /events:', error)
      return sendFailure(res, error, 'calendar/createEvent', 500)
    }
  })

  /**
   * PATCH /feps/connections/calendar/:connectionName/events/:eventId
   *   body: { calendarId?, ...fields to update, etag? }
   */
  router.patch('/:connectionName/events/:eventId', setupGuard, getAppTokenInfo, calendarContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.calendarConnection
      const eventId = req.params.eventId
      const body = req.body || {}
      const calendarId = requireCalendarId(body)
      const { calendarId: _drop, ...params } = body
      const event = await updateEvent({ dsManager, freezrPrefs, userId, connection, calendarId, eventId, params })
      return sendApiSuccess(res, { connectionName: connection.connectionName, calendarId, event })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in calendar PATCH /events/:eventId:', error)
      return sendFailure(res, error, 'calendar/updateEvent', 500)
    }
  })

  /**
   * DELETE /feps/connections/calendar/:connectionName/events/:eventId
   *   ?calendarId=    (defaults to 'primary')
   */
  router.delete('/:connectionName/events/:eventId', setupGuard, getAppTokenInfo, calendarContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.calendarConnection
      const eventId = req.params.eventId
      const calendarId = requireCalendarId(req.query)
      const result = await deleteEvent({ dsManager, freezrPrefs, userId, connection, calendarId, eventId })
      return sendApiSuccess(res, { connectionName: connection.connectionName, ...result })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in calendar DELETE /events/:eventId:', error)
      return sendFailure(res, error, 'calendar/deleteEvent', 500)
    }
  })

  return router
}

export default { createCalendarApiRoutes }
