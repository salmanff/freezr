// freezrApiV2.serverless.js - Freezr SDK add-on for serverless / 3p-function access
// Version 2.0.0 - 2026
//
// Attaches `freezr.serverless` to the global `freezr` object created by
// freezrApiV2.js (core). Loaded only when the app's manifest declares either
// use_serverless or use_3pFunction, or when the systemPermissions.json
// registry has a matching shortcut for the app (see common/helpers/sdkAddons.mjs +
// adapters/rendering/pageLoader.mjs).
//
// Surface:
//   freezr.serverless.invokeCloud / invokeLocal / createInvokeCloud
//   freezr.serverless.upsertCloud / updateCloud / deleteCloud / roleCreateCloud / deleteRole
//   freezr.serverless.upsertLocal / deleteLocal / getAllLocalFunctions
// Server-side permission enforcement happens at /feps/serverless/<task> based on
// the granted permission record — the add-on just builds the request.

/* global freezr, freezrMeta */

if (typeof freezr === 'undefined') {
  console.error('freezrApiV2.serverless.js loaded before freezrApiV2.js core — skipping. Check manifest script order.')
} else {
  console.log('Running freezrApiV2.serverless.js !!')

  freezr.serverless = {
    async _deliverTask (options) {
      if (!options || !options.task) {
        throw new Error('No options sent.')
      }
      // The /feps/serverless route does the function-name validation server-side.
      const url = (options.host || '') + '/feps/serverless/' + options.task
      const writeOptions = { }
      if (options.appToken) {
        writeOptions.appToken = options.appToken
        delete options.appToken
        delete options.host
      }
      if (options.file) {
        writeOptions.uploadFile = true
        const uploadData = new FormData()
        uploadData.append('file', options.file)
        const newOptions = {}
        Object.keys(options).forEach((key) => { if (key !== 'file') newOptions[key] = options[key] })
        uploadData.append('options', JSON.stringify(newOptions))
        return freezr.apiRequest('PUT', url, uploadData, writeOptions)
      } else if (options.useGet) {
        return freezr.apiRequest('GET', url, null)
      } else {
        return freezr.apiRequest('PUT', url, options, { ...writeOptions, contentType: 'application/json' })
      }
    },
    invokeCloud:         async (options) => freezr.serverless._deliverTask({ ...options, task: 'invokeserverless' }),
    invokeLocal:         async (options) => freezr.serverless._deliverTask({ ...options, task: 'invokelocalservice' }),
    createInvokeCloud:   async (options) => freezr.serverless._deliverTask({ ...options, task: 'createinvokeserverless' }),
    upsertCloud:         async (options) => freezr.serverless._deliverTask({ ...options, task: 'upsertserverless' }),
    updateCloud:         async (options) => freezr.serverless._deliverTask({ ...options, task: 'updateserverless' }),
    deleteCloud:         async (options) => freezr.serverless._deliverTask({ ...options, task: 'deleteserverless' }),
    roleCreateCloud:     async (options) => freezr.serverless._deliverTask({ ...options, task: 'rolecreateserverless' }),
    deleteRole:          async (options) => freezr.serverless._deliverTask({ ...options, task: 'deleterole' }),
    upsertLocal:         async (options) => freezr.serverless._deliverTask({ ...options, task: 'upsertlocalservice' }),
    deleteLocal:         async (options) => freezr.serverless._deliverTask({ ...options, task: 'deletelocalfunction' }),
    getAllLocalFunctions: async (options) => freezr.serverless._deliverTask({ ...options, useGet: true, task: 'getalllocalfunctions' })
  }
}
