// The <base> tag injected into an html main page served under a CUSTOM public id.
//
// At its canonical id a published page sits in the same URL folder as the files it ships with,
// so relative run-time URLs (fetch('slides.json'), <img src="pics/a.png">) resolve. Under a
// custom short id (/why2026) they resolve against the site root and the server answers with its
// not-found page - the fetch "succeeds" and hands back html. The server therefore injects a
// PATH-ONLY <base href> pointing at the canonical folder, and only in that case.

import { expect } from 'chai'
import { publicBaseTagFor } from '../../../features/public/controllers/publicPageController.mjs'

const OWNER = 'sfweb'
const TABLE = 'com.salmanff.orbit.files'
const FILE = 'projects/freezr-pitch-2026/public/index.html'
const CANONICAL = `@${OWNER}/${TABLE}/${FILE}`
const FOLDER = `/@${OWNER}/${TABLE}/projects/freezr-pitch-2026/public/`

const record = (overrides = {}) => ({
  data_owner: OWNER,
  original_app_table: TABLE,
  original_record_id: FILE,
  isHtmlMainPage: true,
  html_page: '<div class="deck">…</div>',
  ...overrides
})

describe('publicBaseTagFor', function () {
  it('injects a path-only base pointing at the canonical folder for a custom public id', function () {
    expect(publicBaseTagFor('why2026', record())).to.equal(`<base href="${FOLDER}">`)
  })

  it('is path-only - never carries a host or scheme', function () {
    const tag = publicBaseTagFor('why2026', record())
    expect(tag).to.not.match(/https?:/)
    expect(tag).to.match(/href="\//)
  })

  it('injects nothing at the canonical public id - relative URLs already resolve there', function () {
    expect(publicBaseTagFor(CANONICAL, record())).to.equal('')
  })

  it('works for a nested custom id too (the id, not its depth, is what matters)', function () {
    expect(publicBaseTagFor('decks/pitch/2026', record())).to.equal(`<base href="${FOLDER}">`)
  })

  it('honours a <base> the page already declares', function () {
    const withBase = record({ html_page: '<base href="https://elsewhere.example/">\n<div></div>' })
    expect(publicBaseTagFor('why2026', withBase)).to.equal('')
    const withBaseUpper = record({ html_page: '<head><BASE HREF="/x/"></head>' })
    expect(publicBaseTagFor('why2026', withBaseUpper)).to.equal('')
  })

  it('does not mistake <basefont> or text for a base tag', function () {
    const r = record({ html_page: '<basefont size="2"> the base of the deck' })
    expect(publicBaseTagFor('why2026', r)).to.equal(`<base href="${FOLDER}">`)
  })

  it('percent-encodes a folder containing spaces so the attribute and URL stay valid', function () {
    const r = record({ original_record_id: 'projects/my deck/public/index.html' })
    expect(publicBaseTagFor('why2026', r)).to.equal(`<base href="/@${OWNER}/${TABLE}/projects/my%20deck/public/">`)
  })

  it('strips the legacy unified-DB prefix from original_record_id', function () {
    const r = record({ original_record_id: `${OWNER}__com_salmanff_orbit_files__${FILE}` })
    expect(publicBaseTagFor('why2026', r)).to.equal(`<base href="${FOLDER}">`)
  })

  it('only applies to .files records (ordinary data records have no folder)', function () {
    const r = record({ original_app_table: 'com.salmanff.orbit.posts', original_record_id: 'abc123' })
    expect(publicBaseTagFor('my-post', r)).to.equal('')
  })

  it('returns an empty string on missing input rather than throwing', function () {
    expect(publicBaseTagFor('why2026', null)).to.equal('')
    expect(publicBaseTagFor('', record())).to.equal('')
    expect(publicBaseTagFor('why2026', record({ original_record_id: null }))).to.equal('')
    expect(publicBaseTagFor('why2026', record({ data_owner: undefined }))).to.equal('')
  })
})
