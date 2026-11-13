/**
 * HiveEvent feeds and the ChatterMost notifier. The HiveEvent schema and validator live in
 * `/contracts` (isomorphic); this module re-exports them.
 */
import {
  compareFeedPositions,
  isAfterFeedPosition,
  isRfc3339Utc,
  validateHiveEvent,
  type FeedPosition,
  type HiveEvent,
  type HiveEventSeverity,
  type Page,
} from '../contracts/index.js';
import { HiveError } from '../errors/index.js';
import { endpointProblem } from '../oathweave/endpoint.js';
import { redactText } from '../log/redact.js';

export {
  compareFeedPositions,
  isAfterFeedPosition,
  type FeedPosition,
  HIVE_EVENT_LIMITS,
  HIVE_EVENT_SEVERITIES,
  HIVE_EVENT_VERSION,
  isHiveEvent,
  validateHiveEvent,
  validateHiveEventPage,
  type HiveEvent,
  type HiveEventSeverity,
  type Page,
} from '../contracts/index.js';

// ---------------------------------------------------------------------------------------
// Feed: GET /v1/hive/events?after=<cursor>&limit=<n>

export const HIVE_EVENTS_PATH = '/v1/hive/events';

export interface FeedQuery {
  /** Opaque cursor from a previous page's `nextCursor`; undefined for the first page. */
  readonly after: string | undefined;
  readonly limit: number;
}

export interface FeedQueryOptions {
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
}

/** Read `after` and `limit` from a query. Throws a 400 HiveError on malformed values. */
export function parseFeedQuery(
  query: URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>,
  options: FeedQueryOptions = {},
): FeedQuery {
  const read = (name: string): string | undefined => {
    if (query instanceof URLSearchParams) {
      const values = query.getAll(name);
      if (values.length > 1) throw new HiveError('invalid_query', `${name} must be given once`, { status: 400 });
      return values[0];
    }
    const value = query[name];
    if (Array.isArray(value)) {
      if (value.length > 1) throw new HiveError('invalid_query', `${name} must be given once`, { status: 400 });
      return value[0] as string | undefined;
    }
    return value as string | undefined;
  };
  const maxLimit = options.maxLimit ?? 200;
  const defaultLimit = Math.min(options.defaultLimit ?? 50, maxLimit);
  const rawLimit = read('limit');
  let limit = defaultLimit;
  if (rawLimit !== undefined && rawLimit !== '') {
    if (!/^\d{1,6}$/.test(rawLimit) || Number(rawLimit) < 1) {
      throw new HiveError('invalid_query', `limit must be an integer from 1 to ${maxLimit}`, { status: 400 });
    }
    limit = Math.min(Number(rawLimit), maxLimit);
  }
  const after = read('after');
  if (after !== undefined && after !== '' && !/^[A-Za-z0-9._~:-]{1,512}$/.test(after)) {
    throw new HiveError('invalid_query', 'after must be a cursor from a previous page', { status: 400 });
  }
  return { after: after || undefined, limit };
}

/**
 * Build a feed page. Pass up to `limit + 1` items read after the cursor, in feed order; the
 * extra item only tells whether there is a next page and is not returned.
 */
export function feedPage<T>(items: readonly T[], limit: number, cursorOf: (item: T) => string): Page<T> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
  const data = items.slice(0, limit);
  const last = data.at(-1);
  return { data, nextCursor: items.length > limit && last !== undefined ? cursorOf(last) : null };
}

/** Encode a cursor position as an opaque base64url string. Isomorphic. */
export function encodeCursor(position: Readonly<Record<string, string | number>>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(position));
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a cursor from `encodeCursor()`. Throws a 400 HiveError when it was tampered with. */
export function decodeCursor(cursor: string): Record<string, string | number> {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('not base64url');
    const binary = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const value: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Object.values(value).every(item => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)))) throw new Error('not a position');
    return value as Record<string, string | number>;
  } catch {
    throw new HiveError('invalid_cursor', 'The cursor is not valid', { status: 400 });
  }
}

// ---------------------------------------------------------------------------------------
// Time-and-ID cursors and page building

/** The longest ID a feed cursor may carry: longer than any event ID, for synthetic positions. */
const MAX_POSITION_ID = 256;
// eslint-disable-next-line no-control-regex
const POSITION_ID_UNSAFE = /[\u0000-\u001f\u007f]/;

function isFeedPosition(position: { readonly occurredAt: unknown; readonly id: unknown }): position is FeedPosition {
  return isRfc3339Utc(position.occurredAt) && typeof position.id === 'string' && position.id.length >= 1
    && position.id.length <= MAX_POSITION_ID && !POSITION_ID_UNSAFE.test(position.id);
}

