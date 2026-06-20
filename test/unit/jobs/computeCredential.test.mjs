// Unit tests for the compute credential crypto branch + credential service (Phase 6.5) — no server.
import { expect } from 'chai'
import { encryptResourceSensitiveFields, decryptResourceSensitiveFields } from '../../../features/account/services/resourceCrypto.mjs'
import { userHasComputeCredential, getUserComputeCredential, listComputeCredentials } from '../../../features/jobs/services/computeCredentialService.mjs'

const SECRET = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'shh-very-secret', arnRole: 'arn:aws:iam::1:role/freezrLambdaRole' }
const computeRec = (over = {}) => ({ type: 'compute', provider: 'aws', name: 'my-aws', region: 'eu-central-1', secret: { ...SECRET }, ...over })

describe('resourceCrypto type:compute', function () {
  it('round-trips the secret (encrypt then decrypt recovers it)', function () {
    const enc = encryptResourceSensitiveFields(computeRec())
    const dec = decryptResourceSensitiveFields(enc)
    expect(dec.secret).to.deep.equal(SECRET)
    // non-sensitive fields untouched
    expect(dec.provider).to.equal('aws')
    expect(dec.region).to.equal('eu-central-1')
  })

  it('encrypts at rest when FREEZR_ENV_KEY is set (secret is not stored in cleartext)', function () {
    const prev = process.env.FREEZR_ENV_KEY
    process.env.FREEZR_ENV_KEY = 'x'.repeat(48)
    try {
      const enc = encryptResourceSensitiveFields(computeRec())
      // the stored secret must not contain the plaintext key
      expect(JSON.stringify(enc.secret)).to.not.include('shh-very-secret')
      // and still decrypts back
      expect(decryptResourceSensitiveFields(enc).secret).to.deep.equal(SECRET)
    } finally {
      if (prev === undefined) delete process.env.FREEZR_ENV_KEY
      else process.env.FREEZR_ENV_KEY = prev
    }
  })

  it('no-ops a record without a secret', function () {
    const r = { type: 'compute', provider: 'aws' }
    expect(encryptResourceSensitiveFields(r)).to.deep.equal(r)
    expect(decryptResourceSensitiveFields(r)).to.deep.equal(r)
  })
})

// Fake resources db: query({type}) returns matching rows.
function fakeResourcesDb (rows) {
  return { async query (q) { return rows.filter(r => !q || !q.type || r.type === q.type) } }
}

describe('computeCredentialService', function () {
  it('userHasComputeCredential is false with no compute rows', async function () {
    const db = fakeResourcesDb([{ type: 'llm', key: 'k' }])
    expect(await userHasComputeCredential(db)).to.be.false
  })

  it('userHasComputeCredential is true when a compute credential exists', async function () {
    const db = fakeResourcesDb([encryptResourceSensitiveFields(computeRec())])
    expect(await userHasComputeCredential(db)).to.be.true
    expect(await userHasComputeCredential(db, { provider: 'aws' })).to.be.true
    expect(await userHasComputeCredential(db, { provider: 'gcp' })).to.be.false
  })

  it('getUserComputeCredential returns a decrypted, runner-ready credential', async function () {
    const db = fakeResourcesDb([encryptResourceSensitiveFields(computeRec({ _id: 'r1' }))])
    const cred = await getUserComputeCredential(db, { provider: 'aws' })
    expect(cred).to.be.an('object')
    expect(cred.provider).to.equal('aws')
    expect(cred.region).to.equal('eu-central-1')
    expect(cred.credentials).to.deep.equal({
      accessKeyId: SECRET.accessKeyId,
      secretAccessKey: SECRET.secretAccessKey,
      arnRole: SECRET.arnRole,
      region: 'eu-central-1'
    })
  })

  it('getUserComputeCredential prefers the default credential', async function () {
    const db = fakeResourcesDb([
      encryptResourceSensitiveFields(computeRec({ _id: 'a', name: 'first', secret: { ...SECRET, accessKeyId: 'FIRST' } })),
      encryptResourceSensitiveFields(computeRec({ _id: 'b', name: 'second', default: true, secret: { ...SECRET, accessKeyId: 'DEFAULT' } }))
    ])
    const cred = await getUserComputeCredential(db)
    expect(cred.credentials.accessKeyId).to.equal('DEFAULT')
  })

  it('getUserComputeCredential returns null when the user has none', async function () {
    const db = fakeResourcesDb([{ type: 'connection', oauth: {} }])
    expect(await getUserComputeCredential(db)).to.be.null
  })

  it('listComputeCredentials returns only compute rows', async function () {
    const db = fakeResourcesDb([{ type: 'llm' }, encryptResourceSensitiveFields(computeRec()), { type: 'connection' }])
    const list = await listComputeCredentials(db)
    expect(list).to.have.length(1)
    expect(list[0].type).to.equal('compute')
  })
})
