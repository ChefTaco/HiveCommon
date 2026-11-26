# @hivemagnus/hive-devtools

Shared development tooling for the Hive:Magnus suite repositories. It replaces the release and
privacy scripts that each product used to copy into its own `scripts/` directory, and that had
drifted apart:

- privacy scans: forbidden paths, the local private-terms denylist, credentials and private
  infrastructure, with findings that never print the matching text;
- the pinned, checksum-verified Gitleaks wrapper and installer;
- the Node.js runtime preflight (also streamable to a host before a deployment);
- a GitHub Actions pin check;
- npm release helpers for trusted publishing (environment protection check and publish).

It also comes with reusable GitHub workflows in this repository's
[`.github/workflows`](../.github/workflows) directory.

This package lives in the HiveCommon repository but is **not** part of the runtime kit:
`@hivemagnus/hive-common` does not depend on it and its tarball does not contain it
(`scripts/test-devtools-boundary.mjs` checks both). Install it as a dev dependency only. It has
no runtime dependencies and needs Node.js 24.22.3+ or 26.13.1+, bash and git; it runs on Linux
and macOS.

## Commands

| Command | Replaces | What it does |
| --- | --- | --- |
| `hive-check-private-data` | `scripts/check-private-data.sh` | Forbidden paths and private terms in tracked files, the index (`--staged`) or a commit message (`--message FILE`) |
| `hive-scan-secrets` | `scripts/scan-secrets.sh`, `scan-secrets.mjs`, `privacy-policy.mjs` | Provider tokens, private keys, literal credentials, private network domains and personal home paths in working and staged files |
| `hive-gitleaks` | `scripts/gitleaks.sh` | Gitleaks 8.30.1 on the exact index (`--staged`), all history (`--history`), outgoing refs (`--pre-push`) or directories (`--dir`) |
| `hive-install-gitleaks` | `scripts/install-gitleaks.sh` | Downloads and checksum-verifies Gitleaks 8.30.1 into `~/.cache/hivemagnus-tools` (no sudo) |
| `hive-check-node-runtime` | `scripts/check-node-runtime.mjs` | Fails unless the running Node satisfies `engines.node` (`^X.Y.Z \|\| ^X.Y.Z` ranges only) |
| `hive-check-action-pins` | `workflow-pins.test.mjs` | Fails when a workflow or action uses an action, reusable workflow or image by tag instead of SHA or digest |
| `hive-check-publish-environment` | `scripts/check-publish-environment.mjs` | Fails unless the GitHub publication environment has a required reviewer |
| `hive-publish-package` | `scripts/publish-package.mjs` | `npm publish --provenance` from the matching tag when the version is not on npm yet |

Every scanner resolves the repository from the current directory (`git rev-parse
--show-toplevel`), so the commands work from any subdirectory; pass `--root DIR` to name it.

### hive-check-private-data

```text
hive-check-private-data [--root DIR] [--terms-file FILE] [--forbid-dir NAME]... [--allow REGEX]... [--staged | --message FILE]
```

- Forbidden paths: `.env` and `.env.*` (except `.env.example`), `.npmrc`, keys, certificates,
  databases and their `-wal`/`-shm`/`-journal` files, git bundles, `*.local.md`,
  `.private-terms`, `.vscode/mcp.json`, and anything inside a directory named `certs`,
  `backups`, `state`, `artifacts`, `.ardent`, `.magnus`, `.cindertrace`, `.hive-dev`, `.ssh`,
  `audit-logs` or `terminal-audit`.
- `--forbid-dir NAME` adds a directory name (for example `output`); `--allow REGEX` exempts
  paths that match an extended regex (for example `^test/fixtures/state/`).
- Private terms: `<root>/.private-terms` (or `--terms-file`), gitignored, one case-insensitive
  extended regex per line; `#` comments and blank lines are ignored. A missing file skips this
  layer. Findings print `file:line [redacted]`; a path that itself contains a term prints as
  `(path redacted)`. An invalid regex exits 2.

### hive-scan-secrets

```text
hive-scan-secrets [--staged] [--root DIR] [--secret-name NAME]... [--allow-home-user NAME]... [--exclude REGEX]...
```

