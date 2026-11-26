import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_FORBIDDEN_DIRS, forbiddenPath, privateInfrastructureFindings, secretFindings,
} from '../lib/privacy-policy.mjs';

const bin = name => resolve(import.meta.dirname, '../bin', name);

/** A disposable repository that never inherits the caller's git environment (hooks set GIT_DIR). */
function repository(prefix) {
  const root = mkdtempSync(join(tmpdir(), `hive-devtools-${prefix}-`));
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
  git('init', '-q');
  return { root, env, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('blocks credential and local-state paths while allowing example configuration', () => {
  for (const path of ['.env.production', 'a/.npmrc', 'a/state/events.jsonl', 'artifacts/proof.json', 'a/private.key',
    'data.sqlite-wal', 'AGENTS.local.md', '.hive-dev/config.json', '.ssh/id_ed25519', '.vscode/mcp.json',
    '.cindertrace/x.json', '.ardent/run.json']) {
    assert.equal(forbiddenPath(path), true, path);
  }
  for (const path of ['a/.env.example', 'a/README.md', 'src/state.ts', 'output/report.txt']) assert.equal(forbiddenPath(path), false, path);
  assert.equal(forbiddenPath('output/report.txt', { dirs: ['output'] }), true);
  assert.equal(forbiddenPath('test/fixtures/state/a.json', { allow: ['^test/fixtures/'] }), false);
  assert.throws(() => forbiddenPath('a', { dirs: ['a|b'] }), /forbidden directory name/);
  assert.throws(() => forbiddenPath('a', { dirs: ['..'] }), /forbidden directory name/);
});

test('the shell scanner and the library forbid the same default directories', () => {
  const shell = readFileSync(bin('check-private-data.sh'), 'utf8');
  const list = /^FORBIDDEN_DIRS=\(([^)]*)\)$/m.exec(shell)?.[1]?.split(/\s+/);
  assert.deepEqual(list, [...DEFAULT_FORBIDDEN_DIRS]);
});

test('detects provider tokens even when unrelated text says example', () => {
  for (const token of ['npm_' + 'A'.repeat(36), 'ghp_' + 'B'.repeat(36), 'github_pat_' + 'C'.repeat(50),
    'sk-' + 'D'.repeat(30), 'AKIA' + 'E'.repeat(16), 'xoxb-' + '1234567890'.repeat(3)]) {
    const findings = secretFindings(`example: ${token}`);
    assert.ok(findings.length);
    assert.ok(!JSON.stringify(findings).includes(token));
  }
});

test('finds quoted credentials, only exempts the placeholder value, and takes extra variable names', () => {
  const value = 'unrelated-opaque-' + 'A'.repeat(20);
  assert.ok(secretFindings(`API_SECRET="${value}" # example`).length);
  assert.ok(secretFindings(`{"SESSION_SECRET": "${value}"}`).length);
  assert.equal(secretFindings('API_SECRET="replace-with-a-random-secret"').length, 0);
  assert.equal(secretFindings('API_SECRET: process.env.API_SECRET').length, 0);
  assert.ok(secretFindings(`API_SECRET=${'A'.repeat(32)}`).length);
  assert.ok(secretFindings(`DEPLOY_PASSWORD=${'p'.repeat(8)}`).length);
  assert.equal(secretFindings(`PRODUCT_TOKEN=${'A'.repeat(32)}`).length, 0);
  assert.ok(secretFindings(`PRODUCT_TOKEN=${'A'.repeat(32)}`, { secretNames: ['PRODUCT_TOKEN'] }).length);
  assert.ok(secretFindings(`ADMIN_PASSWORD=${'p'.repeat(8)}`, { secretNames: ['ADMIN_PASSWORD'] }).length);
  assert.throws(() => secretFindings('', { secretNames: ['A|B'] }), /secret variable name/);
});

test('detects private-key headers without including their values in findings', () => {
  assert.equal(secretFindings('-----BEGIN ' + 'OPENSSH PRIVATE KEY-----')[0].rule, 'private key');
});

test('blocks private infrastructure patterns without an operator denylist', () => {
  const domain = ['node', 'private', 'ts', 'net'].join('.');
  const personal = '/home/' + 'personal-account/project';
  assert.equal(privateInfrastructureFindings(`https://${domain}`).length, 1);
  assert.equal(privateInfrastructureFindings(personal).length, 1);
  assert.equal(privateInfrastructureFindings(personal, { homeUsers: ['personal-account'] }).length, 0);
  assert.equal(privateInfrastructureFindings('/home/operator/project https://node.example.com').length, 0);
});

test('the secret scanner checks staged blobs even when the working copy is sanitized', () => {
  const { root, env, git, cleanup } = repository('secrets');
  try {
    const token = 'npm_' + 'Z'.repeat(36);
    const file = join(root, 'space in name.txt');
    writeFileSync(file, `example ${token}`);
    git('add', '--', 'space in name.txt');
    writeFileSync(file, 'sanitized working copy');
    const result = spawnSync(process.execPath, [bin('scan-secrets.mjs')], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /space in name.txt:1: npm token \[redacted\]/);
    assert.ok(!`${result.stderr}${result.stdout}`.includes(token));
    // --exclude and --root are honoured; a clean tree passes from any directory.
    const excluded = spawnSync(process.execPath, [bin('scan-secrets.mjs'), '--root', root, '--exclude', 'space in *'],
      { cwd: tmpdir(), env, encoding: 'utf8' });
    assert.equal(excluded.status, 0, excluded.stderr);
    assert.match(excluded.stdout, /Secret scan passed/);
    const usage = spawnSync(process.execPath, [bin('scan-secrets.mjs'), '--bogus'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(usage.status, 2);
  } finally { cleanup(); }
});

test('private-data failures redact denied content and reject local-state files', () => {
  const { root, env, git, cleanup } = repository('private');
  try {
    const privateTerm = 'private-' + 'fixture-name';
    writeFileSync(join(root, '.private-terms'), `# comment\n\n${privateTerm}\n`);
    writeFileSync(join(root, 'notes.txt'), `line one\n${privateTerm}\n`);
    writeFileSync(join(root, `${privateTerm}.txt`), 'clean');
    mkdirSync(join(root, 'state'));
    writeFileSync(join(root, 'state/events.jsonl'), '{}');
    git('add', 'notes.txt', 'state/events.jsonl', `${privateTerm}.txt`);
    const run = (...args) => spawnSync('bash', [bin('check-private-data.sh'), ...args], { cwd: root, env, encoding: 'utf8' });
    const result = run('--staged');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /forbidden file: state\/events.jsonl/);
    assert.match(result.stderr, /notes.txt:2 \[redacted\]/);
    assert.match(result.stderr, /private term in a file name: \(path redacted\)/);
    assert.ok(!result.stderr.includes(privateTerm));

    // Repository-specific exemptions and additions.
    git('rm', '-q', '--cached', `${privateTerm}.txt`);
    writeFileSync(join(root, 'notes.txt'), 'clean');
    mkdirSync(join(root, 'output'));
    writeFileSync(join(root, 'output/report.txt'), 'clean');
    git('add', 'notes.txt', 'output/report.txt');
    assert.equal(run('--allow', '^state/').status, 0);
    const extra = run('--allow', '^state/', '--forbid-dir', 'output');
    assert.equal(extra.status, 1);
    assert.match(extra.stderr, /forbidden file: output\/report.txt/);
    assert.equal(run('--forbid-dir', 'a|b').status, 2);

    // Commit messages, an explicit terms file and --root from another directory.
    const message = join(root, 'message.txt');
    writeFileSync(message, `fix: mention ${privateTerm}\n`);
    const checked = spawnSync('bash', [bin('check-private-data.sh'), '--root', root, '--message', message],
      { cwd: tmpdir(), env, encoding: 'utf8' });
    assert.equal(checked.status, 1);
    assert.ok(!checked.stderr.includes(privateTerm));
    writeFileSync(join(root, 'other-terms'), 'unrelated-term\n');
    assert.equal(run('--terms-file', 'other-terms', '--message', 'message.txt').status, 0);
    assert.equal(run('--message', 'missing-message.txt').status, 2);

    writeFileSync(join(root, '.private-terms'), '[');
    const invalid = run();
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /invalid regular expression/i);
  } finally { cleanup(); }
});
