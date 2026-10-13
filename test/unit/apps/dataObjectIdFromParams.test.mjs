// Unit tests for dataObjectIdFromParams (cepsfepsApiController.mjs): how a read / update / delete
// route recovers a record id that contains '/' (an uploaded file's id is its path). Checked against
// REAL Express routing, because the point is how Express matches and decodes these URLs.
import { expect } from 'chai'
import express from 'express'
import { dataObjectIdFromParams } from '../../../features/apps/controllers/cepsfepsApiController.mjs'

describe('dataObjectIdFromParams', () => {
  let server
  let base

  before(async () => {
    // Same route shapes as /ceps/read, /ceps/update and /ceps/delete.
    const app = express()
    const router = express.Router()
    const answer = (req, res) => res.json({ id: dataObjectIdFromParams(req.params), rawPath: req.path })
    router.get('/read/:app_table/:data_object_id', answer)
    router.get('/read/:app_table/:data_object_start/*', answer)
    app.use('/ceps', router)
    await new Promise((resolve) => { server = app.listen(0, resolve) })
    base = 'http://127.0.0.1:' + server.address().port + '/ceps/read/com.example.app.files/'
  })

  after(() => new Promise((resolve) => server.close(resolve)))

  const idFor = async (pathAfterTable) => (await (await fetch(base + pathAfterTable)).json())

  it('returns a plain id unchanged', async () => {
    expect((await idFor('abc123')).id).to.equal('abc123')
  })

  it('rejoins an id with several folders', async () => {
    expect((await idFor('projects/freezr-pitch-2026/draft/index.html')).id).to.equal('projects/freezr-pitch-2026/draft/index.html')
  })

  it('decodes characters in every part — the old req.path rebuild did not', async () => {
    const r = await idFor('projects/p/draft/assets/hipercards%20screenshot.jpg')
    expect(r.id).to.equal('projects/p/draft/assets/hipercards screenshot.jpg')
    expect(r.rawPath).to.include('%20') // what the previous rejoin (req.path.split('/')…) would have used
    expect((await idFor('caf%C3%A9/men%C3%BC.pdf')).id).to.equal('café/menü.pdf')
  })

  it('handles params directly (no route)', () => {
    expect(dataObjectIdFromParams({ data_object_id: 'x' })).to.equal('x')
    expect(dataObjectIdFromParams({ data_object_start: 'a', 0: 'b/c' })).to.equal('a/b/c')
    expect(dataObjectIdFromParams({})).to.equal(undefined)
  })
})