Without `--staged` it scans tracked and untracked, non-ignored files, and then the index, so a
sanitized working copy cannot hide a staged secret. Rules: OpenAI, npm, GitHub and Slack tokens,
AWS access keys, private-key headers, and literal values of credential variables
(`DEPLOY_PASSWORD`, `SSH_PASSWORD`, `IAM_AGENT_SECRET`, `HIVE_ROUTER_SECRET`,
`HIVEMEM_JWT_SECRET`, `API_SECRET`, `JWT_SECRET`, `SESSION_SECRET`, `NODE_MANAGER_SECRET`,
`AWS_SECRET_ACCESS_KEY`; add more with `--secret-name`; names ending in `PASSWORD` need 8
characters, others 16). Explicit placeholders (`replace-...`, `change-me-...`, `...-example-...`,
`${...}`, `<...>`) and expressions (`process.env.X`) are not findings. It also reports private
network domain names and `/home/<name>` or `/Users/<name>` paths other than `operator`, `deploy`, `user`, `x`,
`foo` and `bar` (add more with `--allow-home-user`). `--exclude` takes a JavaScript regex of
repository-relative paths.

### hive-gitleaks and hive-install-gitleaks

```text
hive-gitleaks [--root DIR] [--config FILE] --staged | --history | --pre-push | --dir PATH...
```

The config defaults to `.gitleaks.toml` at the root and must be inside the repository; each
repository keeps its own config and allowlists. `--staged` exports the exact index (including
force-added ignored files) and uses the staged config. `--pre-push` reads the hook's stdin and
scans each outgoing range, or all reachable history for a new ref or an unknown remote base.
`--history` and `--pre-push` refuse a shallow clone. `--dir` scans directories such as build
output (paths relative to the root). Matches are redacted, inline `gitleaks:allow` comments are
ignored, and a missing or different Gitleaks version exits 2 instead of skipping. A machine that
already ran an older copy of `install-gitleaks.sh` shares the same cache.

### hive-check-node-runtime

```text
hive-check-node-runtime [--package FILE] | --engines RANGE | --print-range [--package FILE]
```

`--package` defaults to `./package.json`. To check a host before a deployment writes anything,
stream the library on its own; it imports only Node built-ins:

```bash
range="$(npx --no-install hive-check-node-runtime --print-range)"
ssh deploy@node.example.com "node --input-type=module - --engines '$range'" \
  < node_modules/@hivemagnus/hive-devtools/lib/node-runtime.mjs
```

### hive-check-action-pins

```text
hive-check-action-pins [--root DIR] [--path PATH]... [--require-version-comment]
```

Checks `.github/workflows`, `.github/actions` and a root `action.yml`. Accepted: `owner/repo[/path]@<40-hex SHA>`,
`docker://image@sha256:<digest>` and local `./` references. A `uses:` line it cannot parse is
a finding. `--require-version-comment` also requires a comment such as `# v7.0.1` or
`# hive-devtools-v0.1.0` after each SHA.

### hive-check-publish-environment and hive-publish-package

```text
GH_TOKEN=... hive-check-publish-environment [--environment NAME]
DRY_RUN=true|false hive-publish-package [--root DIR] [--name NAME] [--tag-prefix PREFIX]
```

The environment check reads `GITHUB_REPOSITORY` and needs a token with `actions: read`; it sends
the token only to `api.github.com` and fails unless a user or team is a required reviewer of
the environment (default `npm-publish`). The publisher refuses a private package, a package
whose name differs from `--name`, or a real run whose `GITHUB_REF` is not
`refs/tags/<prefix><version>` (default prefix `v`); it skips a version already on npm and
stops on any registry error. It never runs lifecycle scripts.

## Library

The same rules are importable, for repository-specific tests:

| Export | Functions |
| --- | --- |
| `@hivemagnus/hive-devtools/privacy-policy` | `forbiddenPath()`, `forbiddenPathMatcher()`, `secretFindings()`, `privateInfrastructureFindings()`, `DEFAULT_FORBIDDEN_DIRS`, `DEFAULT_SECRET_NAMES`, `DEFAULT_HOME_USERS` |
| `@hivemagnus/hive-devtools/node-runtime` | `assertNodeVersion()`, `packageNodeRange()`, `runNodeRuntimeCheck()` |
| `@hivemagnus/hive-devtools/action-pins` | `actionPinFindings()`, `workflowFiles()`, `checkActionPins()` |
| `@hivemagnus/hive-devtools/publish` | `assertPublishEnvironment()`, `checkPublishEnvironment()`, `readReleasePackage()`, `publishedVersionExists()`, `publishPackage()` |

