/**
 * Client addresses behind trusted proxies, a keyed token-bucket rate limiter and a shared Redis
 * sliding-window store (`createRedisSlidingWindowStore()`, structural: no Redis dependency).
 *
 * Framework-free and Node only (`node:net`). `/hono` `rateLimit()` and `/node-http`
 * `rateLimit()` apply it to requests and answer a refusal with a 429 envelope and `Retry-After`.
 *
 *   const proxies = trustedProxies(process.env.TRUSTED_PROXIES); // '10.0.0.0/8, loopback'
 *   const client = resolveClientAddress({ peer: socket.remoteAddress, forwardedFor: req.headers['x-forwarded-for'], trusted: proxies });
 *   const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
 *   const result = limiter.consume(`login:${addressKey(client.address)}`);
 */
import { BlockList, isIP } from 'node:net';
import { HiveError } from '../errors/index.js';

// ---------------------------------------------------------------------------------------
// Addresses

/** A plain IP address from a socket or header value, or undefined when it is not one. */
export function normalizeIpAddress(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  let text = value.trim();
  if (!text || text.length > 64) return undefined;
  // `[2001:db8::1]` and `[2001:db8::1]:443`, as some proxies write them.
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  if (bracketed) text = bracketed[1] as string;
  // `203.0.113.7:51234`: an IPv4 address with a port.
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(text)) text = text.slice(0, text.lastIndexOf(':'));
  // A zone index (`fe80::1%eth0`) does not identify a client; drop it.
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const lower = text.toLowerCase();
  const family = isIP(lower);
  if (family === 4) return lower;
  if (family !== 6) return undefined;
  const groups = expandIpv6(lower);
  // An IPv4-mapped address (`::ffff:192.0.2.1`) is that IPv4 client.
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    const [high, low] = [groups[6] as number, groups[7] as number];
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return formatIpv6(groups);
}

/** RFC 5952 text for eight groups: lowercase, no leading zeros, the longest zero run (of two or more) as `::`. */
function formatIpv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 1;
  for (let index = 0; index < 8;) {
    if (groups[index] !== 0) { index++; continue; }
    let end = index;
    while (end < 8 && groups[end] === 0) end++;
    if (end - index > bestLength) { bestStart = index; bestLength = end - index; }
    index = end;
  }
  const hex = groups.map(group => group.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

/** The eight 16-bit groups of a valid IPv6 address (one that `isIP()` accepts). */
function expandIpv6(address: string): number[] {
  let text = address;
  const groups: number[] = [];
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  for (const part of left) groups.push(parseInt(part, 16));
  for (let index = 0; index < (tail === undefined ? 0 : missing); index++) groups.push(0);
  for (const part of right) groups.push(parseInt(part, 16));
  return groups;
}

export interface AddressKeyOptions {
  /**
   * IPv6 clients are grouped by this prefix, because one host usually holds a whole /64 and
   * could otherwise get a fresh bucket per address. 64 by default; 128 keys every address.
   */
  readonly ipv6PrefixLength?: number;
}

/**
 * The rate-limit key for a client address: the address itself for IPv4, its network prefix for
 * IPv6 (`2001:db8:1:2::/64`). Anything that is not an IP address is returned trimmed, so a
 * placeholder such as `unknown` still forms one key.
 */
export function addressKey(address: string, options: AddressKeyOptions = {}): string {
  const prefix = options.ipv6PrefixLength ?? 64;
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > 128) throw new RangeError('ipv6PrefixLength must be an integer from 1 to 128');
  const normalized = normalizeIpAddress(address);
  if (!normalized) return address.trim();
  if (isIP(normalized) !== 6) return normalized;
  if (prefix === 128) return normalized;
  const groups = expandIpv6(normalized).map((group, index) => {
    const bits = Math.max(0, Math.min(16, prefix - index * 16));
    return bits === 0 ? 0 : group & (0xffff << (16 - bits)) & 0xffff;
  });
  return `${formatIpv6(groups)}/${prefix}`;
}

