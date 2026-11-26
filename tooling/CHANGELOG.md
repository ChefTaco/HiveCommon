# Changelog

All notable changes to `@hivemagnus/hive-devtools` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

First version, 0.1.0; it is published by hand once (see the README).

### Added

- `hive-check-private-data`, `hive-scan-secrets` and the `./privacy-policy` export: the
  forbidden-path, private-terms and secret scans the suite repositories copied, from the most
  recent copy, with `--root`, `--terms-file`, `--forbid-dir`, `--allow`, `--secret-name`,
  `--allow-home-user` and `--exclude` for what the copies hard-coded. `.cindertrace/` is
  forbidden by default next to `.ardent/` and `.magnus/`. A path that contains a private term is
  printed as `(path redacted)`,
  and a missing `--message` file exits 2 instead of passing.
- `hive-gitleaks` and `hive-install-gitleaks`: the pinned Gitleaks 8.30.1 wrapper and installer,
  with `--root`, `--config` and `--dir PATH...` (scans build output).
- `hive-check-node-runtime` and the `./node-runtime` export, with `--package FILE` for
  repositories whose package.json is in a subdirectory; the library still streams over SSH.
- `hive-check-action-pins` and the `./action-pins` export: actions, reusable workflows and
  container images must be pinned by commit SHA or digest; `--require-version-comment`.
- `hive-check-publish-environment` (`--environment NAME`), `hive-publish-package`
  (`--name`, `--tag-prefix`) and the `./publish` export.
