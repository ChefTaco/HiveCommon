# Contributing to HiveCommon

Bug reports, documentation fixes and pull requests are welcome.

## Getting set up

```bash
npm ci                # Node.js 24.22.3+ or 26.13.1+
npm run hooks:install # privacy and secret checks on commit and push
npm run build
```

## Before opening a pull request

Run the same gates that CI runs:

```bash
npm run verify
```

- Keep TypeScript strict and follow the style of the surrounding code. See [AGENTS.md](AGENTS.md).
- Add or update tests for behaviour changes; security fixes need a regression test.
- `/contracts`, `/errors`, `/fetch` and `/feed` must stay isomorphic: no Node built-ins, no
  runtime dependencies. A test enforces this.
- Changing verifier behaviour means checking the conformance vectors. Regenerate them only on
  purpose (`npm run vectors:generate`), and say so in the changelog: every product runs them.
- Never commit `.env` files, keys, certificates or details of private infrastructure.
  The git hooks in `.githooks/` enforce this.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`,
`chore:` and so on), with an optional scope such as `fix(oathweave): ...`.

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).

## Secret scanning

Install the pinned, checksum-verified Gitleaks CLI before contributing:

```bash
bash scripts/install-gitleaks.sh
git config core.hooksPath .githooks
bash scripts/test-gitleaks.sh
bash scripts/gitleaks.sh --staged
bash scripts/gitleaks.sh --history
```

Gitleaks 8.30.1 is free and runs directly; no paid Action or organization license
is required. The installer supports Linux and macOS on x64 and ARM64 and uses the
user cache, without sudo. Other platforms can put that exact version on PATH.
Missing or incompatible binaries fail the hooks rather than skipping checks.

The commit hook scans an export of the exact Git index, including force-added
ignored files. The push hook scans every outgoing ref's commit range, including
secrets deleted in a later commit. New refs or unavailable remote bases receive
a complete reachable-history scan. Existing privacy checks still run.

All output redacts matched secrets. Inline `gitleaks:allow` comments are ignored.
Never add real credentials to an allowlist. The one exception in `.gitleaks.toml`
covers the synthetic conformance tokens in `test-vectors/oathweave/vectors.json`,
matched by file and by their exact synthetic token headers, and scoped to the `jwt`
rule (a global allowlist path would skip the whole file for every rule). Any new exception must
match both one exact value (or exact synthetic prefix) and a specific file, with a
reason; do not exempt whole directories or disable built-in detection rules.
