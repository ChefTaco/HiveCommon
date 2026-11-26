// GitHub Actions run with the workflow's token and secrets, and a tag or branch can be moved
// after review. Every `uses:` must therefore name an immutable revision:
//   - owner/repo[/path]@<40-hex commit SHA>   (actions and reusable workflows)
//   - docker://image@sha256:<64-hex digest>
//   - ./local/path                            (same repository and commit; exempt)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const USES = /^\s*(?:-\s+)?(?:\{\s*)?uses:\s*(["']?)([^\s"'#,}]+)\1\s*(?:[,}].*)?(#.*)?$/;
const USES_KEY = /^\s*(?:-\s+)?(?:\{\s*)?uses:/;
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
const DIGEST = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;

/**
 * Findings for one workflow or action file. With `requireVersionComment`, a pinned action also
 * needs a trailing comment that names the version it resolves to (`# v4.2.1`, or a tag such
 * as `# hive-devtools-v0.1.0`), so updates
 * can be reviewed.
 */
export function actionPinFindings(text, { requireVersionComment = false } = {}) {
  const findings = [];
  for (const [index, line] of text.split('\n').entries()) {
    const match = USES.exec(line);
    if (!match) {
      // Fail closed on a `uses:` this parser does not understand rather than skipping it.
      if (USES_KEY.test(line)) findings.push({ line: index + 1, uses: line.trim().slice(0, 120), rule: 'unrecognised uses: syntax' });
      continue;
    }
    const reference = match[2];
    if (reference.startsWith('./')) continue;
    if (reference.startsWith('docker://')) {
      if (!DIGEST.test(reference)) findings.push({ line: index + 1, uses: reference, rule: 'container image is not pinned to a sha256 digest' });
      continue;
    }
    if (!PINNED.test(reference)) {
      findings.push({ line: index + 1, uses: reference, rule: 'not pinned to a full commit SHA' });
    } else if (requireVersionComment && !/^#\s*(?:[A-Za-z0-9._-]*-)?v?\d+(?:\.\d+)*/.test(match[3] ?? '')) {
      findings.push({ line: index + 1, uses: reference, rule: 'pinned SHA has no version comment' });
    }
  }
  return findings;
}

function walk(directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) files.push(path);
  }
}

/** Workflow and action files of a repository: .github/workflows, .github/actions and a root action.yml. */
export function workflowFiles(root, paths = ['.github/workflows', '.github/actions', 'action.yml', 'action.yaml']) {
  const files = [];
  for (const path of paths) {
    const full = join(root, path);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files.sort();
}

/** Checks every workflow file under `root` and returns `file:line` findings. */
export function checkActionPins(root, options = {}) {
  const findings = [];
  const files = workflowFiles(root, options.paths);
  for (const file of files) {
    for (const finding of actionPinFindings(readFileSync(file, 'utf8'), options)) {
      findings.push({ file: relative(root, file), ...finding });
    }
  }
  return { files: files.length, findings };
}
