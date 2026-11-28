# Changelog

All notable changes to `@hivemagnus/hive-common` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.11.0] - 2026-11-28

### Added

- `/sse`: `followSse()` option `onStateChange` reports the connection state for a UI:
  `connecting` before each request, `open` once the server answered with a stream, and
  `retrying` before the wait for the next connection, with `delayMs`, `failures` and the `error`
  that ended the connection (types `SseConnectionState` and `SseStateChange`). A throwing
  callback ends the follow.
- `/sse`: `followSse()` option `onUnauthorized` renews credentials after a 401 instead of stopping:
  `true` reconnects at once, calling `headers` again, without counting a failed connection. It is
  called once per 401; a 401 on the connection right after a renewal ends the follow with
  `SseStatusError(401)`, while a later 401 (after a connection opened) is renewed again. `false`
  stops as before; a rejection counts as a failed connection and is retried with backoff.
- `/sse`: `parseSseStream(body, { maxEventBytes?, signal?, requireData?, onRetry? })`, the
  incremental parser `followSse()` uses as an async generator over one response body: linear,
  bounded by `maxEventBytes` (1 MiB by default, `SseEventTooLargeError`), cancels the body when
  the loop ends early, throws or the signal aborts. `requireData` yields only events with a
  `data:` line (as `EventSource`); type `ParseSseStreamOptions`.
- `/rate-limit`: `createRedisSlidingWindowStore({ redis, windowMs, max, keyPrefix?, retryAfter?,
  now? })`, a shared `RateLimitStore` on one Redis sorted set per key: refused requests count
  too, it survives restarts, each set keeps at most the newest `max + 1` entries (so a flood
  cannot grow it), and the key passed to `consume()` (after `keyPrefix`) is the Redis key;
  `cost` is a whole number. It needs only a structural ioredis-style `pipeline()` (`SlidingWindowRedis`,
  `SlidingWindowPipeline`, including `zremrangebyrank`), so HiveCommon takes no Redis dependency. `retryAfter: 'window'`
  (default) or `'oldest'` (from the entry scores, needs `zrange`). A command error, a discarded
  pipeline or an unreadable reply is thrown (`RateLimitStoreError` for the last two), never read
  as allowed.
- `/rate-limit`: `trustedProxies()` accepts IPv4 wildcards such as `10.*.*.*` or `192.0.2.*`
  (four parts, each `*` or an exact octet; IPv4 only), matching Oathweave's `TRUSTED_PROXY_IPS`.
  An entry that could never match (`10.*`, `010.*.*.*`, `10.*.*.*/8`) throws at startup.
- `/rate-limit`: `resolveClientAddress()` option `trustedHops`: count a fixed number of proxies
  from the right of `X-Forwarded-For` behind a trusted peer instead of walking the trusted
  ranges. Only the counted entries are read; client-written entries further left are ignored. A
  short chain or a counted entry that is not an address is `invalid_forwarding`, attributed to
  the peer. Also a middleware option, checked when the middleware is built.
- `/rate-limit`: `createRateLimiter()` option `onEvict(key)` and `limiter.evictions`, for keys
  dropped to stay within `maxKeys`.
- `/rate-limit`: `spendRequestLimit()`, the middlewares' request step that returns a refusal
  (`RateLimitRefusal`: `key`, `client`, `result`, `retryAfterSeconds`, `headers`, `error`)
  instead of throwing; types `RateLimitRequestOptions` and `RequestLimitOutcome`.
- `/hono` and `/node-http`: `rateLimit()` takes `limiter` as a function of the request, choosing
  the store per request (undefined lets the request through), and `respond` to answer a refusal
  in the product's own shape: Hono `respond(c, refusal)` with the 429 headers already set on `c`;
  `/node-http` `respond(req, res, refusal)` when called with `res`, returning the outcome with
  `refusal` set.
- `/audit`: `auditExportPage()` option `encodeCursor(position)` for a product that keeps issuing
  its own cursor form; its result must be what the export query accepts (1 to 512 characters of
  `[A-Za-z0-9._~:-]`), or the page throws a TypeError.
