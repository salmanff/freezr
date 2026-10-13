/**
 * Unit tests for the creator app-file validator (freezr_creator_selfcheck_plan_v1.md B1).
 * Pure functions — no server needed. Run with: npx mocha test/unit/appValidationService.test.mjs
 *
 * The most important property under test is that validation NEVER EXECUTES the code it checks.
 */

import { expect } from 'chai'
import { validateAppFiles, checkJsSyntax } from '../../features/creator/services/appValidationService.mjs'
import { BOOT_JS } from '../../features/creator/askAppTemplate.mjs'

describe('appValidationService', function () {
  describe('checkJsSyntax', function () {
    it('accepts valid ES module code', function () {
      expect(checkJsSyntax('a.js', "import { x } from './b.js'\nexport const y = x + 1")).to.equal(null)
    })

    it('accepts valid plain script code', function () {
      expect(checkJsSyntax('a.js', 'var a = 1; function f () { return a }')).to.equal(null)
    })

    it('accepts top-level await (used by generated pages)', function () {
      expect(checkJsSyntax('a.js', "const r = await fetch('/x')")).to.equal(null)
    })

    it('reports a syntax error with a line number', function () {
      const err = checkJsSyntax('bad.js', 'export const go = () => {\n  let a = ;\n}')
      expect(err).to.not.equal(null)
      expect(err.path).to.equal('bad.js')
      expect(err.line).to.equal(2)
      expect(err.message).to.be.a('string').and.not.match(/\(\d+:\d+\)$/)
    })

    it('ignores non-JS files', function () {
      expect(checkJsSyntax('style.css', 'this is not js {{{')).to.equal(null)
    })

    it('does NOT execute the code it checks', function () {
      // If the validator ran this, the global would be set (and in a real app it could do anything).
      globalThis.__validatorSideEffect = false
      const res = checkJsSyntax('evil.js', 'globalThis.__validatorSideEffect = true')
      expect(res).to.equal(null) // syntactically valid
      expect(globalThis.__validatorSideEffect).to.equal(false) // but never ran
      delete globalThis.__validatorSideEffect
    })

    it('does not execute code that would throw at runtime', function () {
      expect(checkJsSyntax('t.js', 'throw new Error("boom")')).to.equal(null)
    })
  })

  describe('validateAppFiles', function () {
    it('passes a clean app', function () {
      const { errors } = validateAppFiles([
        { path: 'index.js', content: "import { go } from './helper.js'\ngo()" },
        { path: 'helper.js', content: 'export const go = () => 1' },
        { path: 'manifest.json', content: '{"identifier":"x"}' }
      ])
      expect(errors).to.deep.equal([])
    })

    it('flags an import that points at a file which was never written', function () {
      const { errors } = validateAppFiles([
        { path: 'index.js', content: "import { go } from './missing.js'" }
      ])
      expect(errors).to.have.lengthOf(1)
      expect(errors[0].type).to.equal('missing_import')
      expect(errors[0].line).to.equal(1)
      expect(errors[0].message).to.include('missing.js')
    })

    it('resolves extensionless and index imports', function () {
      const { errors } = validateAppFiles([
        { path: 'index.js', content: "import a from './lib/helper'\nimport b from './mod'" },
        { path: 'lib/helper.js', content: 'export default 1' },
        { path: 'mod/index.js', content: 'export default 2' }
      ])
      expect(errors).to.deep.equal([])
    })

    it('resolves parent-directory imports', function () {
      const { errors } = validateAppFiles([
        { path: 'sub/page.js', content: "import x from '../shared.js'" },
        { path: 'shared.js', content: 'export default 1' }
      ])
      expect(errors).to.deep.equal([])
    })

    it('flags unparseable JSON', function () {
      const { errors } = validateAppFiles([{ path: 'manifest.json', content: '{ "a": 1, }' }])
      expect(errors).to.have.lengthOf(1)
      expect(errors[0].type).to.equal('json_parse')
    })

    it('flags a missing script/link target in HTML', function () {
      const { errors } = validateAppFiles([
        { path: 'index.html', content: '<script type="module" src="./app.js"></script>' }
      ])
      expect(errors.some((e) => e.type === 'missing_import' && e.message.includes('app.js'))).to.equal(true)
    })

    it('ignores bare, absolute and URL specifiers', function () {
      const { errors } = validateAppFiles([
        { path: 'index.js', content: "import a from 'some-package'\nimport b from '/abs/x.js'" },
        { path: 'index.html', content: '<link href="https://cdn.example.com/x.css">' }
      ])
      expect(errors).to.deep.equal([])
    })

    it('skips imported/, vendor/ and REFERENCE/ files', function () {
      const { errors } = validateAppFiles([
        { path: 'imported/other.js', content: 'this is (((not js' },
        { path: 'vendor/bundle.js', content: 'also ))) broken' },
        { path: 'REFERENCE/doc.js', content: 'nope ;;; )))' }
      ])
      expect(errors).to.deep.equal([])
    })

    it('reports the parser it used', function () {
      expect(validateAppFiles([]).parser).to.be.a('string')
    })
  })

  // BOOT_JS is a template STRING that ships into every generated ask-app, and it is protected —
  // the model never rewrites it, so a typo here would break every app silently and nothing else
  // would catch it. Validating it with the validator is a neat closed loop: the tool that checks
  // generated code checks the one file we generate for every app.
  describe('BOOT_JS (the protected ask-app boot file)', function () {
    it('is syntactically valid JavaScript', function () {
      expect(checkJsSyntax('askapp-boot.js', BOOT_JS)).to.equal(null)
    })

    it('still captures the three runtime failure modes (B3)', function () {
      // A blank generated page is almost always one of these three, so losing any of them
      // silently removes the only signal the builder gets about a broken app.
      expect(BOOT_JS).to.match(/addEventListener\('error'/) // throws + failed subresources
      expect(BOOT_JS).to.match(/addEventListener\('unhandledrejection'/) // rejected promises
      expect(BOOT_JS).to.match(/import\('\.\/index\.js'\)\s*\.catch|import\('\.\/index\.js'\)\.catch/) // the app failing to load at all
    })

    it('records errors under the key the ask builder reads', function () {
      // The key is the contract between the page and ask.js (consumeRuntimeErrors) — if either
      // side is renamed without the other, errors are captured and then never surfaced.
      expect(BOOT_JS).to.include('freezr_ask_runtime_errors')
    })
  })
})
