#!/usr/bin/env node
// hive-check-action-pins [--root DIR] [--path PATH]... [--require-version-comment]
// Fails when a workflow or action uses a third-party action, reusable workflow or container
// image by a movable tag instead of a commit SHA or image digest. See lib/action-pins.mjs.
import { resolve } from 'node:path';
import { checkActionPins } from '../lib/action-pins.mjs';

const USAGE = 'Usage: hive-check-action-pins [--root DIR] [--path PATH]... [--require-version-comment]';
try {
  const args = process.argv.slice(2);
  let root = process.cwd();
  const paths = [];
  let requireVersionComment = false;
  for (let index = 0; index < args.length; index++) {
    const next = () => { const value = args[++index]; if (!value) throw new Error(USAGE); return value; };
    if (args[index] === '--root') root = resolve(next());
    else if (args[index] === '--path') paths.push(next());
    else if (args[index] === '--require-version-comment') requireVersionComment = true;
    else throw new Error(USAGE);
  }
  const { files, findings } = checkActionPins(root, { requireVersionComment, ...(paths.length ? { paths } : {}) });
  for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.rule}: ${finding.uses}`);
  if (findings.length) {
    console.error(`${findings.length} unpinned reference(s). Pin each to a full commit SHA (with a # vX.Y.Z comment) or an image digest.`);
    process.exitCode = 1;
  } else console.log(`Action pins check passed (${files} file(s)).`);
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
