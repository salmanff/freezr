// freezr.info - Contacts feature: service-layer orchestrator
// Bridges a connection record → fresh OAuth token → the right contacts
// connector → normalized result. Same shape as mailService — the shared
// callWithAutoRefresh helper handles 401-retry + token-expired surfacing.

import * as gmailContacts from '../../../../adapters/connections/contacts/gmail.mjs'
import { callWithAutoRefresh } from '../../shared/services/connectorCall.mjs'

// Provider-to-connector dispatch. Graph (Microsoft) and CardDAV (IMAP-class)
// register here when their adapters land.
const CONNECTORS = {
  google: gmailContacts
}

const getConnector = (provider) => {
  const c = CONNECTORS[provider]
  if (!c) {
    const err = new Error('No contacts connector for provider: ' + provider)
    err.code = 'no_connector'
    throw err
  }
  return c
}

export const listContacts = async ({ dsManager, freezrPrefs, userId, connection, options = {} }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.listContacts(oauth.accessToken, options)
  })
}

export const getContact = async ({ dsManager, freezrPrefs, userId, connection, contactId }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.getContact(oauth.accessToken, contactId)
  })
}

export const searchContacts = async ({ dsManager, freezrPrefs, userId, connection, query, options = {} }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.searchContacts(oauth.accessToken, query, options)
  })
}

export const lookupByEmail = async ({ dsManager, freezrPrefs, userId, connection, emailAddress }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.lookupByEmail(oauth.accessToken, emailAddress)
  })
}

export const getNewer = async ({ dsManager, freezrPrefs, userId, connection, lastToken, limit }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.getNewer(oauth.accessToken, lastToken, { limit })
  })
}

export const createContact = async ({ dsManager, freezrPrefs, userId, connection, params }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.createContact(oauth.accessToken, params)
  })
}

export const updateContact = async ({ dsManager, freezrPrefs, userId, connection, contactId, params }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.updateContact(oauth.accessToken, contactId, params)
  })
}

export const deleteContact = async ({ dsManager, freezrPrefs, userId, connection, contactId }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.deleteContact(oauth.accessToken, contactId)
  })
}

export default {
  listContacts, getContact, searchContacts, lookupByEmail, getNewer,
  createContact, updateContact, deleteContact
}
