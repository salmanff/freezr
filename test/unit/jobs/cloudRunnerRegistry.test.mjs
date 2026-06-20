// Unit tests for the provider → cloud-runner registry (multi-provider seam).
import { expect } from 'chai'
import { makeCloudRunnerForProvider, supportedComputeProviders } from '../../../adapters/jobs/cloudRunnerRegistry.mjs'

describe('cloudRunnerRegistry', function () {
  it('builds an AWS runner satisfying the JobRunner contract', function () {
    const r = makeCloudRunnerForProvider('aws', { credentials: { accessKeyId: 'A', secretAccessKey: 'B', region: 'eu-central-1' } })
    for (const m of ['exists', 'deploy', 'remove', 'invoke']) expect(r[m], m).to.be.a('function')
  })

  it('throws a clear error for an unimplemented provider', function () {
    expect(() => makeCloudRunnerForProvider('gcp', {})).to.throw(/no cloud job runner for provider "gcp"/)
  })

  it('reports the supported providers (aws today)', function () {
    expect(supportedComputeProviders()).to.include('aws')
  })
})
