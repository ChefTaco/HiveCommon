#!/usr/bin/env node
// Scans working and staged content for credentials and private infrastructure without
// printing any matching value.
//
//   hive-scan-secrets [--staged] [--root DIR] [--secret-name NAME]... [--allow-home-user NAME]... [--exclude REGEX]...
//
// Without --staged it scans tracked and untracked, non-ignored files, then the index as well,
// so a sanitized working copy cannot hide a staged secret from the commit hook.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateInfrastructureFindings, secretFindings } from '../lib/privacy-policy.mjs';

const USAGE = 'Usage: hive-scan-secrets [--staged] [--root DIR] [--secret-name NAME]... [--allow-home-user NAME]... [--exclude REGEX]...';

export function parseArguments(argv) {
  const options = { staged: false, root: undefined, secretNames: [], homeUsers: [], exclude: [] };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next === '') throw new Error(USAGE);
      return next;
    };
    if (argument === '--staged') options.staged = true;
    else if (argument === '--root') options.root = value();
    else if (argument === '--secret-name') options.secretNames.push(value());
    else if (argument === '--allow-home-user') options.homeUsers.push(value());
    else if (argument === '--exclude') options.exclude.push(new RegExp(value()));
    else throw new Error(USAGE);
  }
  return options;
}

export function scan(options) {
  const root = options.root ? resolve(options.root)
    : execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const files = git(...(options.staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
    : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).toString().split('\0').filter(Boolean);
  let failures = 0;
  for (const file of new Set(files)) {
    if (options.exclude.some(pattern => pattern.test(file))) continue;
    // Tracked build output must be checked too; ignore rules exclude untracked build products.
    if (!options.staged && !existsSync(resolve(root, file))) continue;
    const content = (options.staged ? git('show', `:${file}`) : readFileSync(resolve(root, file))).toString();
    for (const finding of [...secretFindings(content, options), ...privateInfrastructureFindings(content, options)]) {
      console.error(`${file}:${finding.line}: ${finding.rule} [redacted]`);
      failures++;
    }
  }
  return { root, failures };
}

function main() {
  const argv = process.argv.slice(2);
  const options = parseArguments(argv);
  const { root, failures } = scan(options);
  let failed = failures > 0;
  if (!options.staged) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...argv, '--staged', '--root', root],
      { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
  if (failed) process.exitCode = 1;
  else console.log(`Secret scan passed (${options.staged ? 'staged' : 'working'} files).`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