## Reusable workflows

Call them by full commit SHA (a tag can be moved) and pass the same SHA as `devtools-ref`, which
selects the `tooling/` scripts the workflow runs. Each job runs with `contents: read` only.

| Workflow | Inputs (default) |
| --- | --- |
| `reusable-node-verify.yml` | `node-versions` (`["24.22.3", "26.13.1"]`), `working-directory` (`.`), `install-command` (`npm ci`), `verify-command` (`npm test`), `audit` (`true`), `audit-level` (`high`), `fetch-depth` (`1`), `runs-on` (`ubuntu-24.04`), `timeout-minutes` (`30`) |
| `reusable-privacy.yml` | `devtools-ref` (required), `forbid-dirs` (space-separated), `allow-paths` (one regex per line), `secret-names` (space-separated), `exclude-paths` (one regex per line), `check-commit-messages` (`true`), `runs-on`; secret `private-terms` (optional) |
| `reusable-gitleaks.yml` | `devtools-ref` (required), `config` (`.gitleaks.toml`), `build-command` and `scan-dirs` (optional build-output scan), `runs-on` |
| `reusable-action-pins.yml` | `devtools-ref` (required), `require-version-comment` (`true`), `runs-on` |

`reusable-node-verify.yml` needs no `devtools-ref`: it runs only the caller's own commands.
`reusable-privacy.yml` writes the optional `private-terms` secret (a repository or organization
secret holding the `.private-terms` lines) to a private temporary file, checks tracked files and
the commit messages of the pushed or pull-request range, and deletes the file. Nothing it finds
prints the term.

```yaml
# .github/workflows/hygiene.yml in a product repository
name: Hygiene
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  verify:
    uses: ChefTaco/HiveCommon/.github/workflows/reusable-node-verify.yml@<sha> # hive-devtools-v0.1.0
    with:
      verify-command: npm run verify
  privacy:
    uses: ChefTaco/HiveCommon/.github/workflows/reusable-privacy.yml@<sha> # hive-devtools-v0.1.0
    with:
      devtools-ref: <sha>
      forbid-dirs: output
    secrets:
      private-terms: ${{ secrets.PRIVATE_TERMS }}
  gitleaks:
    uses: ChefTaco/HiveCommon/.github/workflows/reusable-gitleaks.yml@<sha> # hive-devtools-v0.1.0
    with:
      devtools-ref: <sha>
  action-pins:
    uses: ChefTaco/HiveCommon/.github/workflows/reusable-action-pins.yml@<sha> # hive-devtools-v0.1.0
    with:
      devtools-ref: <sha>
```

## Adopting it in a repository

The reusable workflows work as soon as they are on `main`; the commands need the package on npm.

1. Add the exact version as a dev dependency: `npm install --save-dev --save-exact @hivemagnus/hive-devtools@0.1.0`.
2. Point the package scripts at the commands, keeping the repository's own options:

   ```json
   "scan:secrets": "hive-scan-secrets",
   "check:private": "hive-check-private-data",
   "check:node": "hive-check-node-runtime",
   "check:pins": "hive-check-action-pins --require-version-comment",
   "gitleaks:install": "hive-install-gitleaks"
   ```

3. Call the commands from the git hooks through `node_modules/.bin`, so a missing install fails
   the hook instead of fetching anything:

   ```bash
   # .githooks/pre-commit
   set -euo pipefail
   bin="$(git rev-parse --show-toplevel)/node_modules/.bin"
   "$bin/hive-check-private-data" --staged
   "$bin/hive-scan-secrets"
   "$bin/hive-gitleaks" --staged
   # .githooks/commit-msg: "$bin/hive-check-private-data" --message "$1"
   # .githooks/pre-push:   "$bin/hive-check-private-data"; "$bin/hive-gitleaks" --pre-push (stdin), then
   #                       "$bin/hive-check-private-data" --message for each outgoing range
   ```

