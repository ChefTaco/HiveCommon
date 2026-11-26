#!/usr/bin/env node
// Dependency-free Node.js runtime preflight. This file imports only Node built-ins so it can
// also be streamed to a host before any deployment writes:
//
//   ssh host 'node --input-type=module - --engines "^24.22.3 || ^26.13.1"' < lib/node-runtime.mjs
//
//   hive-check-node-runtime [--package FILE]   fail unless this Node satisfies the package's engines.node
//   hive-check-node-runtime --engines RANGE     fail unless this Node satisfies RANGE
//   hive-check-node-runtime --print-range [--package FILE]
//
// Only `^X.Y.Z || ^X.Y.Z` ranges are accepted: each names a supported major and its patch floor.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertNodeVersion(version, range) {
  const actual = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!actual || typeof range !== 'string') throw Error('A stable Node.js version and package engines range are required');
  const allowed = range.split('||').map(part => {
    const match = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(part.trim());
    if (!match || Number(match[1]) < 1) throw Error('Unsupported package Node.js engines range');
    return match.slice(1).map(Number);
  });
  const current = actual.slice(1).map(Number);
  if (![...current, ...allowed.flat()].every(Number.isSafeInteger)) throw Error('Invalid Node.js version');
  if (!allowed.some(minimum => current[0] === minimum[0] &&
    (current[1] > minimum[1] || current[1] === minimum[1] && current[2] >= minimum[2]))) {
    throw Error(`Node.js ${range} is required; found ${version}`);
  }
}

/** Reads and validates engines.node from a package.json (default: ./package.json). */
export function packageNodeRange(file = resolve(process.cwd(), 'package.json')) {
  const range = JSON.parse(readFileSync(file, 'utf8')).engines?.node;
  // Validate syntax before the value is used in a remote shell argument.
  if (typeof range !== 'string' || range !== range.trim() || range.length > 200 || !/^\^\d+\.\d+\.\d+(?: *\|\| *\^\d+\.\d+\.\d+)*$/.test(range)) {
    throw Error('Package must declare a bounded Node.js engines range');
  }
  return range;
}

export function runNodeRuntimeCheck(args, version = process.versions.node) {
  let packageFile;
  let engines;
  let print = false;
  for (let index = 0; index < args.length; index++) {
    const next = () => {
      const value = args[++index];
      if (value === undefined || value === '') throw Error('Use --print-range, --engines RANGE or --package FILE');
      return value;
    };
    if (args[index] === '--print-range') print = true;
    else if (args[index] === '--package') packageFile = resolve(next());
    else if (args[index] === '--engines') engines = next();
    else throw Error('Use --print-range, --engines RANGE or --package FILE');
  }
  if (print && engines !== undefined) throw Error('--print-range and --engines cannot be combined');
  if (print) return packageNodeRange(packageFile);
  assertNodeVersion(version, engines ?? packageNodeRange(packageFile));
  return undefined;
}

export function isMain(url, argv1 = process.argv[1]) {
  if (argv1 === '-') return true; // streamed on stdin
  if (!argv1) return false;
  try { return realpathSync(argv1) === fileURLToPath(url); } catch { return false; }
}

if (isMain(import.meta.url)) {
  try {
    const range = runNodeRuntimeCheck(process.argv.slice(2));
    if (range !== undefined) console.log(range);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
