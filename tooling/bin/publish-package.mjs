#!/usr/bin/env node
// hive-publish-package [--root DIR] [--name NAME] [--tag-prefix PREFIX]
// Publishes the package in --root (default: the current directory) with provenance when its
// version is not on npm yet. DRY_RUN=true|false is required; a real publication must run from
// GITHUB_REF refs/tags/<PREFIX><version> (default prefix v) with npm trusted publishing.
import { resolve } from 'node:path';
import { publishPackage } from '../lib/publish.mjs';

const USAGE = 'Usage: DRY_RUN=true|false hive-publish-package [--root DIR] [--name NAME] [--tag-prefix PREFIX]';
try {
  const args = process.argv.slice(2);
  const options = { root: process.cwd(), tagPrefix: 'v' };
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (value === undefined) throw new Error(USAGE);
    if (args[index] === '--root') options.root = resolve(value);
    else if (args[index] === '--name') options.name = value;
    else if (args[index] === '--tag-prefix') options.tagPrefix = value;
    else throw new Error(USAGE);
  }
  if (!['true', 'false'].includes(process.env.DRY_RUN)) throw new Error('DRY_RUN must be true or false');
  await publishPackage({ ...options, dryRun: process.env.DRY_RUN === 'true', ref: process.env.GITHUB_REF });
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
