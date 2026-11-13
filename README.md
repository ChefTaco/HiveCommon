# HiveCommon

`@hivemagnus/hive-common` is the shared server kit of the Hive:Magnus suite. It gives every
product one Oathweave token verifier, one error envelope, one way to serve health, propagate
request IDs and trace context, read the Hive Registry, log safely and publish HiveEvents.

- ESM only, TypeScript with `.d.ts` output, strict types.
- One runtime dependency (`jose`); `hono` is an optional peer.
- Each module is its own subpath, so a product loads only what it uses.
- `/contracts`, `/errors`, `/fetch` and `/feed` are isomorphic, so the browser UI can use them too.

```bash
npm install @hivemagnus/hive-common
```

| Subpath | What it is | Runs in |
| --- | --- | --- |
| [`/oathweave`](#oathweave) | Oathweave access-token verifier, identity links, permissions, stream re-check, service-token provider | Node |
| [`/oathweave/conformance`](#conformance-vectors) | Runs the shipped test vectors against any verifier | Node |
| [`/errors`](#errors) | `HiveError`, the envelope, `toErrorResponse()`, `parseHiveError()` | Node, browser |
| [`/health`](#health) | `/health/live` and `/health/ready` with dependency checks | Node |
| [`/context`](#context) | Request IDs, `traceparent`, idempotency keys, async request context | Node |
| [`/registry`](#registry) | Typed Hive Registry client | Node |
| [`/log`](#log) | Structured JSON logger and `redact()` | Node |
| [`/events`](#events) | HiveEvent feed helpers and the ChatterMost notifier | Node |
| [`/feed`](#feed) | HiveEvent feed consumer | Node, browser |
| [`/fetch`](#fetch) | Outbound fetch with a deadline and a response-size limit | Node, browser |
| [`/secrets`](#secrets) | Constant-time comparison, digest-checked static tokens, bearer header parsing | Node |
| [`/contracts`](#contracts) | Isomorphic types and validators, request IDs, `Retry-After` | Node, browser |
| [`/hono`](#hono) | Hono middleware | Node |
| [`/node-http`](#node-http) | `node:http` helpers | Node |

## Node support policy

HiveCommon supports the active and maintenance LTS lines of Node.js at their latest security
release: currently **Node.js 24.22.3+ and 26.13.1+** (`"engines": "^24.22.3 || ^26.13.1"`). When
Node publishes a security release, the minimums move up in the next HiveCommon release. A Node
line is dropped, in a minor release, when it reaches end of life. CI tests every supported line.

## Standards

### Error envelope

Every error response in the suite has this body, `Content-Type: application/json` and
`Cache-Control: no-store`:

```json
{ "error": { "code": "not_found", "message": "No such project", "requestId": "2f1c…", "details": { "id": "p1" } } }
```

- `code`: stable, machine-readable, `lower_snake_case` for new codes.
- `message`: for people. Never contains secrets, stack traces or upstream bodies.
- `requestId`: the request's `x-request-id`, when known.
- `details`: optional structured data, such as validation `issues` or an auth `reason`.

Statuses: 400 malformed, 401 missing or invalid credentials (with `WWW-Authenticate`), 403 known
caller without access, 404, 409, 422 validation, 428 missing precondition (idempotency key), 429
(with `Retry-After`), 500 internal (generic message only), 503 dependency unavailable.

### Headers

| Header | Rule |
| --- | --- |
| `x-request-id` | Read inbound; also accept `x-hive-request-id` and `x-correlation-id`. Generate a UUID when absent or unsafe (1-128 of `[A-Za-z0-9._:@/+=-]`). Echo it on the response and send it to peers. |
| `traceparent`, `tracestate` | W3C Trace Context. Continue a valid inbound trace with a new span; otherwise start one. Send this service's span to peers. |
| `Idempotency-Key` | Required on retried mutations; `x-idempotency-key` is accepted too. Both present and different is a 400. |
| `Authorization: Bearer` | Oathweave access token, RS256. |

### Health

`GET /health/live` is 200 whenever the process can answer and never touches dependencies.
`GET /health/ready` runs the named checks and is 200 (`ready` or `degraded`) or 503 (`not_ready`):

```json
{ "status": "not_ready", "service": "hivemem", "version": "1.4.0", "time": "2026-11-12T08:00:00.000Z",
  "checks": { "database": { "status": "down", "critical": true, "latencyMs": 2001, "error": "timeout" } } }
```

## Modules

### oathweave

```ts
import { createOathweaveVerifier, requireIdentityLink, parseIdentityLinks } from '@hivemagnus/hive-common/oathweave';

const verifier = createOathweaveVerifier({
  issuer: process.env.OATHWEAVE_ISSUER!,          // https only; an array accepts several issuers
  audience: 'hivemem',                            // this product's resource audience, exact match
  jwksUrl: process.env.OATHWEAVE_JWKS_URL!,
  userinfoUrl: process.env.OATHWEAVE_USERINFO_URL, // online session check, recommended
  accept: 'user',                                 // default; 'service' or 'any' per route
});

const principal = await verifier.verifyAuthorization(request.headers.get('authorization'));
// principal.kind === 'user': subject, sessionId, clientId, roles, permissions, scopes, displayName, authTime…
// principal.kind === 'service': a client-credentials token whose client ID equals its subject.

const links = parseIdentityLinks(process.env.HIVEMEM_OATHWEAVE_IDENTITIES_JSON!, { roles: ['ADMIN', 'VIEWER'] });
const link = requireIdentityLink(links, principal); // 403 not_linked unless exactly one link matches
```

What it checks, in order: a compact JWT of at most 16 KiB; header `alg` is `RS256` (so `none` and
HMAC key confusion never reach a key); signature against the JWKS (cached for 10 minutes and
refetched, at most every 30 s, when a token names an unknown `kid`); `iss` is one of the issuers;
`aud` is exactly the audience; `sub`, `iat`, `exp`, `jti` present; `exp`, `nbf` and `iat` within
30 s of clock tolerance; `exp - iat` and token age at most 900 s (`maxLifetimeSec`, one number or
`{ user, service }`); then the principal rules:

- **User:** `actorType: "USER"`, a `sessionId`, a `clientId` other than the subject, string-array
  `permissions` and (optional) `roles`. With `userinfoUrl`, the session is confirmed online; the
  answer is shared for 10 s from when the request started (failures for 2 s), or not at all with
  `sessionCacheTtlMs: 0`.
- **Service:** `clientId` (or `client_id`) equals `sub`, `actorType: "SERVICE_ACCOUNT"`,
  `token_type: "access"`, no session.

Every refusal is an `OathweaveError` (a `HiveError`) with a stable `reason`:

| Status | Code | Reasons |
| --- | --- | --- |
| 401 | `unauthorized` | `missing_token` |
| 401 | `invalid_token` | `malformed_token`, `algorithm_not_allowed`, `unknown_key`, `invalid_signature`, `expired`, `not_yet_valid`, `invalid_issuer`, `invalid_audience`, `invalid_lifetime`, `invalid_claims`, `wrong_principal_kind`, `session_inactive`, `subject_mismatch` |
| 403 | `forbidden` / `insufficient_permission` | `not_linked`, `insufficient_permission` |
| 503 | `auth_unavailable` | `jwks_unavailable`, `identity_unavailable` |

Also: `hasPermissions()` (with `*` segment wildcards, like the Oathweave SDK), `requirePermissions()`,
`hasAnyRole()`, `hasScopes()`, `effectivePermissions()` (a link's ceiling), and
`watchStreamAuthorization()` for SSE and WebSocket connections:

```ts
const watch = watchStreamAuthorization({
  recheck: () => verifier.verify(token), // every 5 s; the session cache keeps it cheap
  expiresAt: principal.expiresAt,        // ends the stream at token expiry
  onEnd: () => stream.close(),           // sign-out takes effect within about 15 s
});
```

Two options make the claim rules stricter for products that always required more:

- `requireRoles: true` refuses a token without a `roles` array. The default (`false`) treats an
  absent `roles` claim as no roles. A `roles` claim that is not a string array is always refused.
- `clientIdClaim` chooses which claim names supply the client ID: `'clientId'` (Oathweave),
  `'client_id'` (RFC 9068) or `'either'` (the default). When both claims are present they must
  agree in every mode.

#### Native issuers

Oathweave signs browser-client tokens with its https issuer, but client-credentials tokens with its
*native* issuer (its `JWT_ISSUER`, for example `hive-iam`) unless the client's machine policy selects
the browser issuer. Both are signed by the same key and published in the same JWKS. List the native
identifiers in `nativeIssuers` to accept those tokens too:

```ts
const verifier = createOathweaveVerifier({
  issuer: process.env.OATHWEAVE_ISSUER!,  // still required, still https
  nativeIssuers: ['hive-iam'],             // exact `iss` values; never accepted unless listed
  audience: 'hivemem',
  jwksUrl: process.env.OATHWEAVE_JWKS_URL!, // the one https JWKS serves both issuers
  userinfoUrl: process.env.OATHWEAVE_USERINFO_URL,
  accept: 'service',
});
```

- Each entry must match `OATHWEAVE_NATIVE_ISSUER_PATTERN` (`^[a-z][a-z0-9-]{0,63}$`), so a URL or
  any other shape is a startup error. There is no separate JWKS setting: `jwksUrl` (https, or
  loopback http with `allowInsecureLoopback`) or `keys` verify both kinds of issuer.
- A native issuer signs service principals only, by default: a user token from a native issuer is
  refused with `invalid_issuer` before any session check. Suite user tokens come from browser
  clients, which Oathweave always signs with the https issuer. `nativeIssuerAccept: 'any'` (or
  `'user'`) changes that for a product that really takes native user tokens.
- Every other rule (audience, lifetime, principal rules) is unchanged. `principal.issuer` is the
  native identifier, so identity and service links keyed by `(issuer, clientId)` keep working.
  `verifier.nativeIssuers` lists them; `verifier.issuers` still lists only the https issuers.

Identity links name the local account `localUserId`. `localId`, the name older deployment configs
use, is accepted as an alias; an entry that sets both to different values is refused. Parsed links
always carry `localUserId`.

By default a `localUserId` matches `LOCAL_USER_ID_PATTERN` (`^[A-Za-z0-9][A-Za-z0-9._@:-]{0,255}$`).
A product whose account labels are wider, such as `alice+ops@example.com`, passes its own
`localUserIdPattern`. The pattern must match the whole value (`g` and `y` flags are ignored), values
stay 1-256 characters, and `system` and `service:` actors are refused whatever the pattern allows.
Link issuers must be https URLs unless `nativeIssuers` lists native identifiers (each matching
`OATHWEAVE_NATIVE_ISSUER_PATTERN`) for links to service principals; pass the same list as the
verifier's `nativeIssuers`.

```ts
const links = parseIdentityLinks(raw, {
  localUserIdPattern: /^(?!\s)[^\u0000-\u001f\u007f]{1,256}$/u, // any printable label
  nativeIssuers: ['hive-iam'],                                   // service links keyed by the native issuer
});
```

Endpoints must be `https`. For tests against a loopback server, pass `allowInsecureLoopback: true`.
Native issuer identifiers are names, not endpoints, and are never fetched.

#### Service tokens

A service that calls another product authenticates as itself with a `client_credentials` token:

```ts
import { createServiceTokenProvider } from '@hivemagnus/hive-common/oathweave';

const tokens = createServiceTokenProvider({
  tokenUrl: process.env.OATHWEAVE_TOKEN_URL!,     // https only
  clientId: 'ardent-studio',
  clientSecret: process.env.OATHWEAVE_CLIENT_SECRET!,
  scope: 'hivemem:write',                         // optional
  audience: 'hivemem',                            // optional; one provider per audience
});

const response = await fetch(url, { headers: { authorization: `Bearer ${await tokens.token()}` } });
if (response.status === 401) tokens.invalidate(); // the next token() fetches a new one
```

`token()` fetches on first use and caches the token. It is replaced in the background at 80 % of
its lifetime (and at least 30 s before the end) while callers keep getting the cached one, is no
longer handed out 5 s before it expires, and concurrent callers share one request. The expiry is
`expires_in` (300 s when absent, bounded to 10 s-1 h) lowered to the token's own `exp` claim.
After a failed request no new one starts for 5 s. With `audience` set, an issued JWT whose `aud`
does not include it is refused. Each of these is an option (`refreshAfterMs`, `expiryMarginMs`,
`minLifetimeMs`, `maxLifetimeMs`, `defaultLifetimeSec`, `clampToTokenExpiry`, `failureBackoffMs`,
`serveStaleWhileRefreshing`, `verifyAudience`, `timeoutMs`, `maxResponseBytes`).

Failures are a `ServiceTokenError`: a `HiveError` with status 503, code `auth_unavailable` and a
`reason` (`backoff`, `http`, `network`, `timeout`, `malformed_response`, `expired_token`,
`audience_mismatch`). Its message never holds the client secret, a token or the token endpoint's
response.

### Conformance vectors

`test-vectors/oathweave/vectors.json` ships a test JWKS and fifteen pre-signed tokens (valid user,
valid service, expired, not yet valid, wrong audience, wrong issuer, bad signature, unknown `kid`,
`alg: none`, HS256 key confusion, overlong lifetime, user without session, valid native-issuer
service, unconfigured native issuer, overlong native-issuer service token), evaluated at a fixed
clock so they never expire. Run them against your product's verifier:

```ts
import { runOathweaveConformance } from '@hivemagnus/hive-common/oathweave/conformance';

it('meets the Oathweave conformance vectors', async () => {
  await runOathweaveConformance((token, ctx) => createProductVerifier({
    issuer: ctx.issuer, audience: ctx.audience, jwksUrl: ctx.jwksUrl, userinfoUrl: ctx.userinfoUrl,
    nativeIssuers: ctx.nativeIssuers, // native issuers the vectors use, for service tokens
    fetch: ctx.fetch,          // serves the vectors' JWKS and userinfo
    now: () => ctx.nowMs,      // the fixed clock
  })(token));
});
```

A verifier that does not accept native issuers fails `valid-native-service`; pass `only` to run
the other vectors until it does. It throws a readable error listing failed vectors. A refusal passes when the verifier rejects
(and any numeric `status` on the error matches); `strictReasons: true` also compares `reason`.

### errors

```ts
import { HiveError, toErrorResponse, parseHiveError, parseHiveErrorResponse } from '@hivemagnus/hive-common/errors';

throw new HiveError('quota_exceeded', 'Monthly quota reached', { status: 429, details: { limit: 1000 } });
throw HiveError.notFound('No such project');

const { status, body, headers } = toErrorResponse(error, { requestId, onUnexpected: e => log.error('unhandled', { err: e }) });

const error = await parseHiveErrorResponse(await fetch(url)); // any product, any legacy shape
if (HiveError.is(error, 'not_found')) { /* … */ }
```

`parseHiveError(status, body)` accepts text, bytes or parsed JSON and recognises every shape the
suite has used; `error.shape` says which. Remote codes are kept as sent (compare with
`HiveError.is()`, case-insensitively); messages are bounded and cleaned; HTML error pages are
replaced by the status's default message.

| Shape | Body | Products |
| --- | --- | --- |
| `envelope` | `{error:{code,message,requestId?,details?}}` | Hive standard, Ardent, ArdentStudio, Registry |
| `magnus` | `{success:false,error:{code,message}}` | Magnus |
| `oathweave` | `{error:"CODE",message}` | Oathweave |
| `string` | `{error:"human text"}` | Emberpath, HiveSkills, Cindertrace |
| `code` | `{error:"CODE"}` | Embermend, OAuth without description |
| `fastapi` / `fastapi-validation` | `{detail:"text"}` / `{detail:[{loc,msg,type}]}` | HiveMem |
| `mattermost` | `{id,message,status_code,request_id}` | ChatterMost |
| `oauth` | `{error,error_description}` | OAuth 2.0 endpoints |
| `message`, `text`, `empty`, `unknown` | `{message}`, plain text, no body, anything else | proxies and others |

### health

```ts
import { createHealth } from '@hivemagnus/hive-common/health';

const health = createHealth({
  service: 'hivemem', version: '1.4.0',
  timeoutMs: 2000,
  checks: [
    { name: 'database', check: () => db.ping() },
    { name: 'search', critical: false, check: signal => fetch(searchUrl, { signal }).then(r => r.ok) },
  ],
  aliases: true, // also serve /health, /healthz, /livez, /live, /api/health, /ready, /readyz
});
const response = await health.handle('/health/ready'); // { status: 200 | 503, body, headers } or undefined
```

A check is down when it throws, returns `false` or `{ ok: false }`, or exceeds its timeout (its
`signal` aborts). Error text is hidden unless `exposeErrors: true`. Serve legacy aliases only
while old clients still call them.

A product that has published its own liveness body can keep it with `liveBody`: an object served
as is, or a function that receives the standard body on every request. Status, headers and
readiness are unchanged, and liveness still never runs checks. `liveness()`, `createHealth()`,
`registerHealthRoutes()` and `hiveHandler({ health })` all take it.

```ts
createHealth({ service: 'studio', liveBody: { status: 'ok' } });
createHealth({ service: 'hive-skills', liveBody: standard => ({ status: 'ok', service: standard.service, protocol: 1 }) });
```

`readyCacheMs` bounds how often readiness probes the dependencies, which matters when the
endpoint is reachable without authentication: `0` makes requests that arrive during a run share
it, and a positive number also serves the finished result for that many milliseconds. Unset (the
default), every request runs every check.

### context

```ts
import { createRequestContext, runWithRequestContext, getRequestContext, outboundHeaders, readIdempotencyKey } from '@hivemagnus/hive-common/context';

const context = createRequestContext(req.headers);          // { requestId, trace, parentTrace, tracestate, … }
await runWithRequestContext(context, () => handle(req));
// anywhere below:
await fetch(peerUrl, { headers: { ...outboundHeaders(), authorization } });
const key = readIdempotencyKey(req.headers);                // string | undefined; 400 on malformed or conflicting
```

Also `parseTraceparent()`, `formatTraceparent()`, `generateTraceparent()`, `childTraceparent()`,
`readRequestId()`, `requireIdempotencyKey()` (428 when missing). On an edge service exposed to the
internet, pass `trustInbound: false` so callers cannot choose IDs.

`trustInboundRequestId` and `trustInboundTrace` decide the request ID and the trace separately; each
defaults to `trustInbound` (itself `true`). An internet-facing service that should still join its
callers' traces passes `{ trustInboundRequestId: false, trustInboundTrace: true }`. The `/hono`
`requestContext()` middleware and the `/node-http` `hiveHandler()` and `requestContextFor()` take
the same options.

### registry

```ts
import { createRegistryClient } from '@hivemagnus/hive-common/registry';

const registry = createRegistryClient({
  baseUrl: 'https://hive.example.com/api/registry', // or the native private-network URL with allowHttp
  token: process.env.HIVE_REGISTRY_READ_TOKEN,       // omit for the public view
  ca: process.env.HIVE_REGISTRY_CA_PEM,              // optional private CA; or pass fetch
  trust: { emberpath: { ca: emberpathCaPem } },      // TLS trust per product, from local config
});
const installation = await registry.installation();
const installed = await registry.installedProducts();
const endpoint = await registry.endpoint('emberpath'); // { url, internal, trust } or undefined
```

`product()` and `connection()` return `undefined` for unknown products. An error response is a
`HiveError` parsed from the registry's envelope, a success body that is not the documented shape is
a 502 `invalid_registry_response`, and a network failure or timeout rejects with the transport's
own error. The registry stores no TLS material, so
`endpoint()` returns the trust you configure. `createCaFetch({ ca })` is a small `node:https`
fetch that trusts only the given CA.

### log

```ts
import { createLogger, redact } from '@hivemagnus/hive-common/log';

const log = createLogger({ bindings: { service: 'hivemem' } }); // level from LOG_LEVEL, default info
log.info('memory stored', { memoryId, bytes });                 // adds requestId and traceId from the context
const jobLog = log.child({ job: 'reindex' });
log.error('upstream failed', { err, headers: req.headers });    // authorization and cookies masked
```

`redact()` masks values under secret-looking keys (authorization, cookie, password, secret, token,
`*key`, credentials, webhook URLs, session IDs) and scrubs strings everywhere: bearer and basic
credentials, JWTs, provider token formats, private keys, URL credentials and secret query
parameters. Numbers and booleans under such keys are kept, so `inputTokens: 512` survives.

A key is masked when its name contains a secret-looking word, which also catches identifiers such
as `authorizationId`. List those in `allowKeys` (`redact(value, { allowKeys: ['authorizationId'] })`,
or `redactAllowKeys` on the logger): they are no longer masked for their name, while their values
are still scrubbed like any other string.

### events

```ts
import { ChatterMostNotifier, parseFeedQuery, feedPage, encodeCursor } from '@hivemagnus/hive-common/events';

// GET /v1/hive/events?after=<cursor>&limit=<n>
const { after, limit } = parseFeedQuery(url.searchParams);       // limit 1-200, default 50
const rows = store.eventsAfter(after, limit + 1);
return Response.json(feedPage(rows.map(toHiveEvent), limit, event => encodeCursor({ id: event.id })));

const notifier = new ChatterMostNotifier({
  webhookUrl: process.env.CHATTERMOST_WEBHOOK_URL!, // a secret; never logged
  linkBaseUrl: 'https://hive.example.com',
});
await notifier.notify(event); // { status: 'sent' | 'duplicate' | 'failed', attempts }
```

The notifier validates the event, posts a Mattermost incoming-webhook payload (Markdown and
mentions in event text are neutralised), times out each attempt, retries 408, 429 (honouring
`Retry-After`), 5xx and network errors with exponential backoff and jitter, and delivers each
event ID once per 24 h. Pass a shared `DedupeStore` to deduplicate across replicas.

Feeds are ordered oldest first by `(occurredAt, id)`, and a cursor is that position:

```ts
import { buildFeedPage, feedSince, parseFeedQuery } from '@hivemagnus/hive-common/events';

const { after, limit } = parseFeedQuery(url.searchParams);
const window = { after, retentionMs: 14 * 86_400_000 };
const records = store.recordsSince(feedSince(window));          // ISO time: retention start or the cursor's
return Response.json(buildFeedPage(records.map(toHiveEvent), {  // toHiveEvent may return null
  ...window, limit, onDropped: count => log.warn('invalid events dropped', { count }),
}));
```

`buildFeedPage()` validates every candidate strictly (an invalid one is dropped and reported,
never served), keeps those inside the retention window and strictly after the cursor, sorts them
and cuts at `limit`. `encodeFeedPosition()`, `decodeFeedPosition()` (undefined for a bad cursor)
and `requireFeedPosition()` (a 400 `invalid_cursor`) are the cursor on their own;
`compareFeedPositions()` and `isAfterFeedPosition()` are the order, also in `/contracts`.

### feed

The consumer side, usable in a browser:

```ts
import { readHiveEventFeed, HiveEventFeedError } from '@hivemagnus/hive-common/feed';

const progress = { events: [], cursor: lastCursor, dropped: 0 };
try {
  const { caughtUp } = await readHiveEventFeed(fetch, '/api/hiveskills/v1/hive/events', {
    progress, product: 'hiveskills', signal: AbortSignal.timeout(10_000),
  });
} catch (error) {
  if (error instanceof HiveEventFeedError) report(error.kind, error.status); // progress keeps earlier pages
}
```

It asks for `?after=<cursor>&limit=200` page by page until `nextCursor` is null or `maxPages`
(10) pages were read. Each event is validated on its own, so one bad event is dropped and
counted, not the page; with `product` set, an event that claims another product is dropped too.
`kind` is `aborted`, `network`, `status` or `malformed`. `maxPageBytes` bounds a page.

### fetch

```ts
import { boundedFetch, fetchJson, readBodyBounded } from '@hivemagnus/hive-common/fetch';
import { outboundHeaders } from '@hivemagnus/hive-common/context';

const { data } = await fetchJson(`${base}/v1/things`, { headers: { authorization: `Bearer ${token}` }, signal }, {
  timeoutMs: 10_000,            // request and body together; 15 s by default
  maxResponseBytes: 1_048_576,  // 1 MiB by default
  contextHeaders: outboundHeaders, // forwards x-request-id, traceparent and tracestate
});
```

`boundedFetch()` returns `{ response, body }` with the body already read, for any status. It
combines its deadline with the caller's `signal`, defaults to `redirect: 'error'`, and never
buffers more than `maxResponseBytes`: a larger `content-length` is refused before reading, and a
body without one as soon as it passes the limit. `fetchJson()` adds `accept: application/json`,
parses the body and throws the peer's error as a `HiveError` (through `parseHiveError()`), unless
`throwOnHttpError` is false. `readBodyBounded()`, `readTextBounded()` and `readJsonBounded()` do
the bounded read for a response obtained elsewhere.

Failures are a `BoundedFetchError` with a `reason`: `timeout`, `network`, `response_too_large`,
`empty_response`, `invalid_json`. Its message never holds the URL, which may be a secret; the
original error is on `cause`. The caller's own abort is rethrown unchanged.

### secrets

For the static service credentials and webhook secrets a product still holds (Oathweave tokens go
through the verifier):

```ts
import { bearerMatchesSha256Digest, timingSafeEqualString } from '@hivemagnus/hive-common/secrets';

if (!bearerMatchesSha256Digest(req.headers.authorization, process.env.EXPORT_TOKEN_SHA256)) throw HiveError.unauthorized();
```

`timingSafeEqualString(a, b)` compares in constant time. `matchesSha256Digest(token, digest)`
checks a presented token against a stored lowercase-hex SHA-256 digest; an unset digest or an
empty token never matches, so a missing setting cannot open a route. `readBearerToken(header)`
returns the token of an `Authorization: Bearer` header or undefined, without throwing
(`allowBare` also accepts a header that is only the token). `sha256Hex()` is the digest itself.

### contracts

```ts
import { validateHiveEvent, type HiveEvent, type Page, type ErrorEnvelope } from '@hivemagnus/hive-common/contracts';

const result = validateHiveEvent(json);           // { ok: true, value } | { ok: false, issues }
```

HiveEvent v1:

```ts
interface HiveEvent {
  id: string; product: string; type: string; severity: 'info' | 'warning' | 'critical';
  title: string; summary: string; occurredAt: string; // RFC 3339 UTC
  subject?: { actorId?: string; agentRef?: string; nodeId?: string };
  link: { product: string; path: string };            // same-origin console path
  sourceRef?: string;
}
```

Also `Page<T>` (`{ data, nextCursor }`), `AgentIdentity` (`{ agentRef: "<nodeId>~<profile>",
actorId }`, segments `[a-z0-9_-]{2,32}`), `ErrorEnvelope`, `HIVE_HEADERS`. Validators drop unknown
fields by default; producers should pass `{ strict: true }`. The validators are hand-written so
the browser bundle gains no dependency.

Request IDs work here without `/context` (which needs Node): `generateRequestId()` (a UUID, or
random hex in a page outside a secure context, where `crypto.randomUUID` is missing),
`readRequestId(response.headers)`, `resolveRequestId()` and `isValidRequestId()`.
`retryAfterMs(header)` reads a `Retry-After` header (delta-seconds or an HTTP date) as
milliseconds, undefined when absent or unreadable; options add a clock, decimal seconds, a
fallback and bounds.

### hono

```ts
import { Hono } from 'hono';
import { requestContext, oathweaveAuth, requirePermission, errorHandler, notFoundHandler, registerHealthRoutes, requirePrincipal, type HiveEnv } from '@hivemagnus/hive-common/hono';

const app = new Hono<HiveEnv>();
app.use(requestContext());
registerHealthRoutes(app, { checks, aliases: true });
app.use('/v1/*', oathweaveAuth(verifier, { authorize: principal => { requireIdentityLink(links, principal); } }));
app.get('/v1/memories', requirePermission(['hivemem:read']), c => c.json(list(requirePrincipal(c))));
app.onError(errorHandler({ logger: log }));
app.notFound(notFoundHandler());
```

The health routes, `errorHandler()` and `notFoundHandler()` respond through Hono's context, so
headers set earlier in the request with `c.header()` (a trace or request ID, for example) stay on
the response.

`readJsonBody(c, { maxBytes })` reads and parses a JSON body within a size limit (1 MiB by
default) and returns `{ value, text, bytes }`. The limit is enforced while the body streams, so
it holds without a `content-length`. It throws a `HiveError`: 413 `too_large`, 415
`unsupported_media_type` (when there is a body that is not `application/json`;
`requireContentType: 'always' | 'never'` changes that), 400 `invalid_json` for a body that does
not parse or is empty (unless `emptyValue` is set). `errorFor` substitutes a product's own
errors. `readBody()` gives the bytes. Both also take a fetch `Request`.

`securityHeaders()` sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
`X-Frame-Options: DENY` on every response; change or omit each, add more with `headers` (a
`Content-Security-Policy`, say), and set `apply: 'after'` to override what a handler set.

Requires `hono` 4.13.18 or later, the suite minimum since a recent Hono security advisory.

### node-http

```ts
import http from 'node:http';
import { hiveHandler, authenticate, sendJson } from '@hivemagnus/hive-common/node-http';

http.createServer(hiveHandler(async (req, res) => {
  const principal = await authenticate(req, verifier);
  sendJson(res, 200, { subject: principal.subject });
}, { health: { checks }, logger: log })).listen(8080);
```

`hiveHandler()` adds the request context, health routes and the error envelope; anything thrown
becomes an envelope, and a handler that sends nothing gets a 404.

`readJsonBody(req, { maxBytes })` and `readBody()` are the same bounded readers as in `/hono`,
with the same options and errors. An oversized upload is answered and then drained: the 413 is
thrown as soon as the limit is passed, so the client gets the response while it is still
sending, and the rest of the upload is discarded for up to `lingerMs` (5 s) before the
connection is closed. Without that, a client blocked on its write sees a reset instead of the
413. `drainRequest(req)` does the same after any refusal sent without reading the body.

## Adopting HiveCommon in a product

1. **Install** `@hivemagnus/hive-common` (and `hono` ≥ 4.13.18 for Hono products).
2. **Replace the verifier copy.** Delete `oathweave.ts` / `oathweave-verifier.ts` and build the
   verifier with `createOathweaveVerifier()` from the same `OATHWEAVE_*` settings. Use
   `accept: 'service'` (or `'any'`) on routes that took the separate service verifier. Map
   principals through `parseIdentityLinks()` / `requireIdentityLink()`.
3. **Add the conformance test** with `runOathweaveConformance()` and keep the old verifier tests
   that cover product-specific rules.
4. **Adopt the envelope.** Throw `HiveError`s and install `errorHandler()` / `hiveHandler()`.
   Keep the old body shape only for clients that still parse it, and plan its removal.
   Clients (including HiveXUI) parse peers with `parseHiveError()`.
5. **Adopt request context.** Install `requestContext()`, log with `createLogger()`, and pass
   `outboundHeaders()` on calls to peers.
6. **Serve `/health/live` and `/health/ready`**, with `aliases` for paths current deployments probe.
7. **Publish HiveEvents** at `GET /v1/hive/events` with `feedPage()`, and announce through
   `ChatterMostNotifier` where the product posts to ChatterMost today.

Behaviour that changes when a product adopts the shared verifier:

- Clock tolerance is 30 s (the copies used 0).
- An unreachable JWKS or userinfo is a 503 `auth_unavailable`, not a 401, so clients retry
  instead of signing people out. Access is still refused.
- A missing `roles` claim means no roles instead of a refusal (ArdentStudio already allowed it).
- `authTime` is epoch seconds, `undefined` when absent or invalid (Magnus semantics; some copies
  exposed `authenticatedAt` in milliseconds).
- Duplicate identity links fail at startup by default (`duplicates: 'ignore'` keeps the old
  Magnus behaviour of granting nothing to that identity).

## Choosing settings for an existing product

The defaults suit a new service. A product moving from its own code to HiveCommon can keep its
existing behaviour with these settings instead of wrapping the shared helpers:

| Setting | Default | Set it to keep |
| --- | --- | --- |
| `clockToleranceSec: 0` (verifier) | 30 | no clock skew allowance on `exp`, `nbf` and `iat` |
| `sessionCacheTtlMs: 0` (verifier) | 10 000 | an online session check on every request, so sign-out is immediate |
| `requireRoles: true` (verifier) | `false` | refusing tokens without a `roles` array |
| `clientIdClaim: 'clientId'` (verifier) | `'either'` | requiring the Oathweave `clientId` claim; RFC 9068 `client_id` alone is refused |
| `nativeIssuers: ['hive-iam']` (verifier) | none | accepting client-credentials tokens signed with Oathweave's native issuer, which a local jose check used to handle |
| `maxLifetimeSec: { user, service }` (verifier) | 900 for both | a different limit per principal kind, for example `{ user: 900, service: 300 }` |
| `trustInboundRequestId: false` with `trustInboundTrace: true` (context, `/hono`, `/node-http`) | both `trustInbound` | generating every request ID on an internet-facing service while continuing callers' traces |
| `liveBody` (health, `/hono`, `/node-http`) | the standard body | a published `/health/live` body such as `{ status: 'ok' }` |
| `localId` in identity links | `localUserId` | existing link configs, unchanged |
| `duplicates: 'ignore'` (identity links) | `'reject'` | granting nothing to a duplicated identity instead of failing at startup |
| `localUserIdPattern` (identity links) | `LOCAL_USER_ID_PATTERN` | account labels outside the default characters, such as `alice+ops@example.com` |
| `nativeIssuers` (identity links) | none | service links keyed by Oathweave's native issuer |

```ts
const verifier = createOathweaveVerifier({
  issuer, audience: 'chattermost', jwksUrl, userinfoUrl,
  clockToleranceSec: 0, sessionCacheTtlMs: 0, requireRoles: true, clientIdClaim: 'clientId',
});
app.use(requestContext({ trustInboundRequestId: false, trustInboundTrace: true }));
registerHealthRoutes(app, { service: 'chattermost', liveBody: { status: 'ok' } });
```

Every refusal, including 503 `auth_unavailable`, is still an `OathweaveError`; a product that
answers 401 for all of them maps the error in its own handler.

Service tokens from a native issuer. Products that kept a local jose verifier for Oathweave's
native issuer replace it with a second shared verifier on the same key source, so one JWKS cache
serves both:

```ts
const keys = createRemoteJWKSet(new URL(jwksUrl)); // or let each verifier fetch jwksUrl itself
const users = createOathweaveVerifier({ issuer, audience: 'hivemem', keys, userinfoUrl, /* user settings */ });
const services = createOathweaveVerifier({
  issuer,                                   // https; browser-issued machine clients use it
  nativeIssuers: ['hive-iam'],              // Oathweave's JWT_ISSUER, from configuration
  audience: 'hivemem', keys, accept: 'service',
  clientIdClaim: 'clientId',                // Oathweave service tokens always carry clientId
});
```

The fifteen-minute limit applies to service tokens as before (`maxLifetimeSec` sets it per kind).
Native identifiers are exact: configure the value Oathweave's `JWT_ISSUER` is set to, and keep the
service links that grant access keyed by that issuer.

## Development

```bash
npm ci
npm run hooks:install
npm run verify        # privacy tests, scans, typecheck, lint, tests, build, package check
npm run test:coverage
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Security reports:
[SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