/**
 * The cursor for a feed position (an event is one): `encodeCursor({ t: occurredAt, i: id })`.
 * Throws a TypeError for a position that `decodeFeedPosition()` would not read back.
 */
export function encodeFeedPosition(position: FeedPosition): string {
  if (!isFeedPosition(position)) throw new TypeError('A feed position needs an RFC 3339 UTC occurredAt and an id of 1-256 characters');
  return encodeCursor({ t: position.occurredAt, i: position.id });
}

/**
 * Read a cursor from `encodeFeedPosition()`. Undefined for anything else: not a cursor, other
 * or extra fields, a timestamp that is not RFC 3339 UTC, an empty or over-long ID.
 */
export function decodeFeedPosition(cursor: string): FeedPosition | undefined {
  let value: Record<string, string | number>;
  try {
    value = decodeCursor(cursor);
  } catch {
    return undefined;
  }
  if (Object.keys(value).length !== 2) return undefined;
  const position = { occurredAt: value['t'], id: value['i'] };
  return isFeedPosition(position) ? position : undefined;
}

/** Like `decodeFeedPosition()`, but an unreadable cursor is a 400 `invalid_cursor` HiveError. */
export function requireFeedPosition(cursor: string): FeedPosition {
  const position = decodeFeedPosition(cursor);
  if (!position) throw new HiveError('invalid_cursor', 'The cursor is not valid', { status: 400 });
  return position;
}

function positionOf(after: FeedPosition | string | null | undefined): FeedPosition | undefined {
  if (after === undefined || after === null || after === '') return undefined;
  return typeof after === 'string' ? requireFeedPosition(after) : after;
}

export interface FeedWindowOptions {
  /** The position the page starts after: a decoded position or a cursor (a bad cursor is a 400). */
  readonly after?: FeedPosition | string | null | undefined;
  /** Events older than this are not served. Unset: no retention limit. */
  readonly retentionMs?: number | undefined;
  /** `Date.now()`, as a number or a function. */
  readonly now?: number | (() => number);
}

function retentionStart(options: FeedWindowOptions): number | undefined {
  if (options.retentionMs === undefined) return undefined;
  if (!Number.isFinite(options.retentionMs) || options.retentionMs < 0) throw new RangeError('retentionMs must be a non-negative number');
  const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
  return now - options.retentionMs;
}

/**
 * The earliest instant a page can need, as an ISO timestamp for a storage query: the start of
 * the retention window or the cursor's time, whichever is later. Undefined when neither is set.
 * Records exactly at the cursor's time must still be read: the ID decides which come after it.
 */
export function feedSince(options: FeedWindowOptions): string | undefined {
  const start = retentionStart(options);
  const position = positionOf(options.after);
  const cursorTime = position ? Date.parse(position.occurredAt) : undefined;
  const since = start === undefined ? cursorTime : cursorTime === undefined ? start : Math.max(start, cursorTime);
  return since === undefined ? undefined : new Date(since).toISOString();
}

/** One candidate `buildFeedPage()` left out because it was not a valid HiveEvent. */
export interface DroppedFeedEvent {
  /** Its index among the candidates given (nullish candidates count). */
  readonly index: number;
  readonly issues: readonly string[];
}

export interface BuildFeedPageOptions extends FeedWindowOptions {
  readonly limit: number;
  /**
   * How candidates are checked. `strict` (the default) also refuses unknown fields, as a
   * producer should; `lenient` drops them; `none` trusts the candidates, which must then be
   * valid HiveEvents already.
   */
  readonly validate?: 'strict' | 'lenient' | 'none';
  /** Called once, when at least one candidate was dropped as invalid. Log it: it is a producer bug. */
  readonly onDropped?: (count: number, dropped: readonly DroppedFeedEvent[]) => void;
}

/**
 * Build one feed page from candidate events in any order: validate each (an invalid one is
 * dropped and reported, never served), keep those inside the retention window and strictly
 * after the cursor, sort oldest first by `(occurredAt, id)` and cut at `limit` with a
 * time-and-ID `nextCursor`. `null` and `undefined` candidates are skipped, so mapping functions
 * may return them for records that are not events. Pass every event that can follow the cursor;
 * a caller that reads storage in bounded batches must decide itself when a page is complete.
 */
