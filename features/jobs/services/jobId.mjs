// freezr.info — Job id parsing, shared by the jobs routes and capability reporting.
//
// A job is addressed like a collection: <ownerApp>.jobs.<jobName> (the "jobs" segment is
// reserved). A bare name (no dots) is the CALLER's own job → owner = caller. A dotted name is a
// fully-qualified THIRD-PARTY job. Returns null if malformed.

const JOBS_SEG = '.jobs.'

export const parseJobId = (raw, callerApp) => {
  if (!raw || typeof raw !== 'string') return null
  if (raw.includes('.')) {
    const i = raw.indexOf(JOBS_SEG)
    if (i <= 0) return null // has dots but not the <app>.jobs.<name> convention
    const ownerApp = raw.slice(0, i)
    const jobName = raw.slice(i + JOBS_SEG.length)
    if (!/^[a-zA-Z0-9._-]+$/.test(ownerApp) || ownerApp.includes('..')) return null
    if (!/^[a-zA-Z0-9_-]+$/.test(jobName)) return null // single segment, no further dots
    return { ownerApp, jobName, qualifiedId: raw, isThirdParty: ownerApp !== callerApp }
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) return null
  return { ownerApp: callerApp, jobName: raw, qualifiedId: callerApp + JOBS_SEG + raw, isThirdParty: false }
}

export default { parseJobId }
