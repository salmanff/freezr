// freezr.info - Connections Page Controller
//
// Serves pages under /connections/* mounted at the top level (mirrors how
// /creator, /account, /admin work). The underlying app is
// info.freezr.connections, so all pages live in
// freezrsystmapps/info.freezr.connections/<page>.html.
//
// Phase 1 pages:
//   /connections           → index.html (list of connected accounts + links)
//   /connections/mail      → mail.html (existing Phase 1 inbox)
//
// Future pages slot in by adding to PAGE_MANIFESTS below + dropping the file
// into the app directory. Long-term, this controller could read pages from
// the app's manifest.json directly — kept inline for now because Phase 1 only
// has two pages and Visibility-in-one-place is more useful than cleverness.

import { loadDataHtmlAndPage } from '../../../adapters/rendering/pageLoader.mjs'
import { sdkAddonsForApp } from '../../../common/helpers/sdkAddons.mjs'

const APP_NAME = 'info.freezr.connections'

const PAGE_MANIFESTS = {
  index: {
    page_title: 'Connections',
    css_files: ['/app/info.freezr.public/public/freezr_style.css'],
    page_url: 'index.html',
    script_files: ['index.js']
  },
  mail: {
    page_title: 'Mail (Connections)',
    css_files: ['/app/info.freezr.public/public/freezr_style.css', 'mail.css'],
    page_url: 'mail.html',
    script_files: ['mail.js']
  },
  contacts: {
    page_title: 'Contacts (Connections)',
    css_files: ['/app/info.freezr.public/public/freezr_style.css'],
    page_url: 'contacts.html',
    script_files: ['contacts.js']
  },
  calendar: {
    page_title: 'Calendar (Connections)',
    css_files: ['/app/info.freezr.public/public/freezr_style.css'],
    page_url: 'calendar.html',
    script_files: ['calendar.js']
  },
  new: {
    page_title: 'Connect a New Account',
    css_files: ['/app/info.freezr.public/public/freezr_style.css'],
    page_url: 'new.html',
    script_files: ['new.js']
  },
  edit: {
    page_title: 'Edit Connection',
    css_files: ['/app/info.freezr.public/public/freezr_style.css'],
    page_url: 'edit.html',
    script_files: ['edit.js']
  }
}

const generateConnectionsPage = async (req, res) => {
  try {
    const appFS = res.locals.freezr?.appFS
    if (!appFS) {
      console.error('appFS not found for connections page')
      return res.status(500).send('Internal server error - appFS not available')
    }

    const pageName = req.params.page || 'index'
    const pageManifest = PAGE_MANIFESTS[pageName]
    if (!pageManifest) {
      return res.status(404).send('Unknown connections page: ' + pageName)
    }

    const options = {
      page_title: pageManifest.page_title,
      css_files: pageManifest.css_files,
      page_url: pageManifest.page_url,
      app_name: APP_NAME,
      script_files: [],
      modules: pageManifest.script_files || [],
      server_name: res.locals.freezr.serverName,
      freezr_server_version: res.locals.freezr.freezrVersion,
      user_id: req.session.logged_in_user_id,
      user_is_admin: req.session.logged_in_as_admin,
      user_is_publisher: req.session.logged_in_as_publisher,
      other_variables: 'const thisPage = "' + pageName + '";',
      // info.freezr.connections declares use_mail in its manifest (and has a
      // use_mail shortcut in systemPermissions.json) — pulls in
      // freezrApiV2.connections.js so mail.js can call freezr.connections.mail.*.
      sdkAddons: sdkAddonsForApp(APP_NAME, null)
    }

    // Set the app-token cookie on the paths this page can be reached from,
    // so the page's JS can authenticate /feps/connections/mail/* etc. calls without an
    // extra round-trip. Mirrors creator's cookie scoping.
    if (res.locals.freezr?.tokenInfo?.app_token) {
      const cookieName = 'app_token_' + req.session.logged_in_user_id
      const token = res.locals.freezr.tokenInfo.app_token
      res.cookie(cookieName, token, { path: '/connections' })
      res.cookie(cookieName, token, { path: '/app/' + APP_NAME })
      res.cookie(cookieName, token, { path: '/apps/' + APP_NAME })
    }

    res.locals.freezr.permGiven = true
    return loadDataHtmlAndPage(appFS, res, options)
  } catch (error) {
    console.error('Error generating connections page:', error)
    return res.status(500).send('Internal server error')
  }
}

export const createConnectionsPageController = () => ({ generateConnectionsPage })

export default createConnectionsPageController
