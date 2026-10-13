// Unit tests for freezrsystmapps/info.freezr.creator/modules/changeReview.js — the "Explain changes"
// prompt builder, diff helpers, markdown renderer and the run wrapper (with the LLM call injected).
// The module has no top-level browser dependencies, so it imports straight into node.
import { expect } from 'chai'
import {
  lineDiff, unifiedDiff, buildChangeReviewPrompt, renderMarkdownLite, runChangeReview, FULL_FILE_LIMIT
} from '../../../freezrsystmapps/info.freezr.creator/modules/changeReview.js'

const compareFixture = () => ({
  a: { id: 'snapA', label: 'Before upload', timestamp: '2026-10-01T10:00:00.000Z' },
  b: { id: 'snapB', label: 'Uploaded orbit.zip', timestamp: '2026-10-02T10:00:00.000Z' },
  counts: { modified: 2, added: 1, deleted: 1, unchanged: 3 },
  files: [
    { path: 'manifest.json', status: 'modified', binary: false, a: JSON.stringify({ identifier: 'x', version: '0.1', permissions: [{ name: 'p1', type: 'read_all', table_id: 'x.t' }] }), b: JSON.stringify({ identifier: 'x', version: '0.2', permissions: [{ name: 'p1', type: 'read_all', table_id: 'x.t' }, { name: 'p2', type: 'write_all', table_id: 'other.t' }] }) },
    { path: 'app.js', status: 'modified', binary: false, a: 'const a = 1\nfetch("/ok")\n', b: 'const a = 1\nfetch("https://evil.example/x")\n' },
    { path: 'new.css', status: 'added', binary: false, a: null, b: 'body{}' },
    { path: 'old.html', status: 'deleted', binary: false, a: '<p>bye</p>', b: null },
    { path: 'img/logo.png', status: 'modified', binary: true, aSize: 10, bSize: 20 },
    { path: 'same.js', status: 'unchanged', binary: false }
  ]
})