4. Replace the copied CI jobs with the reusable workflows above.
5. Delete the copied scripts and their tests (`check-private-data.sh`, `scan-secrets.*`,
   `privacy-policy.mjs`, `gitleaks.sh`, `install-gitleaks.sh`, `check-node-runtime.mjs`,
   `check-publish-environment.mjs`, `publish-package.mjs`, `workflow-pins.test.mjs`). Keep the
   repository's `.gitleaks.toml` and any test that covers repository-specific allowlists.
6. Run every gate once (`npm run verify` or equivalent) and the hooks on a test commit.

Repository-specific options that the copies hard-coded:

| Repository pattern | Option |
| --- | --- |
| An extra state directory (for example `output/`) | `hive-check-private-data --forbid-dir output`; workflow `forbid-dirs: output` |
| A tracked fixture inside a forbidden directory | `--allow '^test/fixtures/state/'`; workflow `allow-paths` |
| `package.json` in a subdirectory (`ts-core/`, `apps/<name>/`) | `hive-check-node-runtime --package ts-core/package.json` |
| Build output scanned by Gitleaks (`--artifacts`) | `hive-gitleaks --dir packages/a/dist services/b/dist`; workflow `build-command` + `scan-dirs` |
| Extra credential variables | `hive-scan-secrets --secret-name PRODUCT_ADMIN_TOKEN` |
| Release tags other than `vX.Y.Z` | `hive-publish-package --tag-prefix product-v` |

Older copies of `check-private-data.sh` and `scan-secrets.sh` print the matching line, so a
private term or a secret value can reach a CI log. The commands here print only the file, line
and rule, so adopting them also removes that exposure.

## Versioning and releases

The package follows Semantic Versioning: a new rule that can fail an existing repository, a
changed default or a Gitleaks upgrade is a minor version before 1.0 and a major one after it,
and is listed in [CHANGELOG.md](CHANGELOG.md). Releases publish from a `hive-devtools-vX.Y.Z`
tag that matches `tooling/package.json` through
[`.github/workflows/publish-devtools.yml`](../.github/workflows/publish-devtools.yml), which
waits for approval on the `npm-publish` environment and authenticates with npm trusted
publishing (OIDC) with provenance. The `vX.Y.Z` tags stay reserved for `@hivemagnus/hive-common`.

### First publication (owner, once)

npm can only attach a trusted publisher to a package that exists, so the owner publishes the
first version by hand and then hands publication to the workflow:

1. From a clean checkout of `main`:

   ```bash
   cd tooling
   npm ci
   npm run test:ci
   npm pack --dry-run
   ```

2. Sign in to npm as an owner of the `@hivemagnus` scope (with two-factor authentication) and
   publish the first version without provenance (provenance needs CI):

   ```bash
   npm login
   npm publish --access public
   ```

3. On npmjs.com, open `@hivemagnus/hive-devtools` > **Settings** > **Trusted publishing**, choose
   **GitHub Actions**, and enter organization or user `ChefTaco`, repository `HiveCommon`,
   workflow filename `publish-devtools.yml` and environment `npm-publish`.
4. On the same page, under **Publishing access**, choose **Require two-factor authentication and
   disallow tokens**.
5. In GitHub, **Settings** > **Environments** > `npm-publish` > **Deployment branches and tags**,
   add the tag rule `hive-devtools-v*` next to the existing `v*` rule. Without it the publish job
   is refused before it starts.
6. Tag the published commit so the history records it:
   `git tag hive-devtools-v0.1.0 <commit> && git push origin hive-devtools-v0.1.0`. The workflow
   runs, finds 0.1.0 already on npm and skips publishing; approve the environment when asked.

Later releases: bump `version` in `tooling/package.json` and add a CHANGELOG section in a pull
request, merge it, then push the tag `hive-devtools-vX.Y.Z` on that commit and approve the
`npm-publish` environment.

## Development

```bash
cd tooling
npm test        # unit and integration tests; the Gitleaks test is skipped without the pinned binary
npm run test:ci # installs Gitleaks 8.30.1 first and requires that test (what CI runs)
```

The `Devtools` workflow runs `npm run test:ci` on Node 24 and 26 through
`reusable-node-verify.yml` and calls the other reusable workflows on this repository at the
pull request's commit, as a product would.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
