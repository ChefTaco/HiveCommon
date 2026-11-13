# Changelog

All notable changes to `@hivemagnus/hive-common` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Fixes from a review of every module. No export was removed or renamed.

### Added

- `/contracts`: `REQUEST_ID_PATTERN` and `isValidRequestId()`, moved from `/context` (which still
  exports both) so the isomorphic modules can use them.
- Shared helpers that several products each carried a copy of. All are additive: no existing
  export changed behaviour.
  - `/oathweave`: `createServiceTokenProvider()`, a `client_credentials` token source with a
    cache, background refresh before expiry, one shared request for concurrent callers, backoff
    after a failure, `invalidate()`, and an expiry lowered to the token's own `exp`. Failures are
    a `ServiceTokenError` (a 503 `HiveError` with a `reason`) that never holds the secret, a
    token or the endpoint's response.
  - `/fetch` (new, isomorphic): `boundedFetch()`, `fetchJson()`, `readBodyBounded()`,
    `readTextBounded()`, `readJsonBounded()`, `parseJsonBytes()` and `BoundedFetchError`: outbound
    requests with a deadline combined with the caller's signal, `redirect: 'error'` by default, a
    response-size limit enforced while streaming, and opt-in request-ID and trace forwarding
    (`contextHeaders: outboundHeaders`).
  - `/hono` and `/node-http`: `readJsonBody()` and `readBody()`, which enforce a body-size limit
    while streaming (with or without `content-length`) and throw 413 `too_large`, 415
    `unsupported_media_type` or 400 `invalid_json`. In `/node-http` an oversized upload is
    answered and then drained, and `drainRequest()` does the same for other early refusals.
  - `/log`: `redact(value, { allowKeys })` and the logger's `redactAllowKeys`, for identifiers
    such as `authorizationId` whose name contains a secret-looking word. Their values are still
    scrubbed as text. Default masking is unchanged.
  - `/secrets` (new, Node): `timingSafeEqualString()`, `sha256Hex()`, `matchesSha256Digest()`,
    `readBearerToken()` and `bearerMatchesSha256Digest()`.
  - `/events`: `encodeFeedPosition()`, `decodeFeedPosition()`, `requireFeedPosition()`,
    `feedSince()` and `buildFeedPage()` for feeds ordered by `(occurredAt, id)`.
  - `/feed` (new, isomorphic): `readHiveEventFeed()`, a paging feed consumer that validates each
    event on its own, and `HiveEventFeedError`.
  - `/contracts`: `generateRequestId()` (now with a fallback where `crypto.randomUUID` is
    missing), `readRequestId()`, `resolveRequestId()`, `readHeader()`, `rawHeader()` and
    `HeaderSource`, moved from `/context` (which still exports them) so a browser can use them;
    `retryAfterMs()`; `FeedPosition`, `compareFeedPositions()` and `isAfterFeedPosition()`.
  - `/health`: `readyCacheMs`, so concurrent readiness requests share one run of the checks
    (`0`) and a finished result can be served for a short time (a positive number). Unset, the
    behaviour is unchanged.
  - `/hono`: `securityHeaders()` middleware (`nosniff`, `no-referrer`, frame `DENY`, with
    options to change, omit and add headers).

### Fixed

- `/log`: `redactText()` took quadratic time on text with many dotted words (`a.a.a.…`) or many
  `eyJ…-eyJ…` runs: about 3.5 s for 100 kB and a minute for 400 kB, blocking the event loop of any
  service that logs caller-supplied text. The URL-credential rule is now anchored on `://` and the
  JWT header segment is bounded at 4096 characters; matching is linear.
- `/log`: URL credentials without a user (`redis://:password@host`) or without a password
  (`https://token@host`) were not masked. Any URL userinfo is now masked.
- `/log`: keys containing `jwt`, `bearer` or `signature`, and the query parameters `secret`, `jwt`,
  `assertion` and `client_assertion`, are now treated as secrets.
- `/errors`: `toErrorResponse()` set `x-request-id` from a `HiveError`'s own `requestId` unchecked.
  One parsed from a peer's error body could hold characters a server refuses to send (including
  the `…` that `parseHiveError()` itself appended when truncating), so sending the error threw.
  The header is now set only for a well-formed ID, and `parseHiveError()` drops a malformed remote
  request ID (falling back to the `requestId` option) instead of keeping a cleaned copy.
