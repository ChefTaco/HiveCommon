import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { actionPinFindings, checkActionPins } from '../lib/action-pins.mjs';

const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);

test('accepts commit SHAs, image digests and local references', () => {
  const workflow = [
    'jobs:',
    '  build:',
    '    steps:',
    `      - uses: actions/checkout@${sha} # v7.0.1`,
    `      - uses: "actions/setup-node@${sha}" # v7.1.0`,
    `      - uses: 'github/codeql-action/init@${sha}' # v4`,
    `      - uses: docker://alpine@sha256:${digest}`,
    '      - uses: ./.github/actions/local',
    `      - { uses: owner/action@${sha} } # v1`,
    '  call:',
    `    uses: ChefTaco/HiveCommon/.github/workflows/reusable-gitleaks.yml@${sha} # main`,
    '  local:',
    '    uses: ./.github/workflows/reusable.yml',
    '      run: echo "the word uses: in a script is not a step"',
  ].join('\n');
  assert.deepEqual(actionPinFindings(workflow), []);
});

test('rejects tags, branches, short SHAs, unpinned images and unparsable uses lines', () => {
  const workflow = [
    '      - uses: actions/checkout@v4',
    '      - uses: actions/checkout@main',
    `      - uses: actions/checkout@${sha.slice(0, 12)}`,
    '      - uses: actions/checkout',
    `      - uses: actions/checkout@${'A'.repeat(40)}`,
    '      - uses: docker://alpine:3.20',
    '      - uses: actions/checkout@v4 extra words',
    '    uses: ChefTaco/HiveCommon/.github/workflows/x.yml@main',
  ].join('\n');
  const findings = actionPinFindings(workflow);
  assert.deepEqual(findings.map(finding => finding.line), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.match(findings[5].rule, /digest/);
  assert.match(findings[6].rule, /unrecognised/);
});

test('a version comment can be required next to each SHA', () => {
  assert.equal(actionPinFindings(`- uses: a/b@${sha} # v1.2.3`, { requireVersionComment: true }).length, 0);
  assert.equal(actionPinFindings(`- uses: a/b@${sha}`, { requireVersionComment: true })[0].rule, 'pinned SHA has no version comment');
  assert.equal(actionPinFindings(`- uses: a/b@${sha} # hive-devtools-v0.1.0`, { requireVersionComment: true }).length, 0);
  assert.equal(actionPinFindings(`- uses: a/b@${sha} # latest`, { requireVersionComment: true }).length, 1);
  assert.equal(actionPinFindings(`- uses: a/b@${sha} # main`, { requireVersionComment: true }).length, 1);
});

test('scans workflows, composite actions and a root action, and the CLI reports file:line', () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-devtools-pins-'));
  try {
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    mkdirSync(join(root, '.github/actions/setup'), { recursive: true });
    writeFileSync(join(root, '.github/workflows/ci.yml'), `steps:\n  - uses: actions/checkout@${sha} # v7\n`);
    writeFileSync(join(root, '.github/actions/setup/action.yaml'), 'runs:\n  steps:\n    - uses: actions/cache@v4\n');
    writeFileSync(join(root, 'action.yml'), `runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@${sha}\n`);
    writeFileSync(join(root, '.github/workflows/notes.txt'), 'uses: ignored@v1\n');
    const result = checkActionPins(root);
    assert.equal(result.files, 3);
    assert.deepEqual(result.findings.map(f => `${f.file}:${f.line}`), ['.github/actions/setup/action.yaml:3']);
    const cli = (...args) => spawnSync(process.execPath, [resolve(import.meta.dirname, '../bin/check-action-pins.mjs'), ...args], { cwd: root, encoding: 'utf8' });
    const failed = cli();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /\.github\/actions\/setup\/action\.yaml:3: not pinned to a full commit SHA: actions\/cache@v4/);
    assert.equal(cli('--path', '.github/workflows').status, 0);
    const strict = cli('--root', root, '--path', 'action.yml', '--require-version-comment');
    assert.equal(strict.status, 1);
    assert.equal(cli('--bogus').status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('this repository pins every action it uses', () => {
  const { findings } = checkActionPins(resolve(import.meta.dirname, '../..'), { requireVersionComment: true });
  assert.deepEqual(findings, []);
});
