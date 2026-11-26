// npm release helpers for packages that publish from a tag through npm trusted publishing (OIDC).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENVIRONMENT = /^[A-Za-z0-9_.-]{1,255}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG_PREFIX = /^[A-Za-z0-9._/-]{0,64}$/;

/** Throws unless a GitHub environment has at least one required reviewer (a user or team). */
export function assertPublishEnvironment(value, environment = 'npm-publish') {
  const rules = value?.protection_rules;
  if (!Array.isArray(rules) || !rules.some(rule => rule.type === 'required_reviewers'
    && Array.isArray(rule.reviewers) && rule.reviewers.some(reviewer =>
      ['User', 'Team'].includes(reviewer.type) && Number.isSafeInteger(reviewer.reviewer?.id) && reviewer.reviewer.id > 0))) {
    throw new Error(`${environment} must have at least one required reviewer configured in GitHub Settings > Environments before publishing`);
  }
}

/**
 * Reads the environment from the GitHub API (GITHUB_REPOSITORY and GH_TOKEN from `env`) and
 * fails closed on any error. The token is sent only to api.github.com, with redirects refused.
 */
export async function checkPublishEnvironment(env = process.env, fetcher = fetch, { environment = 'npm-publish' } = {}) {
  if (!ENVIRONMENT.test(environment)) throw new Error('Invalid environment name');
  if (!REPOSITORY.test(env.GITHUB_REPOSITORY ?? '') || !env.GH_TOKEN) {
    throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required to verify publication protection');
  }
  const response = await fetcher(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/environments/${encodeURIComponent(environment)}`, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Could not verify ${environment} environment protection (HTTP ${response.status})`);
  assertPublishEnvironment(await response.json(), environment);
}

/** Reads package.json and checks that it is a public, versioned package (with the expected name, if given). */
export function readReleasePackage(root, { name } = {}) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (typeof pkg.name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.name)
    || (name !== undefined && pkg.name !== name)
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? '') || pkg.private || pkg.publishConfig?.access !== 'public') {
    throw new Error(`package.json must be the public ${name ?? 'npm'} package with a valid version and publishConfig.access "public"`);
  }
  return pkg;
}

/** True when name@version is on the registry; any registry failure stops publication. */
export async function publishedVersionExists(name, version, fetcher = fetch) {
  const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Could not check ${name}@${version} on npm (HTTP ${response.status}); publication stopped`);
  const metadata = await response.json();
  if (metadata.name !== name || metadata.version !== version) throw new Error(`Unexpected npm metadata for ${name}@${version}; publication stopped`);
  return true;
}

/**
 * Publishes the package at `root` with provenance unless its version is already on npm.
 * A dry run packs and validates without registry access. A real publication must run from
 * the tag `refs/tags/<tagPrefix><version>`.
 */
export async function publishPackage({ root, dryRun, ref, name, tagPrefix = 'v', fetcher = fetch, run = execFileSync }) {
  if (typeof dryRun !== 'boolean') throw new Error('An explicit boolean dryRun is required');
  if (!TAG_PREFIX.test(tagPrefix)) throw new Error('Invalid tag prefix');
  const pkg = readReleasePackage(root, name === undefined ? {} : { name });
  if (!dryRun && ref !== `refs/tags/${tagPrefix}${pkg.version}`) throw new Error('Real publication must run from the matching release tag');
  // A registry or authentication failure must not be mistaken for an unpublished version.
  if (!dryRun && await publishedVersionExists(pkg.name, pkg.version, fetcher)) {
    console.log(`${pkg.name}@${pkg.version} is already on npm; skipping`);
    return;
  }
  // The payload was built, tested and inspected by the gates; never run lifecycle scripts here.
  run('npm', ['publish', dryRun ? '--dry-run' : '--provenance', '--ignore-scripts', '--access', 'public',
    '--registry', 'https://registry.npmjs.org/'], { cwd: root, stdio: 'inherit' });
}
