// Packs the package, checks the file list against an allowlist, installs the tarball into a
// disposable prefix and runs every bin through its npm symlink, then imports every export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('the packed package holds only the tooling and every bin runs from an install', { timeout: 180_000 }, () => {
  const npm = (args, cwd = root) => execFileSync('npm', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' } });
  const [listing] = JSON.parse(npm(['pack', '--dry-run', '--json', '--silent', '--ignore-scripts']));
  const files = listing.files.map(file => file.path).sort();
  const allowed = [/^bin\/[a-z-]+\.(?:mjs|sh)$/, /^lib\/[a-z-]+\.mjs$/, /^(?:README|CHANGELOG)\.md$/, /^LICENSE$/, /^NOTICE$/, /^package\.json$/];
  assert.deepEqual(files.filter(path => !allowed.some(pattern => pattern.test(path))), []);
  for (const target of Object.values(manifest.bin)) {
    const entry = listing.files.find(file => file.path === target);
    assert.ok(entry, `${target} is packed`);
    assert.ok(entry.mode & 0o111, `${target} is executable`);
  }
  assert.equal(manifest.dependencies, undefined, 'the tooling has no runtime dependencies');

  const temporary = mkdtempSync(join(tmpdir(), 'hive-devtools-pack-'));
  try {
    const tarball = npm(['pack', '--silent', '--ignore-scripts', '--pack-destination', temporary]).trim().split('\n').at(-1);
    writeFileSync(join(temporary, 'package.json'), JSON.stringify({ name: 'consumer', private: true, engines: manifest.engines }));
    npm(['install', '--ignore-scripts', '--no-package-lock', join(temporary, tarball)], temporary);
    const binary = name => join(temporary, 'node_modules/.bin', name);
    const run = (name, args, options = {}) => spawnSync(binary(name), args, { cwd: temporary, encoding: 'utf8', ...options });

    assert.equal(run('hive-check-node-runtime', ['--print-range']).stdout.trim(), manifest.engines.node);
    assert.equal(run('hive-check-node-runtime', ['--engines', '^1.0.0']).status, 1);
    assert.equal(run('hive-check-action-pins', ['--root', temporary]).status, 0);
    assert.equal(run('hive-check-publish-environment', []).status, 1); // no GITHUB_REPOSITORY or GH_TOKEN
    assert.equal(run('hive-publish-package', [], { env: { ...process.env, DRY_RUN: 'maybe' } }).status, 1);
    // The privacy scanners run inside a consumer repository.
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
    execFileSync('git', ['init', '-q'], { cwd: temporary, env });
    execFileSync('git', ['add', 'package.json'], { cwd: temporary, env });
    const scanned = run('hive-scan-secrets', ['--exclude', '^node_modules/', '--exclude', '\\.tgz$'], { env });
    assert.equal(scanned.status, 0, scanned.stderr);
    assert.equal(run('hive-check-private-data', ['--staged'], { env }).status, 0);
    assert.equal(run('hive-gitleaks', ['--unknown'], { env }).status, 2);
    for (const subpath of Object.keys(manifest.exports).filter(key => key !== './package.json')) {
      // Resolved through the package's exports map, as a consumer imports it.
      const specifier = manifest.name + subpath.slice(1);
      const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const m = await import(${JSON.stringify(specifier)}); if (!Object.keys(m).length) process.exit(3);`], { cwd: temporary, encoding: 'utf8' });
      assert.equal(imported.status, 0, `${subpath}: ${imported.stderr}`);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
