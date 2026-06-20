// freezr.info — AzureRunner STUB (plan §9 — multi-cloud seam, not yet implemented)
//
// Azure Functions use a 'source' packaging model (the dev's source + package.json; deps install in
// the USER's Azure subscription), like GoogleRunner and unlike AWS's 'prebuilt' zip. @azure/identity
// and @azure/storage-blob are already deps; a real impl would deploy via the Functions APIs.
//
// Implement against the JobRunner contract in jobRunner.mjs (exists/deploy/remove/invoke).

const notImplemented = () => { const e = new Error('AzureRunner not implemented yet (plan §9)'); e.code = 'RUNNER_NOT_IMPLEMENTED'; throw e }

export function createAzureJobRunner () {
  return {
    packaging: 'source',
    async exists () { notImplemented() },
    async deploy () { notImplemented() },
    async remove () { notImplemented() },
    async invoke () { notImplemented() }
  }
}

export default { createAzureJobRunner }
