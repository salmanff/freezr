// freezr.info — Cloud job-runner registry (provider → runner factory)
//
// Keeps the rest of the jobs subsystem provider-agnostic: jobInvoker reads whatever compute credential
// the user has and asks the registry for the matching runner. AWS is the only one implemented today;
// Google (Cloud Functions) and Azure (Functions) slot in here when built. Every factory must satisfy
// the JobRunner contract: exists / deploy / remove / invoke (see adapters/jobs/awsJobRunner.mjs).

import { createAwsJobRunner } from './awsJobRunner.mjs'

export const CLOUD_RUNNER_FACTORIES = {
  aws: createAwsJobRunner
  // google: createGoogleJobRunner,  // TODO when implemented
  // azure: createAzureJobRunner,    // TODO when implemented
}

export function supportedComputeProviders () {
  return Object.keys(CLOUD_RUNNER_FACTORIES)
}

/** Build the runner for a credential's provider. Throws a clear error for an unimplemented provider. */
export function makeCloudRunnerForProvider (provider, args = {}) {
  const factory = CLOUD_RUNNER_FACTORIES[provider]
  if (!factory) {
    throw new Error('no cloud job runner for provider "' + provider + '" (supported: ' + supportedComputeProviders().join(', ') + ')')
  }
  return factory(args)
}

export default { CLOUD_RUNNER_FACTORIES, supportedComputeProviders, makeCloudRunnerForProvider }
