// Installs a packed HiveCommon tarball into a checkout of a suite product and runs that
// product's typecheck (and, where it has one, its Oathweave conformance test) against it, so a
// breaking change is found before a release rather than after.
//
//   node scripts/check-downstream.mjs <consumer> <checkout-dir> <tarball>
//   node scripts/check-downstream.mjs --list
//
// The consumer table below is the contract: each entry names the package directories that
// depend on @hivemagnus/hive-common and the commands to run in them.
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * `install` is the directory whose lockfile is installed (`npm ci --ignore-scripts`, as the
 * products' own bootstrap does); `setup` runs next (more lockfiles, generated code); `packages`
 * are the directories (relative to the checkout) that depend on HiveCommon, where the tarball
 * replaces the locked copy; `steps` run last, in order. Each command is `[directory, command, ...args]`.
 */
const RELEASE_TOOLING = ['.', 'npm', '--prefix', 'tooling/release', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'];

export const CONSUMERS = {
  hivemem: {
    repository: 'ChefTaco/HiveMem',
    install: 'ts-core',
    setup: [RELEASE_TOOLING],
    packages: ['ts-core'],
    steps: [['ts-core', 'npm', 'run', 'typecheck']],
  },
  hiveskills: {
    repository: 'ChefTaco/HiveSkills',
    install: '.',
    setup: [RELEASE_TOOLING],
    packages: ['.'],
    steps: [['.', 'npm', 'run', 'typecheck']],
  },
  emberpath: {
    repository: 'ChefTaco/Emberpath',
    install: '.',
    setup: [RELEASE_TOOLING],
    packages: ['.'],
    steps: [
      ['.', 'npm', 'run', 'typecheck'],
      ['.', 'npx', 'vitest', 'run', 'tests/security/oathweave-conformance.test.ts'],
    ],
  },
  ardentstudio: {
    repository: 'ChefTaco/ArdentStudio',
    install: '.',
    setup: [],
    packages: ['.'],
    steps: [['.', 'npm', 'run', 'typecheck'], ['.', 'npx', 'vitest', 'run', 'test/auth.test.ts']],
  },
  hivexui: {
    repository: 'ChefTaco/HiveXUI',
    install: '.',
    setup: [],
    packages: ['.'],
    steps: [['.', 'npm', 'run', 'typecheck']],
  },
  magnus: {
    repository: 'ChefTaco/magnus',
    install: '.',
    // The server and gateway import the built internal packages.
    setup: [
      ['.', 'npm', '--workspace', '@hivemagnus/magnus-server', 'run', 'db:generate'],
      ['.', 'npm', 'run', 'build', '-w', '@hivemagnus/magnus-contracts', '-w', '@hivemagnus/magnus-oathweave', '-w', '@hivemagnus/magnus-skills', '-w', '@hivemagnus/magnus-agent'],
    ],
    packages: ['services/control-api', 'services/fleet-gateway'],
    steps: [
      ['services/control-api', 'npm', 'run', 'typecheck'],
      ['services/fleet-gateway', 'npm', 'run', 'typecheck'],
    ],
  },
};

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    process.stdout.write(`\n$ (${cwd}) ${command} ${args.join(' ')}\n`);
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolvePromise() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))));
  });
}

async function main(argv) {
  if (argv[0] === '--list') {
    process.stdout.write(`${JSON.stringify(Object.entries(CONSUMERS).map(([name, entry]) => ({ name, repository: entry.repository })))}\n`);
    return;
  }
  const [name, checkoutArg, tarballArg] = argv;
  const consumer = name ? CONSUMERS[name] : undefined;
  if (!consumer || !checkoutArg || !tarballArg) {
    throw new Error(`Usage: check-downstream.mjs <${Object.keys(CONSUMERS).join('|')}> <checkout-dir> <tarball>`);
  }
  const checkout = resolve(checkoutArg);
  const tarball = isAbsolute(tarballArg) ? tarballArg : resolve(tarballArg);
  await access(tarball);
  const installDir = join(checkout, consumer.install);
  await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], installDir);
  for (const [directory, command, ...args] of consumer.setup) await run(command, args, join(checkout, directory));
  for (const directory of consumer.packages) {
    const manifest = JSON.parse(await readFile(join(checkout, directory, 'package.json'), 'utf8'));
    const declared = manifest.dependencies?.['@hivemagnus/hive-common'] ?? manifest.devDependencies?.['@hivemagnus/hive-common'];
    if (!declared) throw new Error(`${directory} no longer depends on @hivemagnus/hive-common; update the consumer table`);
    const workspace = directory === consumer.install ? [] : ['--workspace', directory];
    // --no-save: the consumer's manifest and lockfile stay as checked out.
    await run('npm', ['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', ...workspace, tarball], installDir);
  }
  for (const [directory, command, ...args] of consumer.steps) await run(command, args, join(checkout, directory));
  process.stdout.write(`\n${name}: passed against ${tarball}\n`);
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
