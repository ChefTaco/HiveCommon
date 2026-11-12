# AGENTS.md - HiveCommon

Guidance for contributors (human or AI) working on HiveCommon (`@hivemagnus/hive-common`), the
shared server kit of the Hive:Magnus suite: Oathweave token verification, the error envelope,
health endpoints, request context, the Hive Registry client, logging, HiveEvents and framework
adapters. Every suite product depends on it, so a change here changes all of them. This
repository is public and Apache-2.0; preserve LICENSE and NOTICE.

## Privacy

This repository is public. Never commit secrets, private infrastructure, runtime state, local
notes, or real user data, in code, tests, fixtures, docs, or commit messages:

- No real hostnames, private network domains, IP addresses, usernames, email addresses, or home
  paths. Use placeholders: `example.com` and `example.test` hosts (`oathweave.example.test`),
  documentation IP ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`), `operator` or
  `user` accounts, `/home/operator`, and fake tokens such as `fixture-token`.
- Never commit `.env`, `.env.*` (except `.env.example`), keys, certificates, `AGENTS.local.md`,
  `CLAUDE.local.md`, or `.private-terms`. Read `AGENTS.local.md` when present; never copy it into
  tracked content.
- Install the hooks with `npm run hooks:install` and never bypass them (`--no-verify`). They run
  `scripts/check-private-data.sh` (forbidden paths and the optional, gitignored `.private-terms`
  denylist, also on commit messages), `scripts/scan-secrets.sh` and Gitleaks.
- Tests that need TLS or signing keys generate them at runtime and delete them; never commit one.

## Package rules

- **Fail closed.** The verifier refuses on any doubt. Every refusal is an `OathweaveError` with a
  stable `reason`; 401 for bad credentials, 403 for known callers without access, 503 when the
  identity provider cannot be reached. Never turn a 503 into an accept.
- **RS256 only, exact issuer and audience, at most fifteen minutes.** Do not add algorithms,
  audience arrays or longer lifetimes as defaults; options exist for the lifetime only.
- **The conformance vectors are a contract.** Products run `test-vectors/oathweave/vectors.json`
  in their own tests. Add vectors freely; change an expected outcome only with a changelog entry
  that says why, and regenerate (`npm run vectors:generate`) only on purpose.
- **`/contracts` and `/errors` are isomorphic.** No Node built-ins, no runtime dependencies,
  nothing but each other. The browser UI vendors them. A test enforces this.
- **No secrets in output.** Error messages are fixed or sanitised and never echo tokens, webhook
  URLs or upstream bodies. Log lines go through `redact()`. Health checks hide error text unless
  `exposeErrors` is set.
- **Minimal dependencies.** `jose` is the only runtime dependency; `hono` is an optional peer.
  Adding a dependency needs a reason in the pull request.
- **Additive changes.** Exports, envelope fields and HiveEvent v1 fields are public API: add,
  never rename or remove, outside a major version.

## Ground rules

- Node.js 24.22.3+ or 26.13.1+, ESM only, strict TypeScript (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`). Match the style of the file you edit.
- Every subpath has its own entry in `package.json` `exports` and its own `src/<name>/index.ts`.
- Validate every external input before use: configuration, tokens, HTTP responses and headers.

## Tests and gates

Add or update tests with every behaviour change; security-relevant fixes need a regression test.
Tests use loopback fixtures, `example.com`/`example.test` hosts and fake tokens only. Before
sending a change, run:

```bash
npm run verify   # privacy tests, secret and private-data scans, typecheck, lint, test, build, pack
```

## Commits and releases

Use [Conventional Commits](https://www.conventionalcommits.org/). Never overwrite published
versions or release tags. Releases publish from a `vX.Y.Z` tag through
`.github/workflows/publish.yml`, which waits for approval on the `npm-publish` environment and
authenticates with npm trusted publishing (OIDC) with provenance; no npm token is stored.
