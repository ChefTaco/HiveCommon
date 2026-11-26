// The dev tooling in tooling/ (@hivemagnus/hive-devtools) is a separate package. It must never
// ship inside, or become a dependency of, the runtime kit @hivemagnus/hive-common, and it must
// not depend on the kit either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const dependencyNames = pkg => Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies, ...pkg.devDependencies });

test('the runtime kit and the dev tooling are separate packages', () => {
  const kit = read('package.json');
  const tooling = read('tooling/package.json');
  assert.equal(kit.name, '@hivemagnus/hive-common');
  assert.equal(tooling.name, '@hivemagnus/hive-devtools');
  assert.ok(!dependencyNames(kit).includes(tooling.name), 'hive-common must not depend on hive-devtools');
  assert.ok(!dependencyNames(tooling).includes(kit.name), 'hive-devtools must not depend on hive-common');
  assert.ok(!kit.files.some(entry => entry.replace(/^\.\//, '').startsWith('tooling')), 'tooling is not in the kit files list');
  assert.ok(!kit.workspaces, 'the kit is not a workspace root that would hoist the tooling');
});

test('the packed runtime kit contains no tooling files', () => {
  const [listing] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--silent', '--ignore-scripts'],
    { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  assert.deepEqual(listing.files.map(file => file.path).filter(path => path.startsWith('tooling/')), []);
});