/** Named address ranges accepted by `trustedProxies()`. */
export const TRUSTED_PROXY_PRESETS: Readonly<Record<string, readonly string[]>> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  /** RFC 1918 and IPv6 unique-local: a Compose or cluster network. */
  private: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
};

/** The set of proxies whose `X-Forwarded-For` is believed. */
export interface TrustedProxies {
  has(address: string): boolean;
  /** The configured entries, normalised, for logging the configuration. */
  readonly entries: readonly string[];
}

/** `10.*.*.*`: four dot-separated parts, each `*` or a decimal octet without leading zeros. */
const IPV4_WILDCARD = /^(?:\*|25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:\*|25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Parse a trusted-proxy list: IP addresses, CIDR ranges, IPv4 wildcards (`10.*.*.*`,
 * `192.0.2.*`, `10.*.0.1`) and the presets `loopback`, `private` and `linklocal`, as an array or
 * one comma- or space-separated string (an environment variable). Empty or undefined trusts no
 * proxy, so `X-Forwarded-For` is never read. Throws a TypeError naming the first entry that is
 * not valid.
 *
 * A wildcard has four parts, each `*` (any octet) or one octet that must match exactly; it
 * matches IPv4 addresses only (an IPv4-mapped IPv6 address counts as its IPv4 address), never an
 * IPv6 one. Host names are not accepted.
 */
export function trustedProxies(config: string | readonly string[] | undefined | null): TrustedProxies {
  const raw = typeof config === 'string' ? config.split(/[\s,]+/) : [...(config ?? [])];
  const list = new BlockList();
  const entries: string[] = [];
  const wildcards: Array<readonly string[]> = [];
  const add = (entry: string): void => {
    if (entry.includes('*')) {
      if (!IPV4_WILDCARD.test(entry)) throw new TypeError(`Not a trusted proxy address or range: ${entry}`);
      wildcards.push(entry.split('.'));
      entries.push(entry);
      return;
    }
    const [addressPart, prefixPart, ...extra] = entry.split('/');
    const address = normalizeIpAddress(addressPart);
    if (!address || extra.length || addressPart !== addressPart?.trim() || (prefixPart !== undefined && !/^\d{1,3}$/.test(prefixPart))) {
      throw new TypeError(`Not a trusted proxy address or range: ${entry}`);
    }
    const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
    const max = family === 'ipv4' ? 32 : 128;
    const prefix = prefixPart === undefined ? max : Number(prefixPart);
    if (prefix > max) throw new TypeError(`Not a trusted proxy address or range: ${entry}`);
    list.addSubnet(address, prefix, family);
    entries.push(`${address}/${prefix}`);
  };
  for (const item of raw) {
    if (typeof item !== 'string') throw new TypeError('Trusted proxies must be strings');
    const entry = item.trim();
    if (!entry) continue;
    const preset = TRUSTED_PROXY_PRESETS[entry.toLowerCase()];
    if (preset && Object.hasOwn(TRUSTED_PROXY_PRESETS, entry.toLowerCase())) preset.forEach(add);
    else add(entry);
  }
  return {
    has(address) {
      const normalized = normalizeIpAddress(address);
      if (normalized === undefined) return false;
      if (isIP(normalized) !== 4) return list.check(normalized, 'ipv6');
      if (list.check(normalized, 'ipv4')) return true;
      if (!wildcards.length) return false;
      const octets = normalized.split('.');
      return wildcards.some(parts => parts.every((part, index) => part === '*' || part === octets[index]));
    },
    entries,
  };
}

/** The longest `X-Forwarded-For` chain read, from the right. */
export const DEFAULT_MAX_FORWARDED_HOPS = 32;

/**
 * How the client address was decided:
 * - `direct`: the peer is not a trusted proxy, so it is the client (any `X-Forwarded-For` is ignored);
 * - `forwarded`: read from `X-Forwarded-For`, past every trusted hop;
 * - `proxy_without_forwarding`: a trusted proxy sent no `X-Forwarded-For`; the proxy is the client;
 * - `invalid_forwarding`: a trusted hop reported something that is not an address (or too many
 *   trusted hops); the last trusted hop is the client. With `trustedHops`: one of the counted
 *   entries is not an address, or the chain has fewer entries than `trustedHops`; the peer is
 *   the client, and a product that refuses such requests (400) checks for this decision;
 * - `unknown_peer`: the socket address is not known; the client is `unknown`.
 */
export type ClientAddressDecision = 'direct' | 'forwarded' | 'proxy_without_forwarding' | 'invalid_forwarding' | 'unknown_peer';

export interface ClientAddress {
  /** The address requests are attributed to: an IP address, or `unknown`. */
  readonly address: string;
  /** The socket peer, normalised; undefined when it was not known. */
  readonly peer: string | undefined;
  readonly decision: ClientAddressDecision;
}

export interface ResolveClientAddressOptions {
  /** The socket's remote address (`req.socket.remoteAddress`). */
  readonly peer: string | null | undefined;
  /** The `X-Forwarded-For` header value(s), as received. */
  readonly forwardedFor?: string | readonly string[] | null | undefined;
  readonly trusted: TrustedProxies;
  /** The most hops read from the right of `X-Forwarded-For`. 32. */
  readonly maxHops?: number;
  /**
   * Count a fixed number of proxies instead of walking the trusted ranges: when the peer is a
   * trusted proxy, the client is the `trustedHops`-th entry of `X-Forwarded-For` from the right
   * (1: the rightmost, the address the peer received the request from). Only the peer must be
   * in `trusted`; the proxies in front of it are counted, not looked up. Only the rightmost
   * `trustedHops` entries are read: entries further left were written by the client and are
   * ignored, whatever they hold. A counted entry that is not an IP address, or a chain with
   * fewer than `trustedHops` entries, is `invalid_forwarding` (the peer is the address); a
   * trusted peer that sent no `X-Forwarded-For` is `proxy_without_forwarding` as without this
   * option. 0 never reads `X-Forwarded-For` (`direct`). An integer from 0 to `maxHops`; the
   * middlewares check it at setup.
   */
  readonly trustedHops?: number;
}

/**
 * The client address of a request. `X-Forwarded-For` is believed only when the socket peer is
 * a trusted proxy, and then read from the right: each trusted hop vouches for the one to its
 * left, and the first address that is not a trusted proxy is the client. Entries left of it were
 * written by the client and are never read, so a forged prefix changes nothing.
 */
export function resolveClientAddress(options: ResolveClientAddressOptions): ClientAddress {
  const maxHops = options.maxHops ?? DEFAULT_MAX_FORWARDED_HOPS;
  if (options.trustedHops !== undefined) checkTrustedHops(options.trustedHops, maxHops);
  const peer = normalizeIpAddress(options.peer);
  if (peer === undefined) return { address: 'unknown', peer: undefined, decision: 'unknown_peer' };
  if (!options.trusted.has(peer) || options.trustedHops === 0) return { address: peer, peer, decision: 'direct' };
  const header = typeof options.forwardedFor === 'string' ? options.forwardedFor : options.forwardedFor ? options.forwardedFor.join(',') : '';
  if (!header.trim()) return { address: peer, peer, decision: 'proxy_without_forwarding' };
  const hops = header.split(',');
  if (options.trustedHops !== undefined) return countedHops(peer, hops, options.trustedHops);
  let vouching = peer;
  for (let index = hops.length - 1, read = 0; index >= 0; index--, read++) {
    if (read >= maxHops) return { address: vouching, peer, decision: 'invalid_forwarding' };
    const hop = normalizeIpAddress(hops[index]);
    if (hop === undefined) return { address: vouching, peer, decision: 'invalid_forwarding' };
    if (!options.trusted.has(hop)) return { address: hop, peer, decision: 'forwarded' };
    vouching = hop;
  }
  // Every hop is a trusted proxy (an internal caller): the leftmost one is the client.
  return { address: vouching, peer, decision: 'forwarded' };
}

function checkTrustedHops(trustedHops: number, maxHops: number): void {
  if (typeof trustedHops !== 'number' || !Number.isInteger(trustedHops) || trustedHops < 0 || trustedHops > maxHops) {
    throw new RangeError(`trustedHops must be an integer from 0 to ${maxHops}`);
  }
}

/**
 * `trustedHops` mode: the client is the n-th entry from the right. Only the n counted entries are
 * read; everything left of them was written by the client and is ignored, so a client cannot
 * make its request fall back to the proxy's address by sending a malformed header.
 */
function countedHops(peer: string, hops: readonly string[], trustedHops: number): ClientAddress {
  if (hops.length < trustedHops) return { address: peer, peer, decision: 'invalid_forwarding' };
  let client: string | undefined;
  for (let index = hops.length - 1; index >= hops.length - trustedHops; index--) {
    client = normalizeIpAddress(hops[index]);
    if (client === undefined) return { address: peer, peer, decision: 'invalid_forwarding' };
  }
  return { address: client as string, peer, decision: 'forwarded' };
}

// ---------------------------------------------------------------------------------------
// Token bucket

export interface RateLimiterOptions {
  /** Tokens refilled per `windowMs`: the sustained rate. */
  readonly limit: number;
  readonly windowMs: number;
  /** The bucket size: how many requests may arrive at once. Defaults to `limit`. */
  readonly burst?: number;
  /**
   * The most keys held. When a new key would pass it, the least recently used key is dropped
   * (it starts again with a full bucket). 10 000.
   */
  readonly maxKeys?: number;
  /**
   * Called with the key dropped when a new key pushes the limiter past `maxKeys`, for a metric
   * (never log the raw key if it holds an account name). Not called by `reset()` or `clear()`.
   * An exception it throws is ignored.
   */
  readonly onEvict?: (key: string) => void;
  readonly now?: () => number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /** The bucket size. */
  readonly limit: number;
  /** Whole tokens left after this request. */
  readonly remaining: number;
  /** When refused, how long until the request would be allowed; 0 when allowed. */
  readonly retryAfterMs: number;
  /** How long until the bucket is full again. */
  readonly resetMs: number;
}

/** What the middlewares need: the in-memory limiter, or a shared (for example Redis) one. */
export interface RateLimitStore {
  consume(key: string, cost?: number): RateLimitResult | Promise<RateLimitResult>;
}

export interface RateLimiter extends RateLimitStore {
  consume(key: string, cost?: number): RateLimitResult;
  /** The state of a key without spending anything. */
  peek(key: string): RateLimitResult;
  /** Forget one key, for example after a successful sign-in. */
  reset(key: string): void;
  clear(): void;
  /** Keys currently held. */
  readonly size: number;
  /** Keys dropped so far to stay within `maxKeys` (see `onEvict`). */
  readonly evictions: number;
}

export const DEFAULT_RATE_LIMIT_MAX_KEYS = 10_000;

function positive(name: string, value: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${name} must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return value;
}

/**
 * A keyed, in-memory token bucket: each key holds up to `burst` tokens, refilled continuously
 * at `limit` per `windowMs`, and every request spends `cost` (1). State is per process; run a
 * shared store (`RateLimitStore`) when several instances must share a budget.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const limit = positive('limit', options.limit);
  const windowMs = positive('windowMs', options.windowMs);
  const burst = positive('burst', options.burst ?? limit);
  const maxKeys = positive('maxKeys', options.maxKeys ?? DEFAULT_RATE_LIMIT_MAX_KEYS, true);
  const now = options.now ?? (() => Date.now());
  const ratePerMs = limit / windowMs;
  const buckets = new Map<string, { tokens: number; at: number }>();
  const onEvict = options.onEvict;
  let evictions = 0;

  const refilled = (key: string, time: number): number => {
    const bucket = buckets.get(key);
    if (!bucket) return burst;
    return Math.min(burst, bucket.tokens + Math.max(0, time - bucket.at) * ratePerMs);
  };
  const result = (allowed: boolean, tokens: number, retryAfterMs: number): RateLimitResult => ({
    allowed,
    limit: burst,
    remaining: Math.max(0, Math.floor(tokens + 1e-9)),
    retryAfterMs,
    resetMs: Math.ceil((burst - tokens) / ratePerMs),
  });

  return {
    consume(key, cost = 1) {
      if (typeof key !== 'string') throw new TypeError('A rate-limit key must be a string');
      positive('cost', cost);
      if (cost > burst) throw new RangeError('cost must not exceed burst');
      const time = now();
      const tokens = refilled(key, time);
      if (tokens + 1e-9 < cost) {
        // Refused requests spend nothing, so a client that keeps retrying is not locked out
        // longer. They still count as use: a key being refused is the last one to be dropped.
        const bucket = buckets.get(key);
        if (bucket) { buckets.delete(key); buckets.set(key, bucket); }
        return result(false, tokens, Math.ceil((cost - tokens) / ratePerMs));
      }
      const left = tokens - cost;
      buckets.delete(key);
      if (buckets.size >= maxKeys) {
        const evicted = buckets.keys().next().value as string;
        buckets.delete(evicted);
        evictions++;
        try { onEvict?.(evicted); } catch { /* a metrics callback never changes the answer */ }
      }
      buckets.set(key, { tokens: left, at: time });
      return result(true, left, 0);
    },
    peek(key) {
      return result(true, refilled(key, now()), 0);
    },
    reset(key) { buckets.delete(key); },
    clear() { buckets.clear(); },
    get size() { return buckets.size; },
    get evictions() { return evictions; },
  };
}