- `/oathweave`: `createOathweaveVerifier()` may omit `issuer` (or pass `[]`) for a service-only
  verifier of native-issuer tokens (`nativeIssuers` non-empty, `accept: 'service'`,
  `nativeIssuerAccept: 'service'`), so no placeholder https issuer is needed.
- `/oathweave`: `jwksStaleIfErrorMs` keeps trusting the last good JWKS for that long after its
  fetch when a refresh fails (at most a day, `OATHWEAVE_JWKS_MAX_STALE_MS`), and
  `onJwksRefresh({ keys, fetchedAt })` / `onJwksError({ error, stale, ageMs })` report fetches
  for metrics. With any of them the key set is read with a 256 KiB bound
  (`OATHWEAVE_JWKS_MAX_BYTES`) and checked before jose sees it. Types `JwksRefreshOptions`,
  `JwksRefreshEvent`, `JwksErrorEvent`.
- `/log`: `redact()` options `keyPattern` (a regular expression or predicate for extra keys) and
  `maskNonStrings` (`true`, or `'listed'` for keys from `keys`/`keyPattern` only) to mask numbers,
  booleans and null under sensitive keys too; logger options `redactKeyPattern` and
  `redactNonStrings`.

### Changed

- `/sse`: a `Retry-After` on a transient refusal (408, 429, 5xx) now sets the wait before the next
  connection, capped at the policy's `maxMs` like the server's `retry:` field. It used to be
  ignored, so such a follower now reconnects no sooner than the server asked.
- `/log`: `redactText()` (and so `redact()` on every string and every log line) now masks a
  `name=value` or `name: value` pair whose name only ends in a secret word: `NODE_TOKEN=x`,
  `db_password: x`, `"AGENT_SECRET":"x"`, `nodeToken=x`. The name is kept and the value masked.
  Before, the name had to start at a word boundary, so these were left in clear. This is more
  masking: a log or diagnostic line that showed such a value now shows `[REDACTED]`.
- `/audit`: `decodeAuditCursor()` and `parseAuditExportQuery()` now accept the legacy cursor
  form `{ id }` (base64url JSON with a single `id`, for example `eyJpZCI6NX0`) as the position
  `{ id }`. Such a cursor used to be refused with 400 `invalid_cursor`.
- `/audit`: `encodeAuditCursor()` (and so `auditExportPage()`) throws a TypeError for a position
  whose cursor would be longer than the 512 characters `parseAuditExportQuery()` accepts (a string
  id and time of more than about 180 characters together). It used to return that cursor, which
  the export then refused with 400 on the collector's next page. `decodeAuditCursor()` returns
  undefined for such a cursor, as the query parser already refused it.
- `/hono` and `/node-http`: `HonoRateLimitOptions` and `NodeRateLimitOptions` no longer extend
  `RateLimitMiddlewareOptions` as a whole: their `limiter` is wider (a store or a function), so
  they extend it without `limiter`. Code that only builds these options is unaffected.

### Upgrade notes

- Additive: without the new options `followSse()` behaves as in 0.10.0, except that it honours a
  refusal's `Retry-After` (at most the policy's `maxMs`, 15 s by default).
- Every other new option is off by default. Two defaults change: `redactText()` masks more
  (secret-word suffixes, see Changed), and audit exports accept `{ id }` cursors. Products that
  layered their own suffix rule on `redactText()` (or a `{ id }` cursor decoder) can drop it.

## [0.10.0] - 2026-11-26

### Added

- `/oathweave`: the recent-authentication check takes `authenticatedAfter` (epoch seconds): when
  the product started a `prompt=login` re-authentication. An `auth_time` earlier than that,
  beyond the clock tolerance, is refused as `REAUTH_STALE` with reason `before_request`, even
  inside the window.

### Upgrade notes

- Additive: a new optional check field, no dependency or behaviour change for existing callers.

## [0.9.0] - 2026-11-26

### Added

