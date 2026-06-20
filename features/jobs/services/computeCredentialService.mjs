// freezr.info — Compute credential service (the cloud-cost gate, plan §4.2 / §14.1) computeCredentialService.mjs (r0)
//
// A user's serverless compute credential is a `type:'compute'` record in their own
// info.freezr.account.resources table (encrypted via resourceCrypto). Per §14.1 compute tokens
// are PER-USER (never lent), so "can this job run on the cloud?" == "does the acting user have a
// compute credential?". Handle-based per the freezr principle: the caller opens the resources db
// and passes the handle — these functions never see dsManager.
//
//   record shape: { type:'compute', provider:'aws', name, region, default,
//                   secret:{ accessKeyId, secretAccessKey, arnRole } }   // secret encrypted at rest

import { decryptResourceSensitiveFields } from '../../account/services/resourceCrypto.mjs'

/** All of the user's compute credentials (secrets still encrypted). */
export async function listComputeCredentials (resourcesDb) {
  if (!resourcesDb) throw new Error('computeCredentialService: resourcesDb handle required')
  return (await resourcesDb.query({ type: 'compute' }, {})) || []
}

/** Cloud-cost gate: does the user have a usable compute credential (optionally for a provider)? */
export async function userHasComputeCredential (resourcesDb, { provider = null } = {}) {
  const rows = await listComputeCredentials(resourcesDb)
  return rows.some(r => (!provider || r.provider === provider) && r.secret)
}

/**
 * Pick + decrypt the credential to use for a run. Prefers the `default` one, else the first of the
 * requested provider. Returns a runner-ready shape, or null if the user has none.
 * @returns {null | { _id, provider, name, region, credentials: { accessKeyId, secretAccessKey, arnRole, region } }}
 */
export async function getUserComputeCredential (resourcesDb, { provider = 'aws' } = {}) {
  const rows = await listComputeCredentials(resourcesDb)
  const candidates = rows.filter(r => (!provider || r.provider === provider) && r.secret)
  if (!candidates.length) return null
  const chosen = candidates.find(r => r.default) || candidates[0]
  const secret = (decryptResourceSensitiveFields(chosen).secret) || {}
  return {
    _id: chosen._id,
    provider: chosen.provider,
    name: chosen.name,
    region: chosen.region,
    credentials: {
      accessKeyId: secret.accessKeyId,
      secretAccessKey: secret.secretAccessKey,
      arnRole: secret.arnRole,
      region: chosen.region || secret.region
    }
  }
}

export default { listComputeCredentials, userHasComputeCredential, getUserComputeCredential }
