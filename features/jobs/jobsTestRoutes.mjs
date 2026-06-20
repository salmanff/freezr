// freezr.info — Jobs TEST routes (mounted at /jobs ONLY when FREEZR_TEST_MODE — see froutes)
//
// These endpoints exist purely so the HTTP integration suite (test/integration/jobs/) can
// exercise lower layers without the full admin-app flow. They are NEVER registered in
// production (froutes only mounts this router in test mode), so no per-handler env guard is
// needed here. Nothing in this file is part of the real Jobs surface — that's jobsApiRoutes.mjs.
//
//   PUT    /jobs/selftest/inprocess        — internalApiClient verbs; proves in-process == HTTP /ceps
//   POST   /jobs/selftest/sessionless/:name — session-less job-token minting + run (the scheduler's auth path)
//   PUT    /jobs/selftest/trust/:name       — write a trust record to drive the run-now trust gate
//   DELETE /jobs/selftest/trust/:name       — remove a trust record (test cleanup)

import { Router } from 'express'
import { createSetupGuard, createGetAppTokenInfoFromheaderForApi } from '../../middleware/auth/basicAuth.mjs'
import { apiRateLimit } from '../../middleware/auth/apiRateLimiter.mjs'
import { addDataOwnerToContext } from '../apps/middleware/appContext.mjs'
import { createaddOwnerPermsDb } from '../../middleware/permissions/permissionContext.mjs'
import { sendApiSuccess, sendFailure } from '../../adapters/http/responses.mjs'
import { createInternalApiClient } from '../../adapters/jobs/internalApiClient.mjs'
import { createLocalJobRunner, parseDurationMs } from '../../adapters/jobs/localJobRunner.mjs'
import { mintJobToken } from './services/jobTokenService.mjs'
import { trustJob, untrustJob } from './services/trustedJobService.mjs'
import { enableJob, disableJob } from './services/scheduledJobsService.mjs'
import { createScheduler } from './scheduler.mjs'
import { createAddTrustedJobsDb, createAddAppTokenDb, createAddScheduledJobsDb } from './middleware/jobsContext.mjs'