// ---------------------------------------------------------------------------------------
// Responses

/**
 * The 429 for a refused request: a `HiveError` with code `rate_limited`, `Retry-After` in whole
 * seconds (at least 1) and `details.retryAfterSeconds` in the envelope.
 */
export function rateLimitError(result: RateLimitResult, options: { readonly headers?: boolean } = {}): HiveError {
  const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  return new HiveError('rate_limited', 'Too many requests', {
    status: 429,
    headers: { ...(options.headers ? rateLimitHeaders(result) : {}), 'retry-after': String(seconds) },
    details: { retryAfterSeconds: seconds },
  });
}

/** `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds) for a result. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'ratelimit-limit': String(result.limit),
    'ratelimit-remaining': String(result.remaining),
    'ratelimit-reset': String(Math.max(0, Math.ceil(result.resetMs / 1000))),
  };
}

/** Options shared by the `/hono` and `/node-http` middlewares. */
export interface RateLimitMiddlewareOptions {
  /** The limiter (or shared store) to spend from. */
  readonly limiter: RateLimitStore;
  /** Proxies whose `X-Forwarded-For` is believed. None by default: the socket peer is the client. */
  readonly trustedProxies?: TrustedProxies | string | readonly string[];
  /** A fixed prefix for every key, so one limiter can serve several rules (`login:`). */
  readonly prefix?: string;
  /** Grouping of IPv6 clients for the default key (see `addressKey()`). */
  readonly ipv6PrefixLength?: number;
  /** Count this many proxies from the right of `X-Forwarded-For` (see `resolveClientAddress()`). */
  readonly trustedHops?: number;
  /** Send `RateLimit-*` headers on allowed and refused responses. Off by default. */
  readonly headers?: boolean;
  /** Called for every refusal, for metrics or a log line (never log the raw key if it holds an account name). */
  readonly onLimited?: (event: { readonly key: string; readonly client: ClientAddress; readonly result: RateLimitResult }) => void;
}