describe('changeReview', () => {
  describe('unifiedDiff', () => {
    it('shows only changed lines with context and hunk markers', () => {
      const old = Array.from({ length: 30 }, (_, i) => 'line ' + i).join('\n')
      const neu = old.replace('line 10', 'line TEN').replace('line 25\n', 'line 25\ninserted\n')
      const d = unifiedDiff(old, neu)
      expect(d).to.include('-line 10')
      expect(d).to.include('+line TEN')
      expect(d).to.include('+inserted')
      expect(d).to.include(' line 9') // context
      expect(d).to.not.include(' line 0') // far from any change
      expect((d.match(/^@@/gm) || []).length).to.equal(2)
    })
    it('lineDiff classifies same/add/remove', () => {
      const d = lineDiff('a\nb\nc', 'a\nc\nd')
      expect(d.map((l) => l.type)).to.deep.equal(['same', 'remove', 'same', 'add'])
    })
  })

  describe('buildChangeReviewPrompt', () => {
    it('includes labels, counts, the B manifest, permission diff, both sides of small files, and the instructions', () => {
      const p = buildChangeReviewPrompt({ appName: 'com.x.orbit', compare: compareFixture(), note: 'bumped version and added a table' })
      expect(p).to.include('App: com.x.orbit')
      expect(p).to.include('Version A (before): Before upload')
      expect(p).to.include('Version B (after): Uploaded orbit.zip')
      expect(p).to.include('2 modified, 1 added, 1 deleted')
      expect(p).to.include('## Note from the person asking\nbumped version and added a table')
      expect(p).to.include('manifest.json of version B')
      expect(p).to.include('p2: write_all on other.t')
      expect(p).to.include('Permissions in A (for comparison)')
      expect(p).to.include('### app.js — MODIFIED')
      expect(p).to.include('BEFORE:')
      expect(p).to.include('https://evil.example/x')
      expect(p).to.include('### new.css — ADDED')
      expect(p).to.include('### old.html — DELETED')
      expect(p).to.include('### img/logo.png — MODIFIED (binary, 10 → 20 bytes; contents not shown)')
      expect(p).to.not.include('same.js')
      expect(p).to.include('**Security review**')
      expect(p).to.include('eval, new Function')
    })

    it('switches a large file to a unified diff and drops files past the budget with a note', () => {
      const big = Array.from({ length: 2000 }, (_, i) => 'row ' + i).join('\n')
      const compare = {
        a: { id: 'a' }, b: { id: 'b' }, counts: { modified: 2 },
        files: [
          { path: 'big.js', status: 'modified', binary: false, a: big, b: big.replace('row 500', 'row FIVE') },
          { path: 'late.js', status: 'modified', binary: false, a: 'x'.repeat(3000), b: 'y'.repeat(3000) }
        ]
      }
      expect(big.length * 2).to.be.greaterThan(FULL_FILE_LIMIT)
      const p = buildChangeReviewPrompt({ appName: 'a', compare, budget: 2500 })
      expect(p).to.include('Unified diff (file too large to send whole)')
      expect(p).to.include('-row 500')
      expect(p).to.include('+row FIVE')
      expect(p).to.include('Not included (prompt size limit): late.js (modified)')
      expect(p).to.not.include('yyyyyyyy')
    })
  })

  describe('renderMarkdownLite', () => {
    it('renders headings, lists, bold, inline and fenced code, and escapes HTML', () => {
      const html = renderMarkdownLite('## Summary\nSome **bold** and `code` <script>x</script>\n\n- item one\n- item two\n\n```js\nconst a = 1 < 2\n```')
      expect(html).to.include('<h4>Summary</h4>')
      expect(html).to.include('<strong>bold</strong>')
      expect(html).to.include('<code class="chat-inline-code">code</code>')
      expect(html).to.include('&lt;script&gt;')
      expect(html).to.not.include('<script>')
      expect(html).to.include('<ul>\n<li>item one</li>\n<li>item two</li>\n</ul>')
      expect(html).to.include('<pre class="chat-code"><code>const a = 1 &lt; 2\n</code></pre>')
    })
  })

  describe('runChangeReview', () => {
    it('asks with the built prompt, saves a change_review history entry carrying cost and the compared pair', async () => {
      let askedMessages = null
      let askedOptions = null
      let savedEntry = null
      const result = await runChangeReview({
        appName: 'com.x.orbit',
        compare: compareFixture(),
        note: 'hello',
        askOptions: { model: 'm1', provider: 'Claude' },
        ask: async (messages, options) => {
          askedMessages = messages
          askedOptions = options
          return { success: true, content: '## Summary\nFine.', meta: { provider: 'Claude', model: 'm1', cost: { totalCost: 0.02, totalTokens: 1000 }, tokensUsed: { input: { qtty: 900, cost: 0.01 } } } }
        },
        saveEntry: async (entry) => { savedEntry = entry; return { _id: 'rev1' } },
        recordMeta: () => ({ uid: 'u-rev', author: { user: 'me', server: 'https://here' } })
      })
      expect(askedOptions).to.deep.equal({ model: 'm1', provider: 'Claude' })
      expect(askedMessages).to.have.length(3)
      expect(askedMessages[2].content).to.include('## Note from the person asking\nhello')
      expect(result.text).to.equal('## Summary\nFine.')
      expect(result.entry._id).to.equal('rev1')
      expect(savedEntry.action).to.equal('change_review')
      expect(savedEntry.uid).to.equal('u-rev')
      expect(savedEntry.author.user).to.equal('me')
      expect(savedEntry.appName).to.equal('com.x.orbit')
      expect(savedEntry.review).to.equal('## Summary\nFine.')
      expect(savedEntry.compared).to.deep.equal({
        a: { id: 'snapA', label: 'Before upload', timestamp: '2026-10-01T10:00:00.000Z' },
        b: { id: 'snapB', label: 'Uploaded orbit.zip', timestamp: '2026-10-02T10:00:00.000Z' }
      })
      expect(savedEntry.filesChanged).to.deep.equal(['manifest.json', 'app.js', 'new.css', 'old.html', 'img/logo.png'])
      expect(savedEntry.cost.totalCost).to.equal(0.02)
      expect(savedEntry.llmModel).to.equal('m1')
      expect(savedEntry.note).to.equal('hello')
      expect(savedEntry.promptChars).to.be.greaterThan(500)
    })

    it('throws on an LLM error and does not save', async () => {
      let saved = false
      try {
        await runChangeReview({ appName: 'a', compare: compareFixture(), ask: async () => ({ error: 'no key' }), saveEntry: async () => { saved = true } })
        expect.fail('should throw')
      } catch (e) {
        expect(e.message).to.equal('no key')
      }
      expect(saved).to.equal(false)
    })
  })
})
