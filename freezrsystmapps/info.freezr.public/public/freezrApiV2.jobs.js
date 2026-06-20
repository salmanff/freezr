/* freezrApiV2.jobs.js — the freezr.jobs client surface (run / schedule / unschedule / ping).
 *
 * Loaded for apps that hold a run_job or schedule_job permission (see common/freezrApiClient.manifest.json),
 * in both the browser and the job vm client. Mirrors freezr.llm / freezr.connections: thin wrappers
 * over freezr.apiRequest(method, path, body, options) which returns parsed JSON and throws on non-2xx
 * (err.status, err.data).
 */
if (typeof freezr === 'undefined') {
  console.error('freezrApiV2.jobs.js loaded before freezrApiV2.js core — skipping freezr.jobs')
} else {
  console.log('Running freezrApiV2.jobs.js !!')

  freezr.jobs = {
    // Run a job ON DEMAND. `name` is the app's own job id, or a fully-qualified third-party job id
    // '<ownerApp>.jobs.<job>'. opts.location ('local'|'cloud') is a dev override, honored only when
    // the user's grant location is 'auto'. Requires run_job (third-party) / optional for own jobs.
    async run (name, params = {}, opts = {}) {
      const body = { params: params || {} }
      if (opts.location) body.location = opts.location
      const writeOptions = opts.appToken ? { appToken: opts.appToken } : {}
      return freezr.apiRequest('POST', (opts.host || '') + '/jobs/run/' + encodeURIComponent(name), body, writeOptions)
    },

    // START the recurring schedule for the app's own job. Granting schedule_job is consent only —
    // it does NOT start the schedule; the app calls this when scheduling is meaningful. Requires the
    // user's schedule_job grant for the job.
    async schedule (name, opts = {}) {
      const writeOptions = opts.appToken ? { appToken: opts.appToken } : {}
      return freezr.apiRequest('POST', (opts.host || '') + '/jobs/schedule/' + encodeURIComponent(name), {}, writeOptions)
    },

    // STOP the recurring schedule for the app's own job.
    async unschedule (name, opts = {}) {
      const writeOptions = opts.appToken ? { appToken: opts.appToken } : {}
      return freezr.apiRequest('POST', (opts.host || '') + '/jobs/unschedule/' + encodeURIComponent(name), {}, writeOptions)
    },

    // Ask what the app can do: { has_compute, jobs: { <job>: { run_job_granted, schedule_job_granted,
    // trusted, scheduled, location } } }. Lets the app decide if/where it can run before trying.
    async ping (opts = {}) {
      const writeOptions = opts.appToken ? { appToken: opts.appToken } : {}
      return freezr.apiRequest('GET', (opts.host || '') + '/jobs/ping', null, writeOptions)
    }
  }
}