/** Resolve the `trustedProxies` option once, at setup. */
export function resolveTrustedProxies(value: RateLimitMiddlewareOptions['trustedProxies']): TrustedProxies {
  if (value && typeof value === 'object' && 'has' in value && typeof value.has === 'function') return value;
  return trustedProxies(value as string | readonly string[] | undefined);
}

/**
 * Spend from the limiter for a key and throw the 429 when refused. Used by the middlewares;
 * call it directly for budgets that are not per request (per account, per action).
 */
export async function enforceRateLimit(store: RateLimitStore, key: string, cost?: number, options: { readonly headers?: boolean } = {}): Promise<RateLimitResult> {
  const result = await store.consume(key, cost);
  if (!result.allowed) throw rateLimitError(result, options);
  return result;
}

/** A refused request, for a product that answers it in its own shape (the middlewares' `respond`). */
export interface RateLimitRefusal {
  /** The full key that was spent from (with `prefix`). */
  readonly key: string;
  readonly client: ClientAddress;
  readonly result: RateLimitResult;
  /** `Retry-After` in whole seconds, at least 1. */
  readonly retryAfterSeconds: number;
  /** The headers of the default 429: `retry-after`, and the `ratelimit-*` ones when `headers` is on. */
  readonly headers: Readonly<Record<string, string>>;
  /** The default 429 `HiveError` (`rate_limited`), as `limitRequest()` throws it. */
  readonly error: HiveError;
}