- `/oathweave`: `createRecentAuthenticationVerifier()` and `verifyRecentAuthentication()` check a
  step-up proof on the server: an Oathweave ID token from a fresh authorization request
  (`prompt=login` / `max_age`). They verify the RS256 signature against the JWKS, the exact
  issuer, an audience from an explicit list of trusted browser clients, the lifetime, and the
  nonce, subject and session (`sid`) when given, then that `auth_time` is within the window
  (default 300 s, at most 3600 s). Refusals are a `RecentAuthenticationError` (a `HiveError`)
  with the codes `REAUTH_REQUIRED`, `REAUTH_STALE`, `REAUTH_INVALID` (401) and
  `REAUTH_UNAVAILABLE` (503) and a `reason`. Also added: `isRecentAuthenticationError()`,
  `RECENT_AUTHENTICATION_DEFAULT_MAX_AGE_SEC` and `RECENT_AUTHENTICATION_MAX_AGE_LIMIT_SEC`.

### Upgrade notes

- Additive: new exports only, no dependency or behaviour change for existing callers. Products
  that took a password to confirm a sensitive action can accept this proof instead.

## [0.8.0] - 2026-11-26

### Added

- `/oathweave`: `followOathweaveRevocations()` follows Oathweave's session revocation feed
  (`GET /api/v1/hive/events`, HiveEvent v1 `session.revoked` and `user.sessions_revoked`) and calls
  the verifier's `invalidateSession()` / `invalidateSubject()`. It polls every 2 s once caught up
  and backs off after failures. Its options are `loadCursor` / `saveCursor` hooks, `onRevocation`
  and `onError` callbacks, a service token provider or token function, and `stop()` / `signal`.
  A 401 invalidates the service token, and a refused cursor restarts from the oldest event.
  Also added: `parseOathweaveRevocation()` and the constants `OATHWEAVE_PRODUCT_ID`,
  `OATHWEAVE_REVOCATIONS_PATH`, `OATHWEAVE_SESSION_REVOKED`, `OATHWEAVE_USER_SESSIONS_REVOKED`,
  `OATHWEAVE_REVOCATION_POLL_MS`, `OATHWEAVE_REVOCATION_RETRY_POLICY` and
  `OATHWEAVE_REVOCATION_TIMEOUT_MS`.
- Shared development tooling for the suite repositories, outside the runtime kit. `tooling/` is
  the separate package `@hivemagnus/hive-devtools` (its own version, tests, README and
  CHANGELOG, published on its own as `@hivemagnus/hive-devtools` 0.1.0), with the privacy and secret scans, the pinned Gitleaks wrapper
  and installer, the Node runtime preflight, an Actions pin check and the npm release helpers
  that products copied. `.github/workflows/reusable-node-verify.yml`, `reusable-privacy.yml`,
  `reusable-gitleaks.yml` and `reusable-action-pins.yml` are reusable workflows
  (`workflow_call`) built on them; the `Devtools` workflow tests the package and runs them on
  this repository. `publish-devtools.yml` publishes the package from `hive-devtools-vX.Y.Z` tags.

### Upgrade notes

- `followOathweaveRevocations()` reads Oathweave's revocation feed, which Oathweave serves from
  2.6.0; against an older Oathweave the feed answers 404 and the follower reports it through
  `onError` and keeps retrying with backoff. It needs a service token readable with `iam:tokens:introspect` or
  `iam:sessions:revoke`. Nothing else changes for existing callers: the addition is a new export
  and no dependencies changed.
- The development tooling is not part of this package (`scripts/test-devtools-boundary.mjs` keeps
  it out). Products adopt `@hivemagnus/hive-devtools` one at a time; see `tooling/README.md`.

## [0.7.0] - 2026-11-26

### Added

- `/rate-limit` (new, Node): `resolveClientAddress()`, which believes `X-Forwarded-For` only from
  a trusted proxy and reads it from the right; `trustedProxies()` (addresses, CIDR ranges and the
  `loopback`, `private` and `linklocal` presets); `normalizeIpAddress()` and `addressKey()`
  (IPv6 grouped by /64); `createRateLimiter()`, a keyed in-memory token bucket with a key cap;
  the `RateLimitStore` interface for a shared store; `rateLimitError()` (429 `rate_limited`,
  `Retry-After`, `details.retryAfterSeconds`), `rateLimitHeaders()` and `enforceRateLimit()`.
- `/hono`: `rateLimit()` middleware, `clientAddress()`, `getClientAddress()` and the
  `hiveClientAddress` context variable.
