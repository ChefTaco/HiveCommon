import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const version = '8.30.1';
const cached = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'hivemagnus-tools/gitleaks', version, 'gitleaks');
const onPath = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
const available = existsSync(cached) || onPath.stdout?.trim() === version;
// CI (npm run test:ci) installs Gitleaks first and requires this test; locally it is skipped
// with a reason when the pinned binary is missing (run hive-install-gitleaks).
const required = process.env.HIVE_DEVTOOLS_REQUIRE_GITLEAKS === '1';

test('gitleaks wrapper and installer regression checks', { skip: !available && !required && `Gitleaks ${version} is not installed` }, () => {
  const result = spawnSync('bash', [resolve(import.meta.dirname, 'gitleaks-fixture.sh')], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Gitleaks regression checks passed/);
});
