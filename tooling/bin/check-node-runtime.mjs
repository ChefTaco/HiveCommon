#!/usr/bin/env node
// hive-check-node-runtime [--package FILE] | --engines RANGE | --print-range [--package FILE]
// See lib/node-runtime.mjs, which can also be streamed to a remote host on its own.
import { runNodeRuntimeCheck } from '../lib/node-runtime.mjs';

try {
  const range = runNodeRuntimeCheck(process.argv.slice(2));
  if (range !== undefined) console.log(range);
} catch (error) { console.error(error.message); process.exitCode = 1; }
