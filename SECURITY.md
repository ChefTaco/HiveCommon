# Security Policy

## Supported versions

Security fixes are released for the latest `0.x` version of `@hivemagnus/hive-common`.

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Report them privately through
[GitHub private vulnerability reporting](https://github.com/ChefTaco/HiveCommon/security/advisories/new).
Please include:

- the affected version or commit
- steps to reproduce, or a proof of concept
- the impact you expect

You should get an acknowledgement within a few days. Once a fix is available, a GitHub security
advisory will credit you unless you ask not to be named.

## Scope

This package verifies Oathweave access tokens for every Hive:Magnus product, so a flaw in
`/oathweave` affects the whole suite. Reports about token verification, the session check,
redaction (`/log`) or error responses leaking internals (`/errors`, `/hono`, `/node-http`) are
especially welcome.

## Notes for products

- Configure the verifier with `https` endpoints only. `allowInsecureLoopback` exists for tests.
- Configure `userinfoUrl` so a signed-out session stops working within seconds.
- Link each person explicitly and refuse unlinked identities (`requireIdentityLink()`).
- Run the shipped conformance vectors in your own test suite (`runOathweaveConformance()`).
- Keep ChatterMost webhook URLs and registry credentials in a private env file; they are secrets.
