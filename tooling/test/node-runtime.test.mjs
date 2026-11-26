import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { assertNodeVersion, isMain, packageNodeRange, runNodeRuntimeCheck } from '../lib/node-runtime.mjs';

const range = '^24.22.3 || ^26.13.1';
const library = resolve(import.meta.dirname, '../lib/node-runtime.mjs');

test('accepts only supported majors at or above their patch floor', () => {
  for (const version of ['24.22.3', '24.23.0', '26.13.1', '26.14.0', 'v24.22.3']) assert.doesNotThrow(() => assertNodeVersion(version, range));
  for (const version of ['22.23.5', '24.22.0', '24.22.2', '25.0.0', '26.13.0', '27.0.0', '24.22.3-rc.1', '24.022.3']) {
    assert.throws(() => assertNodeVersion(version, range), /Node.js/);
  }
  assert.throws(() => assertNodeVersion('24.22.3', '^24.22.4'), /required/);
  for (const invalid of ['>=22', '*', '^24.22.3; id', '', '^0.1.0', undefined]) assert.throws(() => assertNodeVersion('24.22.3', invalid));
});

test('reads a bounded engines range from the named package.json', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-devtools-engines-'));
  try {
    const file = join(directory, 'package.json');
    writeFileSync(file, JSON.stringify({ engines: { node: range } }));
    assert.equal(packageNodeRange(file), range);
    assert.equal(runNodeRuntimeCheck(['--print-range', '--package', file]), range);
    assert.doesNotThrow(() => runNodeRuntimeCheck(['--package', file], '26.13.1'));
    assert.throws(() => runNodeRuntimeCheck(['--package', file], '26.13.0'), /required/);
    assert.doesNotThrow(() => runNodeRuntimeCheck(['--engines', '^24.0.0'], '24.1.0'));
    for (const bad of ['>=24', '^24.22.3 ; touch x', ' ^24.22.3']) {
      writeFileSync(file, JSON.stringify({ engines: { node: bad } }));
      assert.throws(() => packageNodeRange(file), /bounded/);
    }
    assert.throws(() => runNodeRuntimeCheck(['--print-range', '--engines', range]), /combined/);
    assert.throws(() => runNodeRuntimeCheck(['--bogus']), /Use --print-range/);
    assert.throws(() => runNodeRuntimeCheck(['--engines']), /Use --print-range/);
    // The default is the package.json in the current directory.
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../bin/check-node-runtime.mjs'), '--print-range'],
      { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
    assert.equal(result.stdout.trim(), JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')).engines.node);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the library streamed on stdin fails closed before a following deployment step', () => {
  const helper = readFileSync(library, 'utf8');
  for (const [version, accepted] of [['24.22.2', false], ['26.13.0', false], ['22.23.5', false], ['24.22.3', true], ['26.13.1', true]]) {
    // The hashbang line stays: a streamed module accepts it. The version is faked before the helper body runs.
    const source = helper.replace(/^#!.*\n/, `#!/usr/bin/env node\nObject.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });\n`);
    const child = spawnSync('bash', ['-e', '-c', 'node --input-type=module - --engines "$PREFLIGHT_ENGINES"; printf DEPLOYMENT_ALLOWED'], {
      input: source, encoding: 'utf8',
      env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, PREFLIGHT_ENGINES: range },
    });
    assert.equal(child.status, accepted ? 0 : 1, child.stderr);
    assert.equal(child.stdout, accepted ? 'DEPLOYMENT_ALLOWED' : '');
  }
});

test('main-module detection follows npm bin symlinks and ignores imports', () => {
  assert.equal(isMain('file:///nowhere.mjs', '-'), true);
  assert.equal(isMain('file:///nowhere.mjs', undefined), false);
  assert.equal(isMain('file:///nowhere.mjs', '/missing/file'), false);
});
