// freezr.info - Calendar feature: service-layer orchestrator
// Bridges a connection record → fresh OAuth token → the right calendar
// connector → normalized result. Same shape as mailService.

import * as gmailCalendar from '../../../../adapters/connections/calendar/gmail.mjs'
import { callWithAutoRefresh } from '../../shared/services/connectorCall.mjs'

const CONNECTORS = {
  google: gmailCalendar
}

const getConnector = (provider) => {
  const c = CONNECTORS[provider]
  if (!c) {
    const err = new Error('No calendar connector for provider: ' + provider)
    err.code = 'no_connector'
    throw err
  }
  return c
}

export const listCalendars = async ({ dsManager, freezrPrefs, userId, connection }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.listCalendars(oauth.accessToken)
  })
}

export const listEvents = async ({ dsManager, freezrPrefs, userId, connection, calendarId, options = {} }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.listEvents(oauth.accessToken, calendarId, options)
  })
}

export const getEvent = async ({ dsManager, freezrPrefs, userId, connection, calendarId, eventId }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.getEvent(oauth.accessToken, calendarId, eventId)
  })
}

export const searchEvents = async ({ dsManager, freezrPrefs, userId, connection, calendarId, params = {} }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.searchEvents(oauth.accessToken, calendarId, params)
  })
}

export const getNewer = async ({ dsManager, freezrPrefs, userId, connection, calendarId, lastToken, limit }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.getNewer(oauth.accessToken, calendarId, lastToken, { limit })
  })
}

export const createEvent = async ({ dsManager, freezrPrefs, userId, connection, calendarId, params }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.createEvent(oauth.accessToken, calendarId, params)
  })
}

export const updateEvent = async ({ dsManager, freezrPrefs, userId, connection, calendarId, eventId, params }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.updateEvent(oauth.accessToken, calendarId, eventId, params)
  })
}

export const deleteEvent = async ({ dsManager, freezrPrefs, userId, connection, calendarId, eventId }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.deleteEvent(oauth.accessToken, calendarId, eventId)
  })
}

export default {
  listCalendars, listEvents, getEvent, searchEvents, getNewer,
  createEvent, updateEvent, deleteEvent
}