- `/node-http`: `rateLimit()` and `clientAddressOf()`.
- `/audit` (new, isomorphic): the HiveAuditRecord v1 type, `validateHiveAuditRecord()`,
  `isHiveAuditRecord()`, `validateHiveAuditPage()` and `HIVE_AUDIT_LIMITS`; the opaque export
  cursor (`encodeAuditCursor()`, `decodeAuditCursor()`, the `{ i }` and `{ t, i }` forms products
  already issue); `parseAuditExportQuery()`; `auditDetails()` (flat, redacted, bounded details),
  `auditAction()`, `auditRecordId()`; and `auditExportPage()`, which skips and counts rows that do
  not form a valid record while moving the cursor past them.
- `/sse`: `followSse()` options `maxEventBytes` (default 1 MiB, `DEFAULT_MAX_SSE_EVENT_BYTES`)
  and `idleTimeoutMs` (off by default), and the errors `SseHandlerError`,
  `SseEventTooLargeError` and `SseIdleTimeoutError`. The server's `retry:` field is honoured.
- `/registry`: `createRegistryClient()` option `maxResponseBytes` (default 1 MiB) and the
  `DEFAULT_CA_FETCH_TIMEOUT_MS` constant.
- `/oathweave`: `OATHWEAVE_USERINFO_MAX_BYTES` (64 KiB), the largest userinfo response read.
- `/oathweave`: `createServiceTokenProvider({ clientAuth: 'client_secret_basic' })` sends the
  client credentials in an HTTP Basic `Authorization` header (RFC 6749 section 2.3.1) instead of
  the form body. `client_secret_post` stays the default.
- `/oathweave`: `verifier.invalidateSession(sessionId)` and `verifier.invalidateSubject(sub)`
  drop the cached userinfo answers of one session or one user, for a product that learns of a
  sign-out, instead of `clearSessionCache()` dropping all of them. Code that implements the
  `OathweaveVerifier` interface itself (rather than calling `createOathweaveVerifier()`) must add
  both methods.
- `/health`: `readyCacheMs: false` runs every check on every readiness request.

### Changed

- `/health`: `createHealth()` (and so `registerHealthRoutes()` and `hiveHandler({ health })`)
  shares a readiness run between requests that arrive while it is in progress by default
  (`readyCacheMs: 0`). Before, every request ran every dependency check, so concurrent probes of
  an unauthenticated `/health/ready` multiplied the load on the dependencies.

### Fixed

- `/sse`: an `onEvent` handler that throws no longer loses the event. The handler error used to
  be swallowed, the cursor had already moved past the event, and the follower reconnected
  without cancelling the old body. Now the cursor moves only after the handler returns, the
  follow stops with an `SseHandlerError` (`cause` is the handler's error, `cursor` the last event
  handled, `event` the one that failed), and the connection is released on every exit.
- `/sse`: the follower parses line by line in linear time and bounds the event it is building.
  It used to append to one growing buffer and rescan all of it for a blank line on every chunk,
  so a server that never sent one used unbounded memory and quadratic time. Lines ending in CR,
  LF or CRLF are handled even when split across chunks, including a blank line written as
  `\n\r\n`, which used to go unrecognised.
- `/registry`: `createCaFetch()` streams the response body instead of buffering all of it
  before resolving, so `/fetch` `readBodyBounded()` and `boundedFetch({ fetch })` enforce their
  limit as the body arrives. It has a default deadline of 15 s for the request and its body.
- `/registry` and `/oathweave`: the registry client and the verifier's userinfo check read
  their responses with the bounded reader (1 MiB and 64 KiB) within the request deadline,
  instead of an unbounded `response.json()` or `response.text()`.

### Upgrade notes

