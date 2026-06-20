// freezrApiV2.connections.js - Freezr SDK add-on for external connections
// Version 2.0.0 - 2026
//
// Attaches `freezr.connections` to the global `freezr` object created by
// freezrApiV2.js (core). Loaded only when the app's manifest declares a
// use_mail / use_contacts / use_calendar permission (see
// common/helpers/sdkAddons.mjs + adapters/rendering/pageLoader.mjs).
//
// Surfaces three sibling namespaces:
//   freezr.connections.mail
//   freezr.connections.contacts
//   freezr.connections.calendar
// All three share the same connection records and OAuth grants — a single
// Gmail connect can light up all three depending on the access map the user
// approved at /account/resources (see freezr_mail_plan_v1.md Part 4).

/* global freezr, freezrMeta */

if (typeof freezr === 'undefined') {
  console.error('freezrApiV2.connections.js loaded before freezrApiV2.js core — skipping. Check manifest script order.')
} else {
  console.log('Running freezrApiV2.connections.js !!')

  // ============================================
  // PRIVATE - Binary GET (mail attachments, future: calendar attachments)
  // ============================================
  //
  // Mirrors freezr.apiRequest's auth + URL-building, but returns a Blob
  // (default) or ArrayBuffer. On non-200 it parses JSON if the server emitted
  // any (e.g. the standard token_expired payload) and rethrows with .data set
  // so callers can detect token_expired uniformly.
  async function apiRequestBinary (url, options = {}) {
    let fullUrl = url
    if (!fullUrl.startsWith('http') && !freezr.app.isWebBased && freezrMeta.serverAddress) {
      fullUrl = freezrMeta.serverAddress + fullUrl
    }

    const accessToken = options.appToken ||
      (freezr.app.isWebBased ? freezr.utils.getCookie('app_token_' + freezrMeta.userId) : freezrMeta.appToken)

    const headers = {}
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken

    const response = await fetch(fullUrl, { method: 'GET', headers })

    if (response.status !== 200) {
      const errorData = await response.json().catch(() => ({}))
      const error = new Error(errorData.error || errorData.message || 'Unknown error')
      error.status = response.status
      error.data = errorData
      throw error
    }

    if (options.responseType === 'arrayBuffer') return await response.arrayBuffer()
    return await response.blob()
  }

  // ============================================
  // freezr.connections.mail
  // ============================================
  //
  // Phase 2: mail only. See freezr_mail_phase2.md §2.3 for the full surface.
  //
  // All methods may throw an error carrying the structured token_expired payload
  // when the underlying connection's OAuth refresh has failed:
  //   try { ... } catch (err) {
  //     if (freezr.connections.mail.handleTokenExpired(err)) return  // redirected
  //     // otherwise normal error handling
  //   }
  // The error's err.data shape on a 401 token_expired:
  //   { error: 'token_expired', connectionName: '...', reauth_url: '/account/resources?focus=...' }

  freezr.connections = freezr.connections || {}
  freezr.connections.mail = {
    /**
     * List the user's connected mail accounts visible to this app.
     * Backed by GET /feps/connections/accounts (filtered server-side
     * to connections covered by this app's granted use_mail perms).
     */
    async listAccounts (options = {}) {
      const url = (options.host || '') + '/feps/connections/accounts'
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('GET', url, null, writeOptions)
    },

    /**
     * List messages for one connection, paginated. Returns
     * `{ success, connectionName, messages, nextPageToken }`.
     *
     * @param {Object}   args
     * @param {string}   args.connectionName  Required. The connection to query.
     * @param {number}   [args.limit=20]      1..100.
     * @param {string}   [args.pageToken]     Opaque cursor returned by a prior call.
     * @param {string[]|string} [args.labelIds] Default: all labels (no filter).
     *                                          Pass `['INBOX']` to filter to INBOX.
     *                                          May also be passed as a CSV string.
     * @param {string}   [args.q]             Provider-specific search query.
     *                                       Gmail syntax today (e.g. `has:attachment after:1700000000`).
     * @param {boolean}  [args.includeAttachments]
     *                                       When true, each returned row carries an
     *                                       `attachments: [{ id, filename, mimeType, sizeBytes }]`
     *                                       array (bodies are NOT included). Lets a caller
     *                                       discover attachment metadata without a second
     *                                       per-message getMessage round-trip. Same shape
     *                                       holds for future Microsoft Graph and IMAP
     *                                       connectors.
     * @param {Object}   [options]            { appToken, host }
     */
    async listMessages ({ connectionName, limit, pageToken, labelIds, q, includeAttachments } = {}, options = {}) {
      if (!connectionName) throw new Error('listMessages: connectionName is required')
      const params = []
      if (limit !== undefined) params.push('limit=' + encodeURIComponent(limit))
      if (pageToken) params.push('pageToken=' + encodeURIComponent(pageToken))
      if (labelIds && labelIds.length > 0) {
        const csv = Array.isArray(labelIds) ? labelIds.join(',') : String(labelIds)
        params.push('labelIds=' + encodeURIComponent(csv))
      }
      if (q) params.push('q=' + encodeURIComponent(q))
      if (includeAttachments) params.push('includeAttachments=true')
      const url = (options.host || '') + '/feps/connections/mail/' +
        encodeURIComponent(connectionName) + '/messages' +
        (params.length ? ('?' + params.join('&')) : '')
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('GET', url, null, writeOptions)
    },

    /**
     * Fetch one full message with bodies + attachment metadata. Returns
     * `{ success, connectionName, message: { ..., bodyText, bodyHtml, attachments } }`.
     */
    async getMessage ({ connectionName, messageId } = {}, options = {}) {
      if (!connectionName) throw new Error('getMessage: connectionName is required')
      if (!messageId) throw new Error('getMessage: messageId is required')
      const url = (options.host || '') + '/feps/connections/mail/' +
        encodeURIComponent(connectionName) + '/messages/' + encodeURIComponent(messageId)
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('GET', url, null, writeOptions)
    },

    /**
     * Fetch the raw binary of a single attachment. Defaults to Blob; pass
     * `responseType: 'arrayBuffer'` if you need raw bytes. Filename + MIME
     * type come from the prior getMessage() call's attachments[] metadata;
     * pass them through so Content-Disposition is set sensibly.
     *
     * Typical usage:
     *   const blob = await freezr.connections.mail.getAttachment({
     *     connectionName, messageId, attachmentId, filename, mimeType: 'application/pdf'
     *   })
     *   window.open(URL.createObjectURL(blob), '_blank')
     */
    async getAttachment ({ connectionName, messageId, attachmentId, filename, mimeType, responseType = 'blob' } = {}, options = {}) {
      if (!connectionName) throw new Error('getAttachment: connectionName is required')
      if (!messageId) throw new Error('getAttachment: messageId is required')
      if (!attachmentId) throw new Error('getAttachment: attachmentId is required')
      const params = []
      if (filename) params.push('filename=' + encodeURIComponent(filename))
      if (mimeType) params.push('mimeType=' + encodeURIComponent(mimeType))
      const url = (options.host || '') + '/feps/connections/mail/' +
        encodeURIComponent(connectionName) + '/messages/' + encodeURIComponent(messageId) +
        '/attachments/' + encodeURIComponent(attachmentId) +
        (params.length ? ('?' + params.join('&')) : '')
      return await apiRequestBinary(url, {
        appToken: options.appToken,
        responseType
      })
    },

    /**
     * Incremental sync. Returns changes since `lastToken` plus a `nextToken`
     * the caller should persist and pass back on the next call.
     *
     * `lastToken` is opaque to the caller — Gmail's `historyId`, Graph's
     * `@odata.deltaLink` and IMAP's CONDSTORE modseq all flow through the
     * same field. Omit it on the first call to seed: the server returns
     * `{ changes: [], nextToken }` with no events but a usable cursor.
     *
     * Shape of each change (provider-normalized):
     *   { type: 'messageAdded',   message: { id, threadId, ... } }   // metadata-only
     *   { type: 'messageDeleted', messageId }
     *   { type: 'labelAdded',     messageId, labels: [...] }
     *   { type: 'labelRemoved',   messageId, labels: [...] }
     *
     * Returns `{ success, connectionName, changes, nextToken, expired }`.
     * `expired: true` means the provider's delta window has elapsed (Gmail's
     * historyId is ~7 days) — caller should do a full re-fetch via listMessages
     * and seed a new token.
     */
    async getNewer ({ connectionName, lastToken, limit } = {}, options = {}) {
      if (!connectionName) throw new Error('getNewer: connectionName is required')
      const params = []
      if (lastToken) params.push('lastToken=' + encodeURIComponent(lastToken))
      if (limit !== undefined) params.push('limit=' + encodeURIComponent(limit))
      const url = (options.host || '') + '/feps/connections/mail/' +
        encodeURIComponent(connectionName) + '/newer' +
        (params.length ? ('?' + params.join('&')) : '')
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('GET', url, null, writeOptions)
    },

    /**
     * Structured search across messages. Provider-agnostic: each connector
     * translates these fields into its own query syntax (Gmail's `q`, Graph's
     * `$search` + `$filter`, IMAP SEARCH). Returns the same shape as
     * listMessages: `{ success, connectionName, messages, nextPageToken }`.
     *
     * @param {Object}   args
     * @param {string}   args.connectionName  Required.
     * @param {string}   [args.text]          Free-text search across headers + body.
     * @param {string}   [args.from]          From address (substring match).
     * @param {string}   [args.to]            To address (substring match).
     * @param {number}   [args.since]         Unix ms — only messages on/after this.
     * @param {number}   [args.before]        Unix ms — only messages strictly before this.
     * @param {string[]} [args.labels]        Restrict to messages with all these labels.
     * @param {boolean}  [args.isRead]
     * @param {boolean}  [args.hasAttachments]
     * @param {number}   [args.limit=20]      1..100.
     * @param {string}   [args.pageToken]     Opaque cursor from prior call.
     */
    async searchMessages ({ connectionName, text, from, to, since, before, labels, isRead, hasAttachments, limit, pageToken } = {}, options = {}) {
      if (!connectionName) throw new Error('searchMessages: connectionName is required')
      const params = []
      if (text) params.push('text=' + encodeURIComponent(text))
      if (from) params.push('from=' + encodeURIComponent(from))
      if (to) params.push('to=' + encodeURIComponent(to))
      if (since !== undefined) params.push('since=' + encodeURIComponent(since))
      if (before !== undefined) params.push('before=' + encodeURIComponent(before))
      if (labels && labels.length > 0) {
        const csv = Array.isArray(labels) ? labels.join(',') : String(labels)
        params.push('labels=' + encodeURIComponent(csv))
      }
      if (isRead !== undefined) params.push('isRead=' + (isRead ? 'true' : 'false'))
      if (hasAttachments !== undefined) params.push('hasAttachments=' + (hasAttachments ? 'true' : 'false'))
      if (limit !== undefined) params.push('limit=' + encodeURIComponent(limit))
      if (pageToken) params.push('pageToken=' + encodeURIComponent(pageToken))
      const url = (options.host || '') + '/feps/connections/mail/' +
        encodeURIComponent(connectionName) + '/search' +
        (params.length ? ('?' + params.join('&')) : '')
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('GET', url, null, writeOptions)
    },

    /**
     * List folders/labels for a connection. Returns
     * `{ success, connectionName, folders: [{ id, name, type }] }`.
     *
     * `type` is one of `'system'` (INBOX, SENT, DRAFT, TRASH, SPAM, ...) or
     * `'user'` (user-created label/folder). Gmail labels and Graph folders
     * normalize to the same shape; on Gmail nested-label paths come through
     * with `/` separators in `name`.
     */
    async listFolders ({ connectionName } = {}, options = {}) {
      if (!connectionName) throw new Error('listFolders: connectionName is required')
      const url = (options.host || '') + '/feps/connections/mail/' +
        encodeURIComponent(connectionName) + '/folders'
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('GET', url, null, writeOptions)
    },

    // ============================================
    // Writes — require granted scope 'write' AND connection access.mail === 'readwrite'
    // ============================================

    /**
     * Send a message. Returns `{ success, messageId, threadId }`.
     *
     * For replies: pass `inReplyTo` (the parent's RFC822 Message-ID — found
     * in the parent's headers when fetched with getMessage) AND `threadId`
     * (the parent's `threadId`). Both are needed for proper threading on
     * Gmail; Graph also uses `internetMessageId` for In-Reply-To headers.
     *
     * Attachments are inline base64 — keep total payload < ~25 MB or you'll
     * hit provider send limits. Larger sends will need a streamed-upload path
     * (deferred).
     *
     * @param {Object}   args
     * @param {string}   args.connectionName  Required.
     * @param {string|string[]} args.to       At least one required.
     * @param {string|string[]} [args.cc]
     * @param {string|string[]} [args.bcc]
     * @param {string}   args.subject
     * @param {string}   [args.bodyText]      Plain-text body.
     * @param {string}   [args.bodyHtml]      HTML body. Both bodies → multipart/alternative.
     * @param {Array}    [args.attachments]   [{ filename, mimeType, contentBase64 }]
     * @param {string}   [args.inReplyTo]     Parent's RFC822 Message-ID. Sets In-Reply-To + References.
     * @param {string}   [args.threadId]      Provider thread id. Pass when replying.
     */
    async sendMessage (args = {}, options = {}) {
      if (!args.connectionName) throw new Error('sendMessage: connectionName is required')
      if (!args.to || (Array.isArray(args.to) && args.to.length === 0)) {
        throw new Error('sendMessage: at least one recipient (to) is required')
      }
      const url = (options.host || '') + '/feps/connections/mail/' +
        encodeURIComponent(args.connectionName) + '/messages/send'
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      const { connectionName, ...body } = args
      return await freezr.apiRequest('POST', url, body, writeOptions)
    },

    /**
     * Create a draft on the provider. Same shape as sendMessage except the
     * message is saved (not delivered). Returns `{ success, draftId, messageId, threadId }`.
     * The draft is synced back to the provider — visible in Gmail's web UI etc.
     */
    async createDraft (args = {}, options = {}) {
      if (!args.connectionName) throw new Error('createDraft: connectionName is required')
      const url = (options.host || '') + '/feps/connections/mail/' +
        encodeURIComponent(args.connectionName) + '/drafts'
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      const { connectionName, ...body } = args
      return await freezr.apiRequest('POST', url, body, writeOptions)
    },

    /**
     * Mark a message read or unread. Returns `{ success, messageId, isRead }`.
     *
     *   freezr.connections.mail.markRead({ connectionName, messageId, isRead: true })
     *
     * Gmail: toggles the UNREAD label.
     * Graph: PATCH /messages/{id} { isRead: true|false }.
     * IMAP: STORE +/- \Seen.
     */
    async markRead ({ connectionName, messageId, isRead } = {}, options = {}) {
      if (!connectionName) throw new Error('markRead: connectionName is required')
      if (!messageId) throw new Error('markRead: messageId is required')
      const url = (options.host || '') + '/feps/connections/mail/' +
        encodeURIComponent(connectionName) + '/messages/' + encodeURIComponent(messageId) + '/markread'
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('POST', url, { isRead: isRead !== false }, writeOptions)
    },

    /**
     * Move a message to a target folder/label. Returns `{ success, messageId }`.
     *
     * `targetFolder` is the folder/label ID returned by `listFolders` (Gmail
     * label ID, Graph folder ID, IMAP folder path).
     *
     * Gmail: removes existing INBOX / system labels and adds the target label.
     * Graph: PATCH /messages/{id} { parentFolderId }.
     * IMAP: COPY + EXPUNGE.
     */
    async moveMessage ({ connectionName, messageId, targetFolder } = {}, options = {}) {
      if (!connectionName) throw new Error('moveMessage: connectionName is required')
      if (!messageId) throw new Error('moveMessage: messageId is required')
      if (!targetFolder) throw new Error('moveMessage: targetFolder is required')
      const url = (options.host || '') + '/feps/connections/mail/' +
        encodeURIComponent(connectionName) + '/messages/' + encodeURIComponent(messageId) + '/move'
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('POST', url, { targetFolder }, writeOptions)
    },

    /**
     * Send a message to Trash (recoverable). Returns `{ success, messageId }`.
     * Distinct from deleteMessage — trashed messages can be restored.
     *
     * Gmail: POST /messages/{id}/trash.
     * Graph: move to "deleteditems" folder.
     * IMAP: move to Trash folder.
     */
    async trashMessage ({ connectionName, messageId } = {}, options = {}) {
      if (!connectionName) throw new Error('trashMessage: connectionName is required')
      if (!messageId) throw new Error('trashMessage: messageId is required')
      const url = (options.host || '') + '/feps/connections/mail/' +
        encodeURIComponent(connectionName) + '/messages/' + encodeURIComponent(messageId) + '/trash'
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('POST', url, null, writeOptions)
    },

    /**
     * Permanently delete a message (skips Trash). Returns `{ success, messageId }`.
     * Irreversible.
     *
     * Gmail: DELETE /messages/{id}.
     * Graph: DELETE /messages/{id}.
     * IMAP: STORE +\Deleted + EXPUNGE.
     */
    async deleteMessage ({ connectionName, messageId } = {}, options = {}) {
      if (!connectionName) throw new Error('deleteMessage: connectionName is required')
      if (!messageId) throw new Error('deleteMessage: messageId is required')
      const url = (options.host || '') + '/feps/connections/mail/' +
        encodeURIComponent(connectionName) + '/messages/' + encodeURIComponent(messageId)
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('DELETE', url, null, writeOptions)
    },

    /**
     * Detects the `token_expired` error shape (whether the server returned
     * it as a body on a 200 OR as the parsed body on a thrown 401 error).
     * If detected, navigates the browser to the connection's reauth URL
     * and returns `true`. Otherwise returns `false` so the caller can
     * fall through to normal error handling.
     *
     * Use in catch blocks:
     *   try { ... } catch (err) {
     *     if (freezr.connections.mail.handleTokenExpired(err)) return
     *     // ...normal error handling...
     *   }
     */
    handleTokenExpired (resOrErr) {
      if (!resOrErr) return false
      // Body on a 200 (defensive — current server emits 401).
      if (resOrErr.error === 'token_expired') {
        if (typeof window !== 'undefined' && resOrErr.reauth_url) {
          window.location.assign(resOrErr.reauth_url)
          return true
        }
      }
      // Error.data path: apiRequest attaches the full structured body.
      if (resOrErr.data && resOrErr.data.error === 'token_expired') {
        if (typeof window !== 'undefined' && resOrErr.data.reauth_url) {
          window.location.assign(resOrErr.data.reauth_url)
          return true
        }
      }
      return false
    }
  }

  // ============================================
  // freezr.connections.contacts
  // ============================================
  //
  // Per-connection contacts API, gated by use_contacts. Same token_expired
  // error shape as mail; reuse `freezr.connections.handleTokenExpired` for
  // cross-service handling.

  freezr.connections.contacts = {
    /**
     * List contacts on one connection, paginated.
     * @returns { success, connectionName, contacts, nextPageToken }
     */
    async listContacts ({ connectionName, limit, pageToken } = {}, options = {}) {
      if (!connectionName) throw new Error('listContacts: connectionName is required')
      const params = []
      if (limit !== undefined) params.push('limit=' + encodeURIComponent(limit))
      if (pageToken) params.push('pageToken=' + encodeURIComponent(pageToken))
      const url = (options.host || '') + '/feps/connections/contacts/' +
        encodeURIComponent(connectionName) + '/contacts' +
        (params.length ? ('?' + params.join('&')) : '')
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('GET', url, null, writeOptions)
    },

    /**
     * Fetch one contact. `contactId` is the People API resourceName (e.g.
     * "people/c123...") and contains a `/` — encoded into the path here.
     */
    async getContact ({ connectionName, contactId } = {}, options = {}) {
      if (!connectionName) throw new Error('getContact: connectionName is required')
      if (!contactId) throw new Error('getContact: contactId is required')
      const url = (options.host || '') + '/feps/connections/contacts/' +
        encodeURIComponent(connectionName) + '/contacts/' + encodeURIComponent(contactId)
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('GET', url, null, writeOptions)
    },

    /**
     * Free-text search across contacts. Provider-translated — Gmail's People
     * `searchContacts` for now. Returns `{ success, connectionName, contacts }`.
     */
    async searchContacts ({ connectionName, query, limit } = {}, options = {}) {
      if (!connectionName) throw new Error('searchContacts: connectionName is required')
      if (!query) throw new Error('searchContacts: query is required')
      const params = ['query=' + encodeURIComponent(query)]
      if (limit !== undefined) params.push('limit=' + encodeURIComponent(limit))
      const url = (options.host || '') + '/feps/connections/contacts/' +
        encodeURIComponent(connectionName) + '/search?' + params.join('&')
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('GET', url, null, writeOptions)
    },

    /**
     * Lookup contacts by exact email address. Useful for enriching mail senders
     * (the common cross-service consumer).
     */
    async lookupByEmail ({ connectionName, emailAddress } = {}, options = {}) {
      if (!connectionName) throw new Error('lookupByEmail: connectionName is required')
      if (!emailAddress) throw new Error('lookupByEmail: emailAddress is required')
      const url = (options.host || '') + '/feps/connections/contacts/' +
        encodeURIComponent(connectionName) + '/lookup?email=' + encodeURIComponent(emailAddress)
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('GET', url, null, writeOptions)
    },

    /**
     * Incremental sync via the provider's syncToken (People API for Gmail).
     * Returns `{ changes, nextToken, expired }`. `expired:true` means the
     * caller should drop the token and re-seed via listContacts + a fresh
     * getNewer({}) call.
     *
     * Change shape:
     *   { type: 'contactUpdated', contact: <normalized> }
     *   { type: 'contactDeleted', contactId }
     */
    async getNewer ({ connectionName, lastToken, limit } = {}, options = {}) {
      if (!connectionName) throw new Error('getNewer: connectionName is required')
      const params = []
      if (lastToken) params.push('lastToken=' + encodeURIComponent(lastToken))
      if (limit !== undefined) params.push('limit=' + encodeURIComponent(limit))
      const url = (options.host || '') + '/feps/connections/contacts/' +
        encodeURIComponent(connectionName) + '/newer' +
        (params.length ? ('?' + params.join('&')) : '')
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('GET', url, null, writeOptions)
    },

    // ============================================
    // Writes — require granted scope 'write' AND connection access.contacts === 'readwrite'
    // ============================================

    /**
     * Create a contact. Returns `{ success, connectionName, contact }`.
     * Pass any subset of:
     *   { displayName, givenName, familyName,
     *     emails:[{address,type}], phones:[{number,type}],
     *     organization:{name,title} }
     */
    async createContact (args = {}, options = {}) {
      if (!args.connectionName) throw new Error('createContact: connectionName is required')
      const url = (options.host || '') + '/feps/connections/contacts/' +
        encodeURIComponent(args.connectionName) + '/contacts'
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      const { connectionName, ...body } = args
      return await freezr.apiRequest('POST', url, body, writeOptions)
    },

    /**
     * Patch-update a contact. Only present fields are touched.
     * Pass `etag` from a prior getContact for optimistic concurrency.
     */
    async updateContact (args = {}, options = {}) {
      if (!args.connectionName) throw new Error('updateContact: connectionName is required')
      if (!args.contactId) throw new Error('updateContact: contactId is required')
      const url = (options.host || '') + '/feps/connections/contacts/' +
        encodeURIComponent(args.connectionName) +
        '/contacts/' + encodeURIComponent(args.contactId)
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      const { connectionName, contactId, ...body } = args
      return await freezr.apiRequest('PATCH', url, body, writeOptions)
    },

    /**
     * Delete a contact. Returns `{ success, contactId }`.
     */
    async deleteContact ({ connectionName, contactId } = {}, options = {}) {
      if (!connectionName) throw new Error('deleteContact: connectionName is required')
      if (!contactId) throw new Error('deleteContact: contactId is required')
      const url = (options.host || '') + '/feps/connections/contacts/' +
        encodeURIComponent(connectionName) +
        '/contacts/' + encodeURIComponent(contactId)
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('DELETE', url, null, writeOptions)
    },

    handleTokenExpired (resOrErr) { return freezr.connections.mail.handleTokenExpired(resOrErr) }
  }

  // ============================================
  // freezr.connections.calendar
  // ============================================
  //
  // Per-connection calendar API, gated by use_calendar. Events are addressed
  // by (calendarId, eventId) — `calendarId` defaults to `'primary'` if omitted.

  freezr.connections.calendar = {
    /**
     * List the user's calendars on a connection.
     * @returns { success, connectionName, calendars }
     */
    async listCalendars ({ connectionName } = {}, options = {}) {
      if (!connectionName) throw new Error('listCalendars: connectionName is required')
      const url = (options.host || '') + '/feps/connections/calendar/' +
        encodeURIComponent(connectionName) + '/calendars'
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('GET', url, null, writeOptions)
    },

    /**
     * List events on a calendar with a time window.
     * @param {string} args.connectionName  Required.
     * @param {string} [args.calendarId='primary']
     * @param {number} [args.since]   Unix ms — only events on/after this.
     * @param {number} [args.before]  Unix ms — only events strictly before this.
     * @param {number} [args.limit=50]
     * @param {string} [args.pageToken]
     * @param {string} [args.q]       Provider-specific free-text search.
     * @returns { success, connectionName, calendarId, events, nextPageToken }
     */
    async listEvents ({ connectionName, calendarId, since, before, limit, pageToken, q } = {}, options = {}) {
      if (!connectionName) throw new Error('listEvents: connectionName is required')
      const params = []
      if (calendarId) params.push('calendarId=' + encodeURIComponent(calendarId))
      if (since !== undefined) params.push('since=' + encodeURIComponent(since))
      if (before !== undefined) params.push('before=' + encodeURIComponent(before))
      if (limit !== undefined) params.push('limit=' + encodeURIComponent(limit))
      if (pageToken) params.push('pageToken=' + encodeURIComponent(pageToken))
      if (q) params.push('q=' + encodeURIComponent(q))
      const url = (options.host || '') + '/feps/connections/calendar/' +
        encodeURIComponent(connectionName) + '/events' +
        (params.length ? ('?' + params.join('&')) : '')
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('GET', url, null, writeOptions)
    },

    /**
     * Fetch one event.
     */
    async getEvent ({ connectionName, calendarId, eventId } = {}, options = {}) {
      if (!connectionName) throw new Error('getEvent: connectionName is required')
      if (!eventId) throw new Error('getEvent: eventId is required')
      const params = []
      if (calendarId) params.push('calendarId=' + encodeURIComponent(calendarId))
      const url = (options.host || '') + '/feps/connections/calendar/' +
        encodeURIComponent(connectionName) +
        '/events/' + encodeURIComponent(eventId) +
        (params.length ? ('?' + params.join('&')) : '')
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('GET', url, null, writeOptions)
    },

    /**
     * Structured search across events. Returns the same shape as listEvents.
     */
    async searchEvents ({ connectionName, calendarId, text, since, before, limit, pageToken } = {}, options = {}) {
      if (!connectionName) throw new Error('searchEvents: connectionName is required')
      const params = []
      if (calendarId) params.push('calendarId=' + encodeURIComponent(calendarId))
      if (text) params.push('text=' + encodeURIComponent(text))
      if (since !== undefined) params.push('since=' + encodeURIComponent(since))
      if (before !== undefined) params.push('before=' + encodeURIComponent(before))
      if (limit !== undefined) params.push('limit=' + encodeURIComponent(limit))
      if (pageToken) params.push('pageToken=' + encodeURIComponent(pageToken))
      const url = (options.host || '') + '/feps/connections/calendar/' +
        encodeURIComponent(connectionName) + '/search' +
        (params.length ? ('?' + params.join('&')) : '')
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('GET', url, null, writeOptions)
    },

    /**
     * Incremental sync for one calendar via the provider's syncToken.
     * Returns `{ changes, nextToken, expired }`.
     *
     * Change shape:
     *   { type: 'eventUpdated', event: <normalized> }
     *   { type: 'eventDeleted', eventId }
     */
    async getNewer ({ connectionName, calendarId, lastToken, limit } = {}, options = {}) {
      if (!connectionName) throw new Error('getNewer: connectionName is required')
      const params = []
      if (calendarId) params.push('calendarId=' + encodeURIComponent(calendarId))
      if (lastToken) params.push('lastToken=' + encodeURIComponent(lastToken))
      if (limit !== undefined) params.push('limit=' + encodeURIComponent(limit))
      const url = (options.host || '') + '/feps/connections/calendar/' +
        encodeURIComponent(connectionName) + '/newer' +
        (params.length ? ('?' + params.join('&')) : '')
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('GET', url, null, writeOptions)
    },

    // ============================================
    // Writes — require granted scope 'write' AND connection access.calendar === 'readwrite'
    // ============================================

    /**
     * Create an event. Returns `{ success, event }`.
     *
     * @param {string} args.connectionName  Required.
     * @param {string} [args.calendarId='primary']
     * @param {string} args.title
     * @param {string} [args.description]
     * @param {string} [args.location]
     * @param {number} args.startAt    Unix ms.
     * @param {number} args.endAt      Unix ms.
     * @param {boolean}[args.isAllDay]
     * @param {string} [args.timezone]
     * @param {Array}  [args.attendees]      [{ address, name, optional }]
     * @param {string[]}[args.recurrenceRule] RRULE/EXDATE lines.
     */
    async createEvent (args = {}, options = {}) {
      if (!args.connectionName) throw new Error('createEvent: connectionName is required')
      const url = (options.host || '') + '/feps/connections/calendar/' +
        encodeURIComponent(args.connectionName) + '/events'
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      const { connectionName, ...body } = args
      return await freezr.apiRequest('POST', url, body, writeOptions)
    },

    /**
     * Patch-update an event. Pass `etag` from a prior getEvent for optimistic
     * concurrency.
     */
    async updateEvent (args = {}, options = {}) {
      if (!args.connectionName) throw new Error('updateEvent: connectionName is required')
      if (!args.eventId) throw new Error('updateEvent: eventId is required')
      const url = (options.host || '') + '/feps/connections/calendar/' +
        encodeURIComponent(args.connectionName) +
        '/events/' + encodeURIComponent(args.eventId)
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      const { connectionName, eventId, ...body } = args
      return await freezr.apiRequest('PATCH', url, body, writeOptions)
    },

    /**
     * Delete an event. Returns `{ success, eventId, calendarId }`.
     */
    async deleteEvent ({ connectionName, calendarId, eventId } = {}, options = {}) {
      if (!connectionName) throw new Error('deleteEvent: connectionName is required')
      if (!eventId) throw new Error('deleteEvent: eventId is required')
      const params = []
      if (calendarId) params.push('calendarId=' + encodeURIComponent(calendarId))
      const url = (options.host || '') + '/feps/connections/calendar/' +
        encodeURIComponent(connectionName) +
        '/events/' + encodeURIComponent(eventId) +
        (params.length ? ('?' + params.join('&')) : '')
      const writeOptions = options.appToken ? { appToken: options.appToken } : {}
      return await freezr.apiRequest('DELETE', url, null, writeOptions)
    },

    handleTokenExpired (resOrErr) { return freezr.connections.mail.handleTokenExpired(resOrErr) }
  }

  // Cross-service convenience: the handler is identical for all three services
  // (same server payload), so expose it once at the umbrella too.
  freezr.connections.handleTokenExpired = (resOrErr) => freezr.connections.mail.handleTokenExpired(resOrErr)
}
