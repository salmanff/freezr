// Local-CLI connectors are restricted to the CREATOR app by default.
//
// Two independent reasons, either sufficient on its own:
//   - TERMS: these connectors spend the owner's Claude/ChatGPT subscription. Anthropic allows a
//     subscription owner's own personal/dev use and prohibits serving third parties; an ordinary
//     app answering its users from the owner's subscription sits much closer to that line than a
//     developer building an app does.
//   - PROMPT INJECTION: CodexLocal runs an agent with no PROVEN text-only mode. The risk only
//     materialises when a prompt carries untrusted third-party text — which is what ordinary
//     apps feed an LLM, and what app-building does not.
//
// The escape hatch is an ENV VAR, not a preference: lifting it should require server access, so
// it is a deliberate act rather than a checkbox someone clicks past.
import { expect } from 'chai'
import {
  localAgentsAllowedForApp,
  localAgentsAllowedEverywhere,
  LOCAL_AGENT_ALLOWED_APPS
} from '../../../common/helpers/localAgentPolicy.mjs'

describe('local agent policy — which apps may spend the owner\'s subscription', function () {
  let saved

  beforeEach(function () { saved = process.env.SHOW_LOCAL_AGENT_IN_APPS })
  afterEach(function () {
    if (saved === undefined) delete process.env.SHOW_LOCAL_AGENT_IN_APPS
    else process.env.SHOW_LOCAL_AGENT_IN_APPS = saved
  })

  it('allows the creator app by default', function () {
    delete process.env.SHOW_LOCAL_AGENT_IN_APPS
    expect(localAgentsAllowedForApp('info.freezr.creator')).to.equal(true)
    expect(LOCAL_AGENT_ALLOWED_APPS).to.include('info.freezr.creator')
  })

  it('REFUSES ordinary apps by default — including ones that handle untrusted third-party text', function () {
    delete process.env.SHOW_LOCAL_AGENT_IN_APPS
    for (const app of ['com.salmanff.superlazy', 'info.freezr.account', 'info.freezr.mail', 'com.example.anything']) {
      expect(localAgentsAllowedForApp(app), app + ' must not reach a local agent').to.equal(false)
    }
  })

  it('lifts the restriction only for the exact string "true"', function () {
    process.env.SHOW_LOCAL_AGENT_IN_APPS = 'true'
    expect(localAgentsAllowedEverywhere()).to.equal(true)
    expect(localAgentsAllowedForApp('com.salmanff.superlazy')).to.equal(true)
  })

  it('does NOT lift it for near-miss values — a typo must fail CLOSED', function () {
    for (const value of ['1', 'yes', 'TRUE', 'True', 'on', '', 'false']) {
      process.env.SHOW_LOCAL_AGENT_IN_APPS = value
      expect(localAgentsAllowedEverywhere(), 'value ' + JSON.stringify(value)).to.equal(false)
      expect(localAgentsAllowedForApp('com.example.anything')).to.equal(false)
    }
  })

  it('handles a missing/odd app name without throwing (fails closed)', function () {
    delete process.env.SHOW_LOCAL_AGENT_IN_APPS
    expect(localAgentsAllowedForApp(undefined)).to.equal(false)
    expect(localAgentsAllowedForApp(null)).to.equal(false)
    expect(localAgentsAllowedForApp('')).to.equal(false)
  })
})
