// App install: one install per user+app at a time, and failures reported as InstallError.
//
// Why: on 2026-10-05 (Azure) a URL install was 503'd by the request watchdog while it carried on in
// the background; the user retried with zip uploads and the concurrent installs - which share
// tempapps/<app> and apps/<app> - deleted each other's folders mid-extraction (ENOTEMPTY / ENOENT).
// The user saw raw server paths and errno codes.
//
// Runs oneUserInstallationProcess against fakes, with the temp folder in os.tmpdir().
import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { zipSync, strToU8 } from 'fflate'
import { oneUserInstallationProcess, InstallError } from '../../../features/account/services/appInstallService.mjs'
import { deleteLocalFolderAndContents } from '../../../adapters/datastore/fsConnectors/fileHandler.mjs'
import { sendFailure } from '../../../adapters/http/responses.mjs'

const APP = 'com.test.lockapp'
const USER = 'lockuser'

const appZip = () => Buffer.from(zipSync({
  'manifest.json': strToU8(JSON.stringify({ identifier: APP, display_name: 'Lock App' })),
  'index.html': strToU8('<p>hi</p>'),
  'modules/a.js': strToU8('export const a = 1')
}))

// A gate the fake app-list query waits on, so a first install can be held mid-flight (after it has
// extracted to the temp folder) while a second one starts.
const makeGate = () => {
  let open
  const promise = new Promise(resolve => { open = resolve })
  return { promise, open }
}

const makeContext = (rootFolder, { gate, buffer } = {}) => ({
  userId: USER,
  userDS: {
    fsParams: { rootFolder },
    appfiles: {},
    // Ends every install at step 4 - far enough to exercise the lock and the temp folder
    getorInitAppFS: async () => { throw new Error('fake storage unavailable') }
  },
  ownerPermsDb: {},
  userAppListDb: {
    query: async () => { if (gate) await gate.promise; return [] }
  },
  errorLogger: { info () {}, warn () {}, error () {} },
  file: { originalname: APP + '.zip', buffer: buffer || appZip() },
  warnings: [],
  installInfo: { isUpdate: false }
})

describe('app install lock and errors', function () {
  let root
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'freezr-install-')) })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const tempFolder = () => path.join(root, USER, 'tempapps', APP)

  it('refuses a second install of the same app while one is running, without touching its temp folder', async () => {
    const gate = makeGate()
    const first = oneUserInstallationProcess(makeContext(root, { gate }))
    const firstOutcome = first.catch(e => e)

    // Wait until the first install has extracted into the temp folder and is parked on the gate
    for (let i = 0; i < 50 && !fs.existsSync(path.join(tempFolder(), 'modules', 'a.js')); i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(fs.existsSync(path.join(tempFolder(), 'modules', 'a.js'))).to.equal(true)

    let second
    try {
      await oneUserInstallationProcess(makeContext(root))
    } catch (e) { second = e }
    expect(second).to.be.instanceOf(InstallError)
    expect(second.code).to.equal('install_in_progress')
    expect(second.statusCode).to.equal(409)
    expect(second.userMessage).to.contain(APP)
    // The refused install must not clean up the running install's work
    expect(fs.existsSync(path.join(tempFolder(), 'modules', 'a.js'))).to.equal(true)

    gate.open()
    const firstErr = await firstOutcome
    expect(firstErr).to.be.instanceOf(InstallError)
    expect(firstErr.code).to.equal('install_failed')
    expect(firstErr.step).to.equal('setup_app_storage')
    expect(firstErr.cause.message).to.equal('fake storage unavailable')
    // The failed install cleaned up its own temp folder
    expect(fs.existsSync(tempFolder())).to.equal(false)
  })

  it('releases the lock when an install finishes (here: fails), so the next one can run', async () => {
    let err1, err2
    try { await oneUserInstallationProcess(makeContext(root)) } catch (e) { err1 = e }
    try { await oneUserInstallationProcess(makeContext(root)) } catch (e) { err2 = e }
    expect(err1.code).to.equal('install_failed')
    expect(err2.code).to.equal('install_failed') // not install_in_progress
  })

  it('reports an unreadable zip as zip_extract_failed, with no server path in the user message', async () => {
    let err
    try {
      await oneUserInstallationProcess(makeContext(root, { buffer: Buffer.from('not a zip file at all') }))
    } catch (e) { err = e }
    expect(err).to.be.instanceOf(InstallError)
    expect(err.code).to.equal('zip_extract_failed')
    expect(err.step).to.equal('extract_zip')
    expect(err.userMessage).to.not.contain(root)
    expect(err.userMessage).to.not.contain('tempapps')
    expect(err.message).to.contain('extract_zip') // the server log keeps the detail
  })

  it('reports a wrong file type as a 400 invalid_request', async () => {
    const ctx = makeContext(root)
    ctx.file.originalname = APP + '.tar'
    let err
    try { await oneUserInstallationProcess(ctx) } catch (e) { err = e }
    expect(err.code).to.equal('invalid_request')
    expect(err.statusCode).to.equal(400)
  })
})

describe('deleteLocalFolderAndContents', function () {
  let root
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'freezr-delete-')) })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('is a no-op for a folder that does not exist', async () => {
    await deleteLocalFolderAndContents(path.join(root, 'nope', 'missing'))
  })

  it('deletes a nested folder', async () => {
    const dir = path.join(root, 'app')
    fs.mkdirSync(path.join(dir, 'modules', 'publish'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'modules', 'publish', 'publishImages.js'), 'x')
    fs.writeFileSync(path.join(dir, 'LICENSE'), 'x')
    await deleteLocalFolderAndContents(dir)
    expect(fs.existsSync(dir)).to.equal(false)
  })
})

describe('sendFailure with an InstallError', function () {
  const fakeRes = () => {
    const res = { locals: { flogger: { logged: [], error (...args) { this.logged.push(args) } } } }
    res.status = (code) => { res.statusCode = code; return res }
    res.json = (body) => { res.body = body; return res }
    return res
  }

  it('sends the user message, code and status, and logs the detail with the cause', () => {
    const cause = new Error('ENOENT: no such file or directory, open \'/srv/users_freezr/u/tempapps/x/a.js\'')
    const err = new InstallError('zip_extract_failed', 'Installing x failed while unpacking the zip file.', {
      cause, detail: 'install of x failed at step "extract_zip": ' + cause.message, step: 'extract_zip', statusCode: 500
    })
    const res = fakeRes()
    sendFailure(res, err, { function: 'test' }, 500)
    expect(res.statusCode).to.equal(500)
    expect(res.body).to.deep.equal({ success: false, error: 'Installing x failed while unpacking the zip file.', code: 'zip_extract_failed' })
    const logged = res.locals.flogger.logged[0]
    expect(logged[0]).to.contain('ENOENT')
    expect(logged[2]).to.equal(cause)
  })

  it('leaves ordinary errors unchanged', () => {
    const res = fakeRes()
    sendFailure(res, new Error('plain failure'), 'test', 500)
    expect(res.body).to.deep.equal({ success: false, error: 'plain failure' })
    expect(res.locals.flogger.logged[0]).to.have.length(2)
  })
})