- `followSse()`: a throwing `onEvent` (or `isTerminal`) now ends the follow with an
  `SseHandlerError` instead of being retried silently. Catch it, and resume from `error.cursor`
  if you want to try the event again. An event over 1 MiB now ends the follow with an
  `SseEventTooLargeError`; raise `maxEventBytes` for streams that send larger ones. After a
  server sends `retry: <ms>`, the follower waits that long (capped at the policy's `maxMs`)
  before reconnecting, as `EventSource` does, instead of reconnecting at once.
- `createCaFetch()`: requests now time out after 15 s, body included. Pass `timeoutMs: 0` for a
  long-lived stream and cancel it with a `signal`. A response body can be read once and holds
  the connection open until it is read or cancelled.
- The registry client refuses a success body over 1 MiB as `invalid_registry_response`; raise
  `maxResponseBytes` if your registry answers with more.
- Readiness: concurrent requests now get the same result object from one run. Set
  `readyCacheMs: false` for the old behaviour, or a positive number (1000-2000 ms) to also serve
  a finished result to an internet-facing endpoint.

## [0.6.1] - 2026-11-24

### Changed

- `/events`: `ChatterMostNotifier.notify()` computes its backoff with `/retry` `backoffDelay()`
  and its default `sleep` is `sleepAbortable()`. Delivery behaviour is unchanged: the same
  attempts, delays (jitter rounding included), retried statuses (408, 429 and every 5xx; not 425)
  and results. `Retry-After` is read as before, delta-seconds or an HTTP date, replacing the
  backoff and capped at `maxBackoffMs`; the notifier keeps its own lenient reading rather than
  `/contracts` `retryAfterMs()`, which refuses values such as `1.5` that the notifier treats as
  no wait. Only a negative `backoffMs`, which was never valid, now reaches `sleep` as 0 rather
  than a negative number; the real timer waited the same either way.

## [0.6.0] - 2026-11-23

### Added

- `/execution`: execution context v1 — qualified references (`hx1:<product>:<instance>:<kind>:<id>`),
  `validateExecutionContext()`, `rootExecution()`, `childExecution()`, the `x-hive-execution`
  header (`executionHeaders()`, `readExecutionHeader()`) and the `hiveExecution` A2A metadata key.
  Attribution only; an unsupported version is treated as absent.
- `/retry`: `RetryPolicy`, `backoffDelay()` with jitter, `Retry-After` and deadlines,
  `classifyRetry()`, `retry()`, `sleepAbortable()`, `RetryExhaustedError` and the `x-hive-retry`
  signal (`readRetrySignal()`).
- `/artifact`: artifact transfer v2 constants, `selectRendition()`, `formatReprDigest()`,
  `parseReprDigest()` and `parseByteRange()`.
- `/sse`: `followSse()`, a fetch-based server-sent event follower with `Last-Event-ID` reconnect,
  and `parseSseBlock()`.
- `/context`: `RequestContext.execution`, read from a valid inbound `x-hive-execution`
  (`trustInboundExecution`) and sent by `outboundHeaders()`.

## [0.5.1] - 2026-11-18

### Fixed

- `/health`: `resolveHealthPath()` (and so `createHealth().handle()` and `/node-http`
  `handleHealth()`) strips trailing slashes in one linear pass. The old `/\/+$/` regex
  was quadratic on a request path such as `//…/x` (CodeQL `js/polynomial-redos`).
- `/errors`: `parseHiveError()` trims leading and trailing `_` from a remote error code in linear
  time. The old `/^_+|_+$/g` regex was quadratic on a code such as `a___…a`. Results are
  unchanged.

## [0.5.0] - 2026-11-13

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
    event on its own, and `HiveEventFeedError`. A page larger than `maxPageBytes` is refused as
    `malformed`; the default is 6 MiB (`DEFAULT_MAX_PAGE_BYTES`), about twice the largest valid
    200-event page, and `Infinity` removes the bound.
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

[Unreleased]: https://github.com/ChefTaco/HiveCommon/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/ChefTaco/HiveCommon/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/ChefTaco/HiveCommon/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/ChefTaco/HiveCommon/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/ChefTaco/HiveCommon/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/ChefTaco/HiveCommon/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/ChefTaco/HiveCommon/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/ChefTaco/HiveCommon/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/ChefTaco/HiveCommon/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/ChefTaco/HiveCommon/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ChefTaco/HiveCommon/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ChefTaco/HiveCommon/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ChefTaco/HiveCommon/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ChefTaco/HiveCommon/releases/tag/v0.1.0
