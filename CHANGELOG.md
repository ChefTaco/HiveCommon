# Changelog

All notable changes to `@hivemagnus/hive-common` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-11-12

Native-issuer service tokens. Oathweave signs client-credentials tokens with its native issuer
(its `JWT_ISSUER`, for example `hive-iam`), which is a name, not an https URL, so 0.2.0 refused the
configuration and products kept a local jose check for those tokens. Every change is additive:
without the new options a verifier behaves as in 0.2.0.

### Added

- `/oathweave`: `nativeIssuers` accepts tokens whose `iss` is one of the listed native
  identifiers. Each must match `OATHWEAVE_NATIVE_ISSUER_PATTERN` (`^[a-z][a-z0-9-]{0,63}$`), so a
  URL or anything else is a startup error. They are verified with the same `jwksUrl` (still https)
  or `keys` as the https issuer, because Oathweave signs both with one key. A native issuer is never
  accepted unless listed. `verifier.nativeIssuers` lists them.
- `/oathweave`: `nativeIssuerAccept` (default `'service'`) limits which principals a native issuer
  may sign for. A user token from a native issuer is refused with `invalid_issuer` by default,
  before any userinfo call.
- `/oathweave`: `maxLifetimeSec` also takes `{ user?, service? }`, one limit per principal kind;
  each defaults to 900. `ClaimPolicy.maxLifetimeSec` and `principalFromClaims()` take the same
  shape. The `OathweaveLifetimeLimits` type is exported.
- `/oathweave/conformance`: `ConformanceVectors.nativeIssuers` and `ConformanceContext.nativeIssuers`.
  `hiveCommonConformanceVerify()` configures them.
- Conformance vectors: `valid-native-service` (accept), `unconfigured-native-issuer` (401
  `invalid_issuer`) and `native-service-lifetime-too-long` (401 `invalid_lifetime`). There is no
  vector for a native-issuer user token, because Oathweave does issue those (to registered clients
  that are not suite browser clients); refusing them is a product setting, not a contract.
- README: "Native issuers", and native-issuer and per-kind lifetime rows in "Choosing settings for
  an existing product".

### Changed

- The conformance vectors were regenerated with `npm run vectors:generate` to sign the new tokens,
  so every token and the test JWKS changed (the signing keys are discarded after each run). The
  existing vectors keep their names, claims and expected outcomes. A product verifier that is not
  configured with `ctx.nativeIssuers` now fails `valid-native-service`; configure it, or exclude
  that vector with `only` until the product accepts native issuers.

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

[Unreleased]: https://github.com/ChefTaco/HiveCommon/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/ChefTaco/HiveCommon/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ChefTaco/HiveCommon/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ChefTaco/HiveCommon/releases/tag/v0.1.0
