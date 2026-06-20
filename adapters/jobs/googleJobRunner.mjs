// freezr.info — GoogleRunner STUB (plan §9 — multi-cloud seam, not yet implemented)
//
// Google Cloud Functions / Cloud Run use a 'source' packaging model: the dev's source + a
// package.json is uploaded and the CLOUD installs deps in the USER's own cloud (consistent with
// "freezr never installs" — the install happens in the user's GCP project, not on the freezr host).
// That differs from AWS's 'prebuilt' zip, which is why this is a separate runner rather than a flag.
//
// Implement against the JobRunner contract in jobRunner.mjs (exists/deploy/remove/invoke). Until
// then every method makes the unsupported path explicit rather than silently failing.

const notImplemented = () => { const e = new Error('GoogleRunner not implemented yet (plan §9)'); e.code = 'RUNNER_NOT_IMPLEMENTED'; throw e }

export function createGoogleJobRunner () {
  return {
    packaging: 'source',
    async exists () { notImplemented() },
    async deploy () { notImplemented() },
    async remove () { notImplemented() },
    async invoke () { notImplemented() }
  }
}

export default { createGoogleJobRunner }
