import { loadDataHtmlAndPage } from '../../../adapters/rendering/pageLoader.mjs'

const generateCreatorPage = async (req, res) => {
  try {
    const appFS = res.locals.freezr?.appFS
    if (!appFS) {
      console.error('appFS not found for creator page')
      return res.status(500).send('Internal server error - appFS not available')
    }

    const options = {
      page_title: 'Create Apps',
      css_files: ['/app/info.freezr.public/public/freezr_style.css', 'creator.css'],
      page_url: 'creator.html',
      app_name: 'info.freezr.creator',
      script_files: [],
      modules: ['creator.js'],
      server_name: res.locals.freezr.serverName,
      freezr_server_version: res.locals.freezr.freezrVersion,
      user_id: req.session.logged_in_user_id,
      user_is_admin: req.session.logged_in_as_admin,
      user_is_publisher: req.session.logged_in_as_publisher,
      other_variables: 'const thisPage = "creator";'
    }

    if (res.locals.freezr?.tokenInfo?.app_token) {
      const cookieName = 'app_token_' + req.session.logged_in_user_id
      const token = res.locals.freezr.tokenInfo.app_token
      res.cookie(cookieName, token, { path: '/creator' })
      res.cookie(cookieName, token, { path: '/app/info.freezr.creator' })
      res.cookie(cookieName, token, { path: '/apps/info.freezr.creator' })
    }

    res.locals.freezr.permGiven = true
    return loadDataHtmlAndPage(appFS, res, options)
  } catch (error) {
    console.error('Error generating creator page:', error)
    return res.status(500).send('Internal server error')
  }
}

export const createCreatorPageController = () => ({ generateCreatorPage })

export default createCreatorPageController
