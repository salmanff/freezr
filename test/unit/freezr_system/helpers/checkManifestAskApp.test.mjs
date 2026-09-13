// Unit tests for checkManifest's ask-app name <-> app_type consistency warnings.
// See freezr_askapps_plan_v1.md — a ask-app IS a normal app; the installer flags a mismatch
// between the reserved ask-app. name prefix and the manifest's app_type:'askapp'.
import { expect } from 'chai'
import { describe, it } from 'mocha'
import { checkManifest } from '../../../../adapters/datastore/fsConnectors/fileHandler.mjs'

const codesOf = (result) => result.warnings.map((w) => w.code)

describe('checkManifest — ask-app name/app_type consistency', () => {
  it('warns when a ask-app.* name has no app_type:askapp', () => {
    const result = checkManifest({ identifier: 'ask-app.foo.ab12', display_name: 'Foo', version: '0.01' }, 'ask-app.foo.ab12', '0.01')
    expect(codesOf(result)).to.include('manifest_askapp_name_without_type')
  })

  it('does NOT warn when name and app_type agree (askapp + askapp)', () => {
    const result = checkManifest({ identifier: 'ask-app.foo.ab12', app_type: 'askapp', display_name: 'Foo', version: '0.01' }, 'ask-app.foo.ab12', '0.01')
    expect(codesOf(result)).to.not.include('manifest_askapp_name_without_type')
    expect(codesOf(result)).to.not.include('manifest_askapp_type_without_name')
  })

  it('warns when app_type:askapp is declared but the name is not in the namespace', () => {
    const result = checkManifest({ identifier: 'com.example.app', app_type: 'askapp', display_name: 'App', version: '0.01' }, 'com.example.app', '0.01')
    expect(codesOf(result)).to.include('manifest_askapp_type_without_name')
  })

  it('does NOT warn for an ordinary app with no app_type', () => {
    const result = checkManifest({ identifier: 'com.example.app', display_name: 'App', version: '0.01' }, 'com.example.app', '0.01')
    expect(codesOf(result)).to.not.include('manifest_askapp_name_without_type')
    expect(codesOf(result)).to.not.include('manifest_askapp_type_without_name')
  })
})
