// Packs the package, checks the published file list against an allowlist, installs the
// tarball into a disposable prefix and imports every subpath export from the installed copy,
// including a conformance run that reads the shipped test vectors.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'hive-common-package-check-'));
const run = (command, args, options = {}) => new Promise((resolvePromise, reject) => {
  execFile(command, args, { cwd: root, timeout: 180_000, maxBuffer: 64 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${command} ${args[0] ?? ''} failed: ${String(stderr).slice(-2000) || error.message}`));
    else resolvePromise(String(stdout));
  });
});
try {
  await run('npm', ['run', 'build']);
  const listing = JSON.parse(await run('npm', ['pack', '--dry-run', '--json', '--silent'], { maxBuffer: 8 * 1024 * 1024 }));
  const files = listing[0].files.map(file => file.path);
  const allowed = [
    /^dist\/[A-Za-z0-9/._-]+\.(?:js|d\.ts)$/,
    /^test-vectors\/oathweave\/(?:vectors|jwks)\.json$/,
    /^test-vectors\/README\.md$/,
    /^README\.md$/, /^LICENSE$/, /^NOTICE$/, /^CHANGELOG\.md$/, /^package\.json$/,
  ];
  const unexpected = files.filter(path => !allowed.some(pattern => pattern.test(path)));
  if (unexpected.length) throw new Error(`Unexpected packed files: ${unexpected.join(', ')}`);
  const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const subpaths = Object.keys(source.exports).filter(key => !key.includes('*') && key !== './package.json');
  const required = ['README.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md', 'test-vectors/oathweave/vectors.json', 'test-vectors/oathweave/jwks.json'];
  for (const subpath of subpaths) {
    const entry = source.exports[subpath];
    required.push(entry.default.slice(2), entry.types.slice(2));
  }
  for (const file of required) if (!files.includes(file)) throw new Error(`Packed file missing: ${file}`);

  const filename = (await run('npm', ['pack', '--pack-destination', temporary, '--silent'])).trim().split('\n').at(-1);
  if (!filename || !/^hivemagnus-hive-common-[0-9][A-Za-z0-9.-]*\.tgz$/.test(filename)) throw new Error('Pack did not produce the expected tarball');
  const install = join(temporary, 'install');
  const hono = source.devDependencies.hono;
  await run('npm', ['install', '--prefix', install, '--omit=dev', '--no-audit', '--no-fund', '--no-save', '--ignore-scripts',
    join(temporary, filename), `hono@${hono}`], { timeout: 5 * 60_000 });
  const packageDir = join(install, 'node_modules/@hivemagnus/hive-common');
  if (!(await realpath(packageDir)).startsWith(`${install}/`)) throw new Error('Installed package resolves outside the disposable prefix');
  const installed = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  if (installed.name !== source.name || installed.version !== source.version) throw new Error('Installed package identity differs');

  // Import through the package name, as a consumer would, so the exports map is exercised.
  const probe = join(install, 'probe.mjs');
  await writeFile(probe, `
    const subpaths = ${JSON.stringify(subpaths)};
    const counts = {};
    for (const subpath of subpaths) {
      const module = await import('@hivemagnus/hive-common' + subpath.slice(1));
      counts[subpath] = Object.keys(module).length;
      if (!counts[subpath]) throw new Error('No exports from ' + subpath);
    }
    const { runOathweaveConformance, hiveCommonConformanceVerify } = await import('@hivemagnus/hive-common/oathweave/conformance');
    const report = await runOathweaveConformance(hiveCommonConformanceVerify(), { strictReasons: true });
    const { readFileSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const jwks = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('@hivemagnus/hive-common/test-vectors/oathweave/jwks.json'), 'utf8'));
    if (!jwks.keys.length) throw new Error('Shipped JWKS is empty');
    console.log(JSON.stringify({ counts, conformance: report.passed }));
  `);
  const result = JSON.parse((await run(process.execPath, [probe], { cwd: install })).trim());
  console.log(JSON.stringify({ package: filename, files: files.length, version: installed.version, ...result }));
} finally { await rm(temporary, { recursive: true, force: true }); }
