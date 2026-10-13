// Unit tests for resolveEditFiles in the creator's chatService.js — the step that turns the model's
// file sections into writes. chatService.js is a browser module with a deep import graph (editor
// vendor bundle, freezr global), so the pure helpers are sliced out of the source and evaluated in a
// vm context, the same approach freezrProbePage.test.mjs takes.
//
// Regression: two sections for the same path (e.g. one edit block changing the description, another
// bumping the version) used to each apply to the ORIGINAL file, so the last write silently dropped
// the earlier change. Sections must chain on a running copy and collapse to one write per path.
import { expect } from 'chai'
import fs from 'fs'
import path from 'path'
import vm from 'vm'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = fs.readFileSync(path.join(__dirname, '../../../freezrsystmapps/info.freezr.creator/modules/chatService.js'), 'utf8')

const sliceBetween = (src, startMarker, endMarker) => {
  const start = src.indexOf(startMarker)
  const end = src.indexOf(endMarker, start)
  if (start < 0 || end < 0) throw new Error('could not find ' + startMarker + ' … ' + endMarker)
  return src.slice(start, end)
}

// parseEditBlocks … resolveEditFiles (inclusive) end right before the prompt-builder section.
const helpers = sliceBetween(SOURCE, 'const parseEditBlocks = ', '// --- Prompt builder ---').replace(/^export /gm, '')
const ctx = {}
vm.createContext(ctx)
vm.runInContext(helpers + '\nthis.resolveEditFiles = resolveEditFiles; this.applyEdits = applyEdits', ctx)
const { resolveEditFiles } = ctx

const edit = (search, replace) => '<<<SEARCH>>>\n' + search + '\n<<<REPLACE>>>\n' + replace + '\n<<<END_REPLACE>>>'
const manifest = JSON.stringify({ identifier: 'com.x.orbit', version: '0.1.0', description: 'old words' }, null, 2)
const allFiles = [{ path: 'manifest.json', content: manifest }, { path: 'app.js', content: 'const a = 1\nconst b = 2\n' }]

describe('resolveEditFiles', () => {
  it('chains two edit sections for the same file so both changes land in one write', () => {
    const parsed = [
      { path: 'manifest.json', action: 'edit', content: edit('"version": "0.1.0"', '"version": "0.2.0"') },
      { path: 'manifest.json', action: 'edit', content: edit('"description": "old words"', '"description": "new words"') }
    ]
    const { resolved, warnings } = resolveEditFiles(parsed, allFiles)
    expect(warnings).to.deep.equal([])
    expect(resolved).to.have.length(1)
    const m = JSON.parse(resolved[0].content)
    expect(m.version).to.equal('0.2.0')
    expect(m.description).to.equal('new words')
    expect(resolved[0].action).to.equal('upsert')
  })

  it('applies an edit on top of an earlier upsert for the same path, and lets a later upsert replace an edit', () => {
    const onTop = resolveEditFiles([
      { path: 'app.js', action: 'upsert', content: 'const z = 9\n' },
      { path: 'app.js', action: 'edit', content: edit('const z = 9', 'const z = 10') }
    ], allFiles)
    expect(onTop.warnings).to.deep.equal([])
    expect(onTop.resolved).to.deep.include({ path: 'app.js', action: 'upsert', content: 'const z = 10\n', description: '' })

    const replaced = resolveEditFiles([
      { path: 'app.js', action: 'edit', content: edit('const a = 1', 'const a = 100') },
      { path: 'app.js', action: 'upsert', content: 'fresh\n' }
    ], allFiles)
    expect(replaced.resolved).to.have.length(1)
    expect(replaced.resolved[0].content).to.equal('fresh\n')
  })

  it('keeps one write per path and preserves first-seen order across files', () => {
    const { resolved } = resolveEditFiles([
      { path: 'app.js', action: 'edit', content: edit('const a = 1', 'const a = 2') },
      { path: 'manifest.json', action: 'edit', content: edit('"version": "0.1.0"', '"version": "0.3.0"') },
      { path: 'app.js', action: 'edit', content: edit('const b = 2', 'const b = 3') }
    ], allFiles)
    expect(resolved.map((f) => f.path)).to.deep.equal(['app.js', 'manifest.json'])
    expect(resolved[0].content).to.equal('const a = 2\nconst b = 3\n')
  })

  it('blames a failed second section on its own index, leaving the first section applied', () => {
    const parsed = [
      { path: 'manifest.json', action: 'edit', content: edit('"version": "0.1.0"', '"version": "0.2.0"') },
      { path: 'manifest.json', action: 'edit', content: edit('"nothing like this"', '"x"') }
    ]
    const { resolved, warnings } = resolveEditFiles(parsed, allFiles)
    expect(resolved).to.have.length(1)
    expect(JSON.parse(resolved[0].content).version).to.equal('0.2.0')
    expect(warnings).to.have.length(1)
    expect(warnings[0].index).to.equal(1)
    expect(warnings[0].path).to.equal('manifest.json')
    expect(warnings[0].error).to.match(/Search block not found/)
  })

  it('still reports a missing file, empty blocks and a delete-then-edit', () => {
    const r1 = resolveEditFiles([{ path: 'nope.js', action: 'edit', content: edit('a', 'b') }], allFiles)
    expect(r1.warnings[0].error).to.equal('File not found for editing')
    const r2 = resolveEditFiles([{ path: 'app.js', action: 'edit', content: 'no blocks here' }], allFiles)
    expect(r2.warnings[0].error).to.equal('No valid search/replace blocks found')
    const r3 = resolveEditFiles([
      { path: 'app.js', action: 'delete', content: '' },
      { path: 'app.js', action: 'edit', content: edit('const a = 1', 'x') }
    ], allFiles)
    expect(r3.resolved).to.deep.equal([{ path: 'app.js', action: 'delete', content: '' }])
    expect(r3.warnings[0].error).to.equal('File not found for editing')
  })
})
