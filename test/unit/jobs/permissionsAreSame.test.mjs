// Unit tests for permissionsAreSame — re-install must NOT drop a granted permission just because the
// USER set an optional field (run_job/schedule_job `location`, use_mail `scopes`) the manifest never
// declares. App-declared optional fields (job_name, or shipped default scopes) that change DO re-prompt.
import { expect } from 'chai'
import { permissionsAreSame } from '../../../middleware/permissions/permissionCore.mjs'

describe('permissionsAreSame (user-set optional fields)', function () {
  it('keeps a granted run_job permission when only the user-set `location` differs', function () {
    const manifest = { type: 'run_job', name: 'run_counter', job_name: 'increment' } // manifest never declares location
    const existing = { type: 'run_job', name: 'run_counter', job_name: 'increment', location: 'cloud', granted: true }
    expect(permissionsAreSame(manifest, existing)).to.be.true
  })

  it('re-prompts when the app-declared `job_name` changes', function () {
    const manifest = { type: 'run_job', name: 'run_counter', job_name: 'increment' }
    const existing = { type: 'run_job', name: 'run_counter', job_name: 'decrement', granted: true }
    expect(permissionsAreSame(manifest, existing)).to.be.false
  })

  it('keeps a granted schedule_job permission when only the user-set `location` differs', function () {
    const manifest = { type: 'schedule_job', name: 'schedule_counter', job_name: 'increment' }
    const existing = { type: 'schedule_job', name: 'schedule_counter', job_name: 'increment', location: 'local', granted: true }
    expect(permissionsAreSame(manifest, existing)).to.be.true
  })

  it('ignores use_mail user-set `scopes`/`connection_names` when the manifest does not declare them', function () {
    const manifest = { type: 'use_mail', name: 'read_mail' }
    const existing = { type: 'use_mail', name: 'read_mail', scopes: ['read'], connection_names: ['gmail'], granted: true }
    expect(permissionsAreSame(manifest, existing)).to.be.true
  })

  it('still compares use_mail `scopes` when the manifest DOES declare them (app changed its ask)', function () {
    const manifest = { type: 'use_mail', name: 'read_mail', scopes: ['read', 'write'] }
    const existing = { type: 'use_mail', name: 'read_mail', scopes: ['read'], granted: true }
    expect(permissionsAreSame(manifest, existing)).to.be.false
  })

  it('detects a genuine core change regardless of user-set fields', function () {
    const manifest = { type: 'run_job', name: 'run_counter', job_name: 'increment', table_id: 'app.counters' }
    const existing = { type: 'run_job', name: 'run_counter', job_name: 'increment', table_id: 'app.other', location: 'cloud', granted: true }
    expect(permissionsAreSame(manifest, existing)).to.be.false
  })
})
