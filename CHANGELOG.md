# Changelog

All notable changes to `@hivemagnus/hive-common` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-12

Options that let a product keep its existing behaviour without wrapping the shared helpers. Every
change is additive: the defaults are those of 0.1.0.

### Added

- `/oathweave`: `requireRoles` (default `false`) refuses a token without a `roles` array.
- `/oathweave`: `clientIdClaim: 'clientId' | 'client_id' | 'either'` (default `'either'`) chooses
  which claim names supply the client ID. Both claims present must still agree. `clientIdOf()`,
  `principalKindOf()` and `extractRoles()` take matching optional arguments, and `ClaimPolicy`
  matching optional fields. `CLIENT_ID_CLAIMS` and the `ClientIdClaim` type are exported.
- `/oathweave`: `parseIdentityLinks()` accepts `localId` as an alias of `localUserId`. An entry
  that sets both to different values is refused. Parsed links always use `localUserId`.
- `/context`: `trustInboundRequestId` and `trustInboundTrace` trust the inbound request ID and the
  inbound `traceparent`/`tracestate` separately. Each defaults to `trustInbound`. The `/hono` and
  `/node-http` adapters take them too.
- `/health`: `liveBody` replaces the `/health/live` body with a product's own, as an object or a
  function of the standard body. `liveness()`, `createHealth()`, `Health`, `registerHealthRoutes()`
  and `hiveHandler({ health })` accept it; `HealthOptions` and `Health` take an optional type
  parameter for the body, defaulting to `LiveBody`.
- README: "Choosing settings for an existing product".

## [0.1.0] - 2026-11-12

First release: the shared server kit that replaces each product's own copy of the Oathweave
verifier and its own error, health and request-ID conventions.

### Added

- `/oathweave`: Oathweave access-token verifier. RS256 only, JWKS with caching and refetch on an
  unknown key ID, exact issuer (one or several) and audience, `exp`/`nbf`/`iat` with clock
  tolerance, fifteen-minute lifetime limit, user and service principals (a service token's client
  ID equals its subject), scopes, roles and permissions, optional online session check through
  userinfo with a 10 s shared cache, stream re-check, identity links and permission helpers.
  Refusals are `OathweaveError`s with a stable `reason` and 401, 403 or 503.
- `/oathweave/conformance` and `test-vectors/oathweave/`: twelve pre-signed conformance vectors at
  a fixed clock and `runOathweaveConformance()`, so every product can test its verifier.
- `/errors`: `HiveError`, the `{ error: { code, message, requestId?, details? } }` envelope,
  `toErrorResponse()`, and `parseHiveError()` for every legacy error shape in the suite.
  Isomorphic.
- `/health`: `/health/live` and `/health/ready` with named, time-limited dependency checks,
  200/503, and optional legacy path aliases.
- `/context`: request IDs (`x-request-id`, accepting `x-hive-request-id` and `x-correlation-id`),
  W3C `traceparent`, idempotency keys, an AsyncLocalStorage request context and
  `outboundHeaders()`.
- `/registry`: typed Hive Registry client with custom CA or fetch injection.
- `/log`: structured JSON logger with request IDs from the context, and `redact()`.
- `/events`: HiveEvent feed helpers and `ChatterMostNotifier` (timeout, retries with backoff,
  deduplication by event ID).
- `/contracts`: isomorphic types and dependency-free validators for the envelope, HiveEvent v1,
  pagination and agent identity.
- `/hono` and `/node-http` adapters for auth, request context, the error envelope and health.

[Unreleased]: https://github.com/ChefTaco/HiveCommon/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ChefTaco/HiveCommon/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ChefTaco/HiveCommon/releases/tag/v0.1.0
