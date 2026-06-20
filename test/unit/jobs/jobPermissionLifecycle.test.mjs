// Flow for review item #2: a run_job permission PERSISTS job_name, run-time changes to user-set fields
// (location) keep the grant on re-install, but a job_name change forces re-consent. All pure functions
// (the install-time merge) — no server needed.
import { expect } from 'chai'
import {
  cleanedPermissionObjectFromManifestParams,
  cleanNewManifestAndMergeWithExistingToUpdatePermsDb
} from '../../../middleware/permissions/permissionCore.mjs'

const APP = 'com.example.incrementer'

// What an app's manifest declares for an on-demand job permission.
const manifestRunJob = (jobName) => cleanedPermissionObjectFromManifestParams(APP, {
  type: 'run_job', name: 'run_counter', job_name: jobName
})

// Simulate the stored record after the user GRANTED it and chose a location (user-set, not in manifest).
const grantedRecord = (cleanedManifestPerm, location) => ({
  ...cleanedManifestPerm,
  _id: 'perm1',
  location, // user-set at accept time
  granted: true,
  status: 'granted',
  outDated: false,
  revokeIsWip: false,
  grantees: [{ grantee: 'self' }]
})

describe('#2 — run_job job_name is PERSISTED onto the permission record', function () {
  it('cleanedPermissionObjectFromManifestParams keeps job_name (run-now authorizes by it)', function () {
    const perm = manifestRunJob('increment')
    expect(perm.job_name).to.equal('increment')
    expect(perm.name).to.equal('run_counter') // the perm's own unique key, distinct from the job
  })
})

describe('#2 — re-install merge keeps or re-prompts correctly', function () {
  it('UNCHANGED core + user-set location → grant is KEPT (skip), location preserved', function () {
    const existing = grantedRecord(manifestRunJob('increment'), 'cloud')
    const manifestNow = manifestRunJob('increment') // same app declaration, no location (user-set)
    const [op] = cleanNewManifestAndMergeWithExistingToUpdatePermsDb([manifestNow], [existing])
    expect(op.action, JSON.stringify(op)).to.equal('skip') // kept granted, not outdated
    expect(existing.location, 'user location untouched').to.equal('cloud')
  })

  it('CHANGED job_name → permission marked OUTDATED + granted:false (must re-consent)', function () {
    const existing = grantedRecord(manifestRunJob('increment'), 'cloud')
    const manifestNow = manifestRunJob('decrement') // app now points the SAME perm at a different job
    const [op] = cleanNewManifestAndMergeWithExistingToUpdatePermsDb([manifestNow], [existing])
    expect(op.action).to.equal('update')
    expect(op.data.status).to.equal('outdated')
    expect(op.data.granted).to.equal(false)
    expect(op.data.job_name).to.equal('decrement') // record now reflects the new declared job
  })

  it('a brand-new run_job permission is created pending (not auto-granted)', function () {
    const [op] = cleanNewManifestAndMergeWithExistingToUpdatePermsDb([manifestRunJob('increment')], [])
    expect(op.action).to.equal('create')
    expect(op.data.granted).to.equal(false)
    expect(op.data.status).to.equal('pending')
    expect(op.data.job_name).to.equal('increment')
  })
})