export function buildFeedPage(candidates: Iterable<unknown>, options: BuildFeedPageOptions): Page<HiveEvent> {
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new RangeError('limit must be a positive integer');
  const mode = options.validate ?? 'strict';
  const position = positionOf(options.after);
  const start = retentionStart(options);
  const events: HiveEvent[] = [];
  const dropped: DroppedFeedEvent[] = [];
  let index = -1;
  for (const candidate of candidates) {
    index++;
    if (candidate === null || candidate === undefined) continue;
    let event: HiveEvent;
    if (mode === 'none') event = candidate as HiveEvent;
    else {
      const checked = validateHiveEvent(candidate, { strict: mode === 'strict' });
      if (!checked.ok) {
        dropped.push({ index, issues: checked.issues });
        continue;
      }
      event = checked.value;
    }
    if (start !== undefined && Date.parse(event.occurredAt) < start) continue;
    if (!isAfterFeedPosition(event, position)) continue;
    events.push(event);
  }
  if (dropped.length) options.onDropped?.(dropped.length, dropped);
  events.sort(compareFeedPositions);
  return feedPage(events.slice(0, options.limit + 1), options.limit, encodeFeedPosition);
}

// ---------------------------------------------------------------------------------------
// Dedupe store

/** Remembers which event IDs were delivered. Implement it over Redis or SQL to share across replicas. */
export interface DedupeStore {
  /** Atomically claim `key`. Resolve true if it was not claimed (and is now), false if it already was. */
  claim(key: string, ttlMs: number): boolean | Promise<boolean>;
  /** Release a claim after a failed delivery so the event can be sent again. */
  release(key: string): void | Promise<void>;
}

/** An in-memory DedupeStore with TTL and a size bound. Per process only. */
export class MemoryDedupeStore implements DedupeStore {
  readonly #entries = new Map<string, number>();
  readonly #max: number;
  readonly #now: () => number;