/** `RateLimitMiddlewareOptions` without the limiter, which `spendRequestLimit()` takes on its own. */
export type RateLimitRequestOptions = Omit<RateLimitMiddlewareOptions, 'limiter'>;

/** What `spendRequestLimit()` decided. `result` is undefined when the request was not limited. */
export interface RequestLimitOutcome {
  readonly client: ClientAddress;
  readonly result: RateLimitResult | undefined;
  /** Set when the request was refused. */
  readonly refusal?: RateLimitRefusal;
}

/**
 * The shared request step, without throwing: resolve the client, build the key and spend from
 * `store`. A refusal is returned (after `onLimited`) for the caller to answer. Nothing is spent
 * when `store` is undefined or `key` returns undefined. Exported for other adapters; most code
 * uses a middleware.
 */
export async function spendRequestLimit(
  store: RateLimitStore | undefined,
  options: RateLimitRequestOptions,
  trusted: TrustedProxies,
  request: { readonly peer: string | null | undefined; readonly forwardedFor: string | readonly string[] | null | undefined },
  key: ((client: ClientAddress) => string | undefined | Promise<string | undefined>) | undefined,
  cost: number | undefined,
): Promise<RequestLimitOutcome> {
  const client = resolveClientAddress({
    peer: request.peer, forwardedFor: request.forwardedFor, trusted,
    ...(options.trustedHops === undefined ? {} : { trustedHops: options.trustedHops }),
  });
  if (!store) return { client, result: undefined };
  const own = key ? await key(client) : addressKey(client.address, options.ipv6PrefixLength === undefined ? {} : { ipv6PrefixLength: options.ipv6PrefixLength });
  if (own === undefined) return { client, result: undefined };
  const fullKey = `${options.prefix ?? ''}${own}`;
  const result = await store.consume(fullKey, cost);
  if (result.allowed) return { client, result };
  options.onLimited?.({ key: fullKey, client, result });
  const error = rateLimitError(result, { headers: options.headers ?? false });
  const headers = { ...(error.headers ?? {}) } as Record<string, string>;
  const retryAfterSeconds = Number(headers['retry-after']);
  return { client, result, refusal: { key: fullKey, client, result, retryAfterSeconds, headers, error } };
}

/**
 * The shared request step of the `/hono` and `/node-http` middlewares: resolve the client, build
 * the key and spend. Undefined when `key` returned undefined (the request is not limited).
 * Exported for other adapters; most code uses a middleware.
 */
export async function limitRequest(
  options: RateLimitMiddlewareOptions,
  trusted: TrustedProxies,
  request: { readonly peer: string | null | undefined; readonly forwardedFor: string | readonly string[] | null | undefined },
  key: ((client: ClientAddress) => string | undefined | Promise<string | undefined>) | undefined,
  cost: number | undefined,
): Promise<{ readonly client: ClientAddress; readonly result: RateLimitResult | undefined }> {
  const { client, result, refusal } = await spendRequestLimit(options.limiter, options, trusted, request, key, cost);
  if (refusal) throw refusal.error;
  return { client, result };
}

export {
  createRedisSlidingWindowStore, RateLimitStoreError,
  type RedisSlidingWindowStoreOptions, type SlidingWindowPipeline, type SlidingWindowRedis,
} from './redis.js';
