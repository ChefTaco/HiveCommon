#!/usr/bin/env node
// hive-check-publish-environment [--environment NAME]
// Fails unless the GitHub environment (default npm-publish) of GITHUB_REPOSITORY has a required
// reviewer. Needs GH_TOKEN with actions:read; the token is sent only to the GitHub API.
import { checkPublishEnvironment } from '../lib/publish.mjs';

try {
  const args = process.argv.slice(2);
  let environment = 'npm-publish';
  if (args.length === 2 && args[0] === '--environment') environment = args[1];
  else if (args.length) throw new Error('Usage: hive-check-publish-environment [--environment NAME]');
  await checkPublishEnvironment(process.env, fetch, { environment });
  console.log(`npm publication environment ${environment} requires review.`);
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
