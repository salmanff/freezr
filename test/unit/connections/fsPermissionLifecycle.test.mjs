// use_file_sys — permission lifecycle unit tests, modeled on jobPermissionLifecycle.test.mjs.
// Verifies the type is registered, its exception fields (connection_names / scopes) persist
// from the manifest onto the saved record, field types are validated, and the re-install
// merge keeps a grant when nothing changed but forces re-consent when the app widens scope.
import { expect } from 'chai'
import {
  isAllowedPermissionType,
  permissionTypesThatDontNeedTableId,
  getPermissionFieldTypeErrors
} from '../../../middleware/permissions/permissionDefinitions.mjs'
import {
  cleanedPermissionObjectFromManifestParams,
  cleanNewManifestAndMergeWithExistingToUpdatePermsDb
} from '../../../middleware/permissions/permissionCore.mjs'

const APP = 'com.example.filebrowser'

const manifestPerm = (fields = {}) => cleanedPermissionObjectFromManifestParams(APP, {
  type: 'use_file_sys',
  name: 'browse_docs',
  description: 'Browse your documents folder',
  ...fields
})

const grantedRecord = (cleaned, userSetFields = {}) => ({
  ...cleaned,
  _id: 'perm1',
  ...userSetFields, // e.g. connection_names / scopes chosen by the user at grant time
  granted: true,
  status: 'granted',
  outDated: false,
  revokeIsWip: false
})

describe('use_file_sys — type registration', function () {
  it('is an allowed permission type that needs no table_id', function () {
    expect(isAllowedPermissionType('use_file_sys')).to.equal(true)
    expect(permissionTypesThatDontNeedTableId()).to.include('use_file_sys')
  })

  it('validates exception field types (arrays required)', function () {
    expect(getPermissionFieldTypeErrors({ type: 'use_file_sys', name: 'x', connection_names: ['a'], scopes: ['read'] })).to.equal('')
    expect(getPermissionFieldTypeErrors({ type: 'use_file_sys', name: 'x', connection_names: 'a' })).to.include('use_file_sys')
    expect(getPermissionFieldTypeErrors({ type: 'use_file_sys', name: 'x', scopes: 'read' })).to.include('use_file_sys')
  })
})

describe('use_file_sys — manifest fields persist onto the record', function () {
  it('keeps connection_names and scopes declared in the manifest', function () {
    const perm = manifestPerm({ connection_names: ['home-documents'], scopes: ['read'] })
    expect(perm.connection_names).to.deep.equal(['home-documents'])
    expect(perm.scopes).to.deep.equal(['read'])
    expect(perm.type).to.equal('use_file_sys')
    expect(perm.name).to.equal('browse_docs')
  })

  it('drops fields not in the exception schema', function () {
    const perm = manifestPerm({ rootPath: '/etc' }) // an app may not smuggle store params
    expect(perm.rootPath).to.equal(undefined)
  })
})

describe('use_file_sys — re-install merge', function () {
  it('UNCHANGED manifest + user-set scoping at grant time → grant is KEPT (skip)', function () {
    // App declared no connection_names; the user narrowed via the picker at grant time.
    const existing = grantedRecord(manifestPerm(), { connection_names: ['home-documents'], scopes: ['read'] })
    const [op] = cleanNewManifestAndMergeWithExistingToUpdatePermsDb([manifestPerm()], [existing])
    expect(op.action, JSON.stringify(op)).to.equal('skip')
    expect(existing.connection_names, 'user scoping untouched').to.deep.equal(['home-documents'])
  })

  it('manifest DECLARES different connection_names → OUTDATED, must re-consent', function () {
    const existing = grantedRecord(manifestPerm({ connection_names: ['home-documents'] }))
    const manifestNow = manifestPerm({ connection_names: ['*'] }) // app now asks for everything
    const [op] = cleanNewManifestAndMergeWithExistingToUpdatePermsDb([manifestNow], [existing])
    expect(op.action).to.equal('update')
    expect(op.data.status).to.equal('outdated')
    expect(op.data.granted).to.equal(false)
  })

  it('a brand-new use_file_sys permission is created pending (not auto-granted)', function () {
    const [op] = cleanNewManifestAndMergeWithExistingToUpdatePermsDb([manifestPerm()], [])
    expect(op.action).to.equal('create')
    expect(op.data.granted).to.equal(false)
    expect(op.data.status).to.equal('pending')
  })
})