  constructor(options: { readonly maxEntries?: number; readonly now?: () => number } = {}) {
    this.#max = options.maxEntries ?? 10_000;
    // Zero or less would make claim() evict forever.
    if (!Number.isInteger(this.#max) || this.#max < 1) throw new RangeError('maxEntries must be a positive integer');
    this.#now = options.now ?? (() => Date.now());
  }

  claim(key: string, ttlMs: number): boolean {
    const now = this.#now();
    const expiresAt = this.#entries.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;
    this.#entries.delete(key);
    if (this.#entries.size >= this.#max) {
      for (const [entry, expiry] of this.#entries) if (expiry <= now) this.#entries.delete(entry);
      while (this.#entries.size >= this.#max) this.#entries.delete(this.#entries.keys().next().value as string);
    }
    this.#entries.set(key, now + ttlMs);
    return true;
  }

  release(key: string): void {
    this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }
}

// ---------------------------------------------------------------------------------------
// ChatterMost notifier

export interface MattermostWebhookPayload {
  readonly text: string;
  readonly username?: string;
  readonly icon_url?: string;
  readonly channel?: string;
  readonly props?: Readonly<Record<string, unknown>>;
}

export interface ChatterMostNotifierOptions {
  /** The incoming-webhook URL. It is a secret: it is never logged or included in errors. */
  readonly webhookUrl: string;
  /** Absolute console origin used to turn `link.path` into a clickable URL, e.g. `https://hive.example.com`. */
  readonly linkBaseUrl?: string;
  readonly username?: string;
  readonly iconUrl?: string;
  readonly channel?: string;
  readonly fetch?: typeof fetch;
  /** Per-attempt timeout. 5000 ms. */
  readonly timeoutMs?: number;
  /** Retries after the first attempt. 3. */
  readonly retries?: number;
  /** First backoff delay; doubles per retry with jitter. 500 ms. */
  readonly backoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly dedupe?: DedupeStore;
  /** How long a delivered event ID is remembered. 24 hours. */
  readonly dedupeTtlMs?: number;
  /** Replace the default message formatting. */
  readonly format?: (event: HiveEvent) => MattermostWebhookPayload;
  /** Allow `http:` webhook URLs on loopback, for tests. */
  readonly allowInsecureLoopback?: boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export type NotifyResult =
  | { readonly status: 'sent'; readonly attempts: number }
  | { readonly status: 'duplicate'; readonly attempts: 0 }
  | { readonly status: 'failed'; readonly attempts: number; readonly error: string; readonly httpStatus?: number };

const SEVERITY_ICON: Readonly<Record<HiveEventSeverity, string>> = {
  info: ':information_source:',
  warning: ':warning:',
  critical: ':rotating_light:',
};

/** Neutralise Markdown and mentions in event text so a product cannot ping a channel or forge links. */
function escapeMarkdown(value: string): string {
  return value
    .replace(/[\\`*_~[\]()#>|]/g, char => `\\${char}`)
    .replace(/@(?=[A-Za-z0-9])/g, '@​')
    .replace(/<!/g, '<​!');
}

/** The default message: severity icon, product and title, summary, and a link. */
export function formatChatterMostMessage(event: HiveEvent, options: { readonly linkBaseUrl?: string } = {}): string {
  const title = `${SEVERITY_ICON[event.severity]} **${escapeMarkdown(event.product)}: ${escapeMarkdown(event.title)}**`;
  const summary = event.summary ? `\n${escapeMarkdown(event.summary)}` : '';
  let link = '';
  if (options.linkBaseUrl) {
    const url = new URL(event.link.path, options.linkBaseUrl);
    link = `\n[Open in ${escapeMarkdown(event.link.product)}](${url.href.replace(/[()]/g, encodeURIComponent)})`;
  } else link = `\n${escapeMarkdown(event.link.product)}: \`${event.link.path.replace(/`/g, '')}\``;
  return `${title}${summary}${link}`.slice(0, 16_000);
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Posts HiveEvents to a Mattermost-compatible incoming webhook (ChatterMost). One-way
 * announcements only. Each event ID is delivered at most once per dedupe window; failures
 * release the claim so a later call can retry.
 */
export class ChatterMostNotifier {
  readonly #options: ChatterMostNotifierOptions;
  readonly #fetch: typeof fetch;
  readonly #dedupe: DedupeStore;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  constructor(options: ChatterMostNotifierOptions) {
    const problem = endpointProblem(options.webhookUrl, { allowInsecureLoopback: options.allowInsecureLoopback ?? false });
    // The URL is a secret, so the error describes the problem without echoing it.
    if (problem) throw new TypeError(`ChatterMost webhookUrl ${problem}`);
    if (options.linkBaseUrl !== undefined && endpointProblem(options.linkBaseUrl, { allowInsecureLoopback: true })) {
      throw new TypeError('ChatterMost linkBaseUrl must be an https origin');
    }
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#dedupe = options.dedupe ?? new MemoryDedupeStore();
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.#random = options.random ?? Math.random;
  }

  /** The webhook body for an event. */
  payload(event: HiveEvent): MattermostWebhookPayload {
    if (this.#options.format) return this.#options.format(event);
    return {
      text: formatChatterMostMessage(event, this.#options.linkBaseUrl ? { linkBaseUrl: this.#options.linkBaseUrl } : {}),
      ...(this.#options.username ? { username: this.#options.username } : {}),
      ...(this.#options.iconUrl ? { icon_url: this.#options.iconUrl } : {}),
      ...(this.#options.channel ? { channel: this.#options.channel } : {}),
      props: { hive_event: { id: event.id, product: event.product, type: event.type, severity: event.severity } },
    };
  }

  /** Validate and deliver one event. Never throws for delivery failures; it reports them. */
  async notify(input: HiveEvent): Promise<NotifyResult> {
    const validation = validateHiveEvent(input);
    if (!validation.ok) throw HiveError.validation('The event is not a valid HiveEvent', validation.issues);
    const event = validation.value;
    // Build the body before claiming: a formatter that throws must not leave the event claimed
    // (and so silently undeliverable) for the whole dedupe window.
    const body = JSON.stringify(this.payload(event));
    const key = `hive-event:${event.product}:${event.id}`;
    if (!await this.#dedupe.claim(key, this.#options.dedupeTtlMs ?? 24 * 60 * 60_000)) return { status: 'duplicate', attempts: 0 };

    const retries = this.#options.retries ?? 3;
    const base = this.#options.backoffMs ?? 500;
    const max = this.#options.maxBackoffMs ?? 8_000;
    let lastError = 'failed';
    let lastStatus: number | undefined;
    let attempts = 0;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      attempts = attempt;
      let wait: number | undefined;
      try {
        const response = await this.#fetch(this.#options.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(this.#options.timeoutMs ?? 5_000),
        });
        void response.body?.cancel().catch(() => undefined);
        if (response.ok) return { status: 'sent', attempts: attempt };
        lastStatus = response.status;
        lastError = `HTTP ${response.status}`;
        // Other 4xx mean the request itself is wrong; repeating it cannot help.
        if (response.status !== 408 && response.status !== 429 && response.status < 500) break;
        wait = retryAfterMs(response);
      } catch (error) {
        lastStatus = undefined;
        lastError = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network error';
      }
      if (attempt <= retries) {
        const backoff = Math.min(max, base * 2 ** (attempt - 1));
        await this.#sleep(Math.min(max, wait ?? Math.round(backoff * (0.5 + this.#random() / 2))));
      }
    }
    await this.#dedupe.release(key);
    return { status: 'failed', attempts, error: redactText(lastError), ...(lastStatus !== undefined ? { httpStatus: lastStatus } : {}) };
  }
}
