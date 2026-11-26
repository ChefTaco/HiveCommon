import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPublishEnvironment, checkPublishEnvironment, publishedVersionExists, publishPackage, readReleasePackage,
} from '../lib/publish.mjs';

const protectedEnvironment = { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 123 } }] }] };

test('publication requires an actual required reviewer rather than an environment name', () => {
  for (const value of [null, {}, { protection_rules: [] }, { protection_rules: [{ type: 'wait_timer' }] },
    { protection_rules: [{ type: 'required_reviewers', reviewers: [] }] },
    { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'Bot', reviewer: { id: 1 } }] }] }]) {
    assert.throws(() => assertPublishEnvironment(value), /required reviewer/);
  }
  assert.doesNotThrow(() => assertPublishEnvironment(protectedEnvironment));
});

test('GitHub environment checks fail closed and send the credential only to the API', async () => {
  const env = { GITHUB_REPOSITORY: 'example/package', GH_TOKEN: 'fixture-github-token' };
  await checkPublishEnvironment(env, async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/example/package/environments/npm-publish');
    assert.equal(options.headers.Authorization, 'Bearer fixture-github-token');
    assert.equal(options.redirect, 'error');
    return Response.json(protectedEnvironment);
  });
  await checkPublishEnvironment(env, async url => {
    assert.equal(url, 'https://api.github.com/repos/example/package/environments/release');
    return Response.json(protectedEnvironment);
  }, { environment: 'release' });
  await assert.rejects(checkPublishEnvironment(env, async () => new Response('', { status: 403 })), /HTTP 403/);
  await assert.rejects(checkPublishEnvironment(env, async () => Response.json({ protection_rules: [] })), /required reviewer/);
  await assert.rejects(checkPublishEnvironment({}), /required/);
  await assert.rejects(checkPublishEnvironment({ ...env, GITHUB_REPOSITORY: 'example/../x' }), /required/);
  await assert.rejects(checkPublishEnvironment(env, fetch, { environment: 'a/b' }), /Invalid environment/);
});

function packageRoot(manifest) {
  const root = mkdtempSync(join(tmpdir(), 'hive-devtools-publish-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  return root;
}

test('publication checks the package, the tag and the registry before npm publish', async () => {
  const manifest = { name: '@example/tool', version: '1.2.3', publishConfig: { access: 'public' } };
  const root = packageRoot(manifest);
  try {
    assert.equal(readReleasePackage(root, { name: '@example/tool' }).version, '1.2.3');
    assert.throws(() => readReleasePackage(root, { name: '@example/other' }), /public @example\/other/);
    const calls = [];
    const run = (command, args) => calls.push([command, ...args].join(' '));
    const missing = async () => new Response('', { status: 404 });
    await publishPackage({ root, dryRun: true, run, fetcher: () => assert.fail('a dry run reads no registry') });
    assert.match(calls.pop(), /^npm publish --dry-run --ignore-scripts/);
    await assert.rejects(publishPackage({ root, dryRun: false, ref: 'refs/tags/v1.2.3', tagPrefix: 'tool-v', run, fetcher: missing }), /matching release tag/);
    await publishPackage({ root, dryRun: false, ref: 'refs/tags/tool-v1.2.3', tagPrefix: 'tool-v', name: '@example/tool', run, fetcher: missing });
    assert.match(calls.pop(), /^npm publish --provenance --ignore-scripts --access public/);
    await publishPackage({ root, dryRun: false, ref: 'refs/tags/v1.2.3', run,
      fetcher: async () => Response.json({ name: '@example/tool', version: '1.2.3' }) });
    assert.equal(calls.length, 0, 'an already published version is skipped');
    await assert.rejects(publishPackage({ root, dryRun: false, ref: 'refs/tags/v1.2.3', run,
      fetcher: async () => new Response('', { status: 503 }) }), /HTTP 503/);
    await assert.rejects(publishPackage({ root, dryRun: 'false', run }), /boolean dryRun/);
    await assert.rejects(publishPackage({ root, dryRun: true, tagPrefix: 'a b', run }), /tag prefix/);
    assert.equal(calls.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
  for (const bad of [{ ...manifest, private: true }, { ...manifest, version: 'latest' }, { ...manifest, publishConfig: {} }, { ...manifest, name: 'Bad Name' }]) {
    const other = packageRoot(bad);
    try { assert.throws(() => readReleasePackage(other), /public/); } finally { rmSync(other, { recursive: true, force: true }); }
  }
});

test('registry metadata must name the requested version', async () => {
  await assert.rejects(publishedVersionExists('@example/tool', '1.0.0', async () => Response.json({ name: 'x', version: '1.0.0' })), /Unexpected npm metadata/);
  assert.equal(await publishedVersionExists('@example/tool', '1.0.0', async url => {
    assert.equal(url, 'https://registry.npmjs.org/%40example%2Ftool/1.0.0');
    return new Response('', { status: 404 });
  }), false);
});