- `/context`: `readIdempotencyKey()` read a repeated header given as an array (`['a', 'b']`) as
  absent, so the write ran without idempotency protection. It is now a 400
  `invalid_idempotency_key`.
- `/events`: `ChatterMostNotifier.notify()` claimed the event before building its body, so a
  `format` function that threw left the event claimed, and every later call answered `duplicate`
  for the dedupe window (24 h). The body is now built first.
- `/events`: `new MemoryDedupeStore({ maxEntries: 0 })` made `claim()` loop forever; `maxEntries`
  must now be a positive integer. `parseFeedQuery()` no longer defaults above `maxLimit`, and
  `decodeCursor()` refuses a non-finite number (`1e999`).
- `/registry`: `endpoint(id, { name })` looked the name up on the endpoint map's prototype chain,
  so `constructor` or `toString` returned a function as the `url`. Only listed endpoints resolve
  now. Endpoint maps whose values are not strings, non-string `dependencies` and non-string
  installation `products` are a 502 `invalid_registry_response`.
- `/health`: error text shown with `exposeErrors` is scrubbed with `redactText()` first, so a
  connection string in a driver error no longer shows its password. `createHealth()` refuses
  duplicate or empty check names at startup instead of failing every readiness request.
- `/node-http`: a request target that is not a URL (`//[`) made `handleHealth()` throw, which
  `hiveHandler()` answered with a logged 500; it is now passed to the handler like any other
  non-health request. If sending the error envelope itself throws (a logger that throws, for
  example), `hiveHandler()` closes the connection instead of leaving an unhandled rejection.
- `/oathweave`: the verifier read `audience` and `userinfoUrl` from the options object on every
  call, so changing that object after creation changed what the verifier accepted, without the
  endpoint checks. Both are now read once. `accept`, `requestTimeoutMs`, `sessionCacheTtlMs` (an
  infinite value cached sessions forever) and `sessionCacheMax` are validated at startup.
- `/oathweave`: `watchStreamAuthorization()` let a `recheck` that threw synchronously escape its
  timer as an uncaught exception; it now ends the stream with `session_inactive`.

### Changed

- Internal: native issuer validation and the fifteen-minute lifetime constant each have one
  definition instead of two.

## [0.4.0] - 2026-11-12

Fixes found while adopting 0.3.0, and two identity-link options. Every change is additive: without
the new options identity links parse as in 0.3.0.

### Added

- `/oathweave`: `parseIdentityLinks()` takes `localUserIdPattern`, a RegExp that replaces the
  default `localUserId` pattern, for products whose account labels are wider (for example
  `alice+ops@example.com`). It must match the whole value; `g` and `y` flags are ignored; values
  stay 1-256 characters; `system` and `service:` actors are always refused. The default pattern is
  exported as `LOCAL_USER_ID_PATTERN` and is unchanged.
- `/oathweave`: `parseIdentityLinks()` takes `nativeIssuers`, native issuer identifiers (each
  matching `OATHWEAVE_NATIVE_ISSUER_PATTERN`) that a link may name as its `issuer`, for service
  links to native-issuer tokens. Without it, link issuers must be https URLs as before.

### Fixed

- `/hono`: `registerHealthRoutes()`, `errorHandler()` and `notFoundHandler()` returned a raw
  `Response`, which dropped headers set earlier in the request with `c.header()`, such as a
  `traceparent` or `x-request-id` set before the handler ran. They now respond through the Hono
  context, so those headers stay. Status, body and the existing headers are unchanged.
- Default clocks read `Date.now()` on every call instead of holding the `Date.now` function found
  when the object was created. A verifier (token times and the session cache), `MemoryDedupeStore`
  or logger created before fake timers were installed kept the real clock; they now follow fake
  timers. `watchStreamAuthorization()`, health and request context use the same default. An
  explicit `now` option behaves as before.

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

[Unreleased]: https://github.com/ChefTaco/HiveCommon/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/ChefTaco/HiveCommon/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ChefTaco/HiveCommon/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ChefTaco/HiveCommon/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ChefTaco/HiveCommon/releases/tag/v0.1.0