export const createJobsTestRoutes = ({ dsManager, freezrPrefs, freezrStatus, logManager }) => {
  const router = Router()

  const setupGuard = createSetupGuard(dsManager, freezrPrefs)
  const getAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager, freezrPrefs, freezrStatus)
  const addOwnerPermDBs = createaddOwnerPermsDb(dsManager, freezrPrefs, freezrStatus)
  const addTrustedJobsDb = createAddTrustedJobsDb(dsManager, freezrPrefs)
  const addAppTokenDb = createAddAppTokenDb(dsManager)
  const addScheduledJobsDb = createAddScheduledJobsDb(dsManager, freezrPrefs)
  const internalApi = createInternalApiClient({ dsManager, freezrPrefs, freezrStatus, logManager })
  const localRunner = createLocalJobRunner({ dsManager, freezrPrefs, freezrStatus, logManager })
  // A scheduler instance for test-driven ticks (the live heartbeat is started elsewhere, opt-in).
  const scheduler = createScheduler({ dsManager, freezrPrefs, freezrStatus, logManager })

  const bearerFrom = (req) => {
    const h = req.headers.authorization || ''
    return h.startsWith('Bearer ') ? h.substring(7) : null
  }

  // PUT /jobs/selftest/inprocess — drive internalApiClient verbs (write → read → query).
  const selftestInprocess = async (req, res) => {
    const token = bearerFrom(req)
    const appTable = req.body.app_table
    if (!token || !appTable) return sendFailure(res, 'missing token or app_table', 'jobs.selftest', 400)
    try {
      const ctx = { flogger: res.locals.flogger }
      const stamp = req.body.stamp || ('s' + Date.now())
      const written = await internalApi.write(token, appTable, {
        _selftest: true, stamp, val: req.body.val ?? 1, msg: req.body.msg || 'hello-from-job'
      }, {}, ctx)
      const id = written._id || written.id
      const read = await internalApi.read(token, appTable, id, ctx)
      const queried = await internalApi.query(token, appTable, { stamp }, {}, ctx)
      res.locals.freezr.permGiven = true
      return sendApiSuccess(res, { written, read, queried, stamp })
    } catch (e) {
      return sendFailure(res, e, 'jobs.selftest', e.statusCode || 500)
    }
  }
  router.put('/selftest/inprocess', setupGuard, getAppTokenInfo, apiRateLimit, selftestInprocess)

  // PUT /jobs/selftest/trust/:name — trust a job. Body: { audience?, app_name? }.
  // app_name defaults to the caller's app, but may name a different OWNER app (to set up the
  // cross-app/third-party case in tests).
  const selftestTrust = async (req, res) => {
    const app = req.body.app_name || res.locals.freezr.tokenInfo.app_name
    const userId = res.locals.freezr.tokenInfo.owner_id
    const name = req.params.name
    const audience = req.body.audience || 'all_users'
    const rec = await trustJob(res.locals.freezr.trustedJobsDb, { appName: app, jobName: name, audience, installedBy: userId })
    res.locals.freezr.permGiven = true
    return sendApiSuccess(res, { trusted: true, app_name: app, audience: rec.audience })
  }
  router.put('/selftest/trust/:name', setupGuard, getAppTokenInfo, apiRateLimit, addTrustedJobsDb, selftestTrust)

  // DELETE /jobs/selftest/trust/:name?app_name= — remove a trust record (test cleanup).
  const selftestUntrust = async (req, res) => {
    const app = req.query.app_name || res.locals.freezr.tokenInfo.app_name
    const out = await untrustJob(res.locals.freezr.trustedJobsDb, app, req.params.name)
    res.locals.freezr.permGiven = true
    return sendApiSuccess(res, out)
  }
  router.delete('/selftest/trust/:name', setupGuard, getAppTokenInfo, apiRateLimit, addTrustedJobsDb, selftestUntrust)

  // PUT /jobs/selftest/grant/:name — grant the CALLER app a job permission for job_name=:name
  // (idempotent). Body: { type? ('run_job'|'schedule_job', default run_job), name? (unique perm name,
  // default '<type>:<job_name>'), location? }. :name is the JOB id; the perm's own `name` is unique.
  const selftestGrant = async (req, res) => {
    const callerApp = res.locals.freezr.tokenInfo.app_name
    const jobName = req.params.name
    const type = req.body.type || 'run_job'
    const permName = req.body.name || (type + ':' + jobName)
    const location = req.body.location || 'auto'
    const db = res.locals.freezr.ownerPermsDb
    const rec = { requestor_app: callerApp, type, name: permName, job_name: jobName, location, granted: true }
    const existing = await db.query({ requestor_app: callerApp, name: permName }, {})
    if (existing && existing[0]) await db.update(existing[0]._id, rec, { replaceAllFields: true })
    else await db.create(null, rec, {})
    res.locals.freezr.permGiven = true
    return sendApiSuccess(res, { granted: true, requestor_app: callerApp, type, name: permName, job_name: jobName })
  }
  router.put('/selftest/grant/:name', setupGuard, getAppTokenInfo, apiRateLimit, addDataOwnerToContext, addOwnerPermDBs, selftestGrant)

  // POST /jobs/selftest/sessionless/:name — mint a fresh session-less job token (NOT the caller's)
  // and run the job with it: the scheduler's auth path.
  const selftestSessionless = async (req, res) => {
    const app = res.locals.freezr.tokenInfo.app_name
    const userId = res.locals.freezr.tokenInfo.owner_id
    const name = req.params.name
    const callerToken = bearerFrom(req)
    const maxRuntime = req.body.maxRuntime || '30s'
    if (!await localRunner.exists(app, name)) {
      return sendFailure(res, 'job not found: ' + app + '/' + name, 'jobs.sessionless', 404)
    }
    try {
      // Token sized to the run (maxRuntime + grace) — not a long-lived credential.
      const mintedToken = await mintJobToken(res.locals.freezr.appTokenDb, {
        userId, appName: app, maxRuntimeMs: parseDurationMs(maxRuntime)
      })
      const out = await localRunner.run({
        app, name, token: mintedToken, params: req.body.params || {}, maxRuntime, flogger: res.locals.flogger
      })
      res.locals.freezr.permGiven = true
      return sendApiSuccess(res, {
        ...out,
        tokenType: 'job',
        mintedTokenDiffersFromCaller: mintedToken !== callerToken // never return the token itself
      })
    } catch (e) {
      return sendFailure(res, e, 'jobs.sessionless', e.statusCode || 500)
    }
  }
  router.post('/selftest/sessionless/:name', setupGuard, getAppTokenInfo, apiRateLimit, addAppTokenDb, selftestSessionless)

  // POST /jobs/selftest/mint_job_token — mint a session-less job token for the caller's (user, app)
  // and RETURN it. Test-only: lets the serverless-bundle test drive the generated entrypoint with
  // the EXACT token kind the cloud path mints (token_type:'job', no session) over real HTTP.
  const selftestMintToken = async (req, res) => {
    const app = res.locals.freezr.tokenInfo.app_name
    const userId = res.locals.freezr.tokenInfo.owner_id
    const maxRuntime = req.body.maxRuntime || '60s'
    const token = await mintJobToken(res.locals.freezr.appTokenDb, { userId, appName: app, maxRuntimeMs: parseDurationMs(maxRuntime) })
    res.locals.freezr.permGiven = true
    return sendApiSuccess(res, { token, app, userId })
  }
  router.post('/selftest/mint_job_token', setupGuard, getAppTokenInfo, apiRateLimit, addAppTokenDb, selftestMintToken)

  // PUT /jobs/selftest/schedule/:name — enable a scheduled job (minutely allowed in test mode).
  // Body: { schedule, maxRuntime?, app_name?, nextRunAt? }.
  const selftestSchedule = async (req, res) => {
    const appName = req.body.app_name || res.locals.freezr.tokenInfo.app_name
    const userId = res.locals.freezr.tokenInfo.owner_id
    const rec = await enableJob(res.locals.freezr.scheduledJobsDb, {
      userId, appName, jobName: req.params.name,
      schedule: req.body.schedule || 'minutely',
      maxRuntime: req.body.maxRuntime || null,
      nextRunAt: req.body.nextRunAt // e.g. 0 → due immediately
    })
    res.locals.freezr.permGiven = true
    return sendApiSuccess(res, { enabled: true, schedule: rec.schedule, next_run_at: rec.next_run_at })
  }
  router.put('/selftest/schedule/:name', setupGuard, getAppTokenInfo, apiRateLimit, addScheduledJobsDb, selftestSchedule)

  // DELETE /jobs/selftest/schedule/:name?app_name= — disable a scheduled job (test cleanup).
  const selftestUnschedule = async (req, res) => {
    const appName = req.query.app_name || res.locals.freezr.tokenInfo.app_name
    const out = await disableJob(res.locals.freezr.scheduledJobsDb, { userId: res.locals.freezr.tokenInfo.owner_id, appName, jobName: req.params.name })
    res.locals.freezr.permGiven = true
    return sendApiSuccess(res, out)
  }
  router.delete('/selftest/schedule/:name', setupGuard, getAppTokenInfo, apiRateLimit, addScheduledJobsDb, selftestUnschedule)

  // GET /jobs/selftest/sse_source — a route that STREAMS Server-Sent Events exactly like /feps/llm/ask
  // (setHeader + flushHeaders + res.write chunks + res.end). Used to prove the in-process client
  // captures a streamed response without invoking the real socket (regression for the llm-in-a-job
  // crash: ServerResponse.flushHeaders → outputData.push on a synthetic res).
  // ?chunks=N emits N delta events + a long final response, to exercise large/multi-chunk capture
  // (a long llm answer streams as many deltas). Default 2 — keep the basic case tiny.
  const sseSource = async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.flushHeaders()
    const chunks = Math.max(1, Math.min(2000, parseInt(req.query.chunks, 10) || 2))
    let full = ''
    for (let i = 0; i < chunks; i++) {
      const piece = 'piece' + i + '-' + 'x'.repeat(40) + ' '
      full += piece
      res.write('data: ' + JSON.stringify({ type: 'delta', text: piece }) + '\n\n')
    }
    res.write('data: ' + JSON.stringify({ type: 'done', success: true, response: full || 'hi there' }) + '\n\n')
    res.locals.freezr.permGiven = true
    return res.end()
  }
  router.get('/selftest/sse_source', setupGuard, getAppTokenInfo, apiRateLimit, sseSource)

  // POST /jobs/selftest/sse_via_inprocess — call the SSE route THROUGH the in-process client and
  // return what it captured ({ ok, status, bodyText }), so a test can verify streamed capture works.
  const sseViaInprocess = async (req, res) => {
    const token = bearerFrom(req)
    const chunks = parseInt(req.body && req.body.chunks, 10)
    const path = '/jobs/selftest/sse_source' + (chunks ? ('?chunks=' + chunks) : '')
    const out = await internalApi.dispatch('GET', path, {}, token, { flogger: res.locals.flogger })
    res.locals.freezr.permGiven = true
    return sendApiSuccess(res, out)
  }
  router.post('/selftest/sse_via_inprocess', setupGuard, getAppTokenInfo, apiRateLimit, sseViaInprocess)

  // POST /jobs/selftest/scheduler/tick — run one scheduler heartbeat now; returns what ran.
  const selftestSchedulerTick = async (req, res) => {
    const out = await scheduler.tick()
    res.locals.freezr.permGiven = true
    return sendApiSuccess(res, out)
  }
  router.post('/selftest/scheduler/tick', setupGuard, getAppTokenInfo, apiRateLimit, selftestSchedulerTick)

  return router
}

export default { createJobsTestRoutes }
