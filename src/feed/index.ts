/**
 * The consumer side of a HiveEvent feed: read `GET <feed>?after=<cursor>&limit=<n>` page by
 * page, validating every event on its own.
 *
 * Isomorphic: no Node built-ins, so the browser UI can use it. Producers use `/events`.
 */
import { isPage, validateHiveEvent, type HiveEvent } from '../contracts/index.js';
import { BoundedFetchError, readJsonBounded } from '../fetch/index.js';

/** The fetch a feed is read with: given the URL (as passed in, plus the query) and the request init. */
export type HiveEventFeedFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Where a read stands. Pass the same object again to continue from `cursor`. */
export interface HiveEventFeedProgress {
  /** Valid events, in the order the feed served them (oldest first). */
  events: HiveEvent[];
  /** The last `nextCursor` the feed gave, or the cursor the read started from. */
  cursor: string | null;
  /** Events that failed validation or claimed another product. Counted, never kept. */
  dropped: number;
}

export interface HiveEventFeedResult extends HiveEventFeedProgress {
  /** Pages read by this call. */
  pages: number;
  /** True when the feed said there is nothing more; false when `maxPages` stopped the read. */
  caughtUp: boolean;
}

/** The page size limit applied when `maxPageBytes` is not given: 6 MiB. */
export const DEFAULT_MAX_PAGE_BYTES = 6 * 1024 * 1024;

export type HiveEventFeedFailure =
  | 'aborted' // `signal` aborted (a caller's deadline, usually)
  | 'network' // the request itself failed
  | 'status' // the feed answered outside 200-299 (see `status`)
  | 'malformed'; // not JSON, not a page, or larger than `maxPageBytes`

const MESSAGES: Readonly<Record<HiveEventFeedFailure, string>> = {
  aborted: 'The feed read was aborted',
  network: 'The feed could not be reached',
  status: 'The feed answered with an error status',
  malformed: 'The feed sent a page that cannot be read',
};

/** A feed read that failed. Whatever earlier pages gave is on `progress`. */
export class HiveEventFeedError extends Error {
  override readonly name = 'HiveEventFeedError';
  readonly kind: HiveEventFeedFailure;
  /** The HTTP status, for `status`. */
  readonly status: number | undefined;
  readonly progress: HiveEventFeedProgress;

  constructor(kind: HiveEventFeedFailure, progress: HiveEventFeedProgress, options: { readonly status?: number; readonly cause?: unknown } = {}) {
    super(kind === 'status' && options.status !== undefined ? `${MESSAGES.status} (HTTP ${options.status})` : MESSAGES[kind],
      options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.status = options.status;
    this.progress = progress;
  }
}

export interface ReadHiveEventFeedOptions {
  /** Cursor to start after; null, undefined or empty reads from the start of the feed. Ignored when `progress` is given. */
  readonly after?: string | null | undefined;
  /** Events asked for per page. 200, the most a feed serves. */
  readonly limit?: number;
  /** Pages read in one call, so a feed that never ends cannot hold the caller. 10. */
  readonly maxPages?: number;
  readonly signal?: AbortSignal | undefined;
  /** Keep only events whose `product` is this ID; others count as dropped. A feed speaks for its own product only. */
  readonly product?: string | undefined;
  /** A further filter on valid events: return false to count one as dropped. */
  readonly accept?: (event: HiveEvent) => boolean;
  /**
   * Refuse a page larger than this many bytes as `malformed`. Default `DEFAULT_MAX_PAGE_BYTES`
   * (6 MiB): a valid 200-event page is at most about 3 MB, so only a misbehaving feed reaches it.
   * `Infinity` reads the page whole.
   */
  readonly maxPageBytes?: number | undefined;
  /** Extra request headers. `accept: application/json` is sent unless given here. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Progress to continue and update in place as pages arrive, so the caller keeps what earlier
   * pages gave even when a later one fails. Without it a new one starts at `after`.
   */
  readonly progress?: HiveEventFeedProgress;
}

function pageUrl(url: string, cursor: string | null, limit: number): string {
  const query = new URLSearchParams();
  if (cursor) query.set('after', cursor);
  query.set('limit', String(limit));
  const hash = url.indexOf('#');
  const base = hash === -1 ? url : url.slice(0, hash);
  return `${base}${base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?'}${query.toString()}`;
}

/**
 * Read a feed from a cursor until it is caught up or `maxPages` pages were read. Each event is
 * validated on its own (`validateHiveEvent`, unknown fields dropped): one bad event is dropped
 * and counted, not the page. Failures are a `HiveEventFeedError` carrying the progress so far.
 */
export async function readHiveEventFeed(request: HiveEventFeedFetch, url: string, options: ReadHiveEventFeedOptions = {}): Promise<HiveEventFeedResult> {
  const limit = options.limit ?? 200;
  const maxPages = options.maxPages ?? 10;
  const maxPageBytes = options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES;
  if (!(maxPageBytes > 0)) throw new RangeError('maxPageBytes must be a positive number');
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new RangeError('maxPages must be a positive integer');
  const progress: HiveEventFeedProgress = options.progress ?? { events: [], cursor: options.after || null, dropped: 0 };
  const signal = options.signal;
  const given = options.headers ?? {};
  // A plain record, so a wrapping fetch can read and extend it without knowing `Headers`.
  const headers: Record<string, string> = Object.keys(given).some(name => name.toLowerCase() === 'accept') ? { ...given } : { accept: 'application/json', ...given };
  const fail = (kind: HiveEventFeedFailure, extra: { status?: number; cause?: unknown } = {}): HiveEventFeedError =>
    new HiveEventFeedError(signal?.aborted && kind !== 'status' ? 'aborted' : kind, progress, extra);

  let pages = 0;
  while (pages < maxPages) {
    let response: Response;
    try {
      response = await request(pageUrl(url, progress.cursor, limit), { cache: 'no-store', headers, ...(signal ? { signal } : {}) });
    } catch (cause) {
      throw fail('network', { cause });
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw fail('status', { status: response.status });
    }
    let body: unknown;
    try {
      body = maxPageBytes === Infinity
        ? await response.json() as unknown
        : await readJsonBounded(response, maxPageBytes, signal ? { signal } : {});
    } catch (cause) {
      throw fail('malformed', cause instanceof BoundedFetchError ? {} : { cause });
    }
    if (!isPage(body)) throw fail('malformed');
    pages++;
    for (const item of body.data) {
      const result = validateHiveEvent(item);
      if (result.ok && (options.product === undefined || result.value.product === options.product) && (options.accept?.(result.value) ?? true)) {
        progress.events.push(result.value);
      } else progress.dropped++;
    }
    if (body.nextCursor === null) return { events: progress.events, cursor: progress.cursor, dropped: progress.dropped, pages, caughtUp: true };
    progress.cursor = body.nextCursor;
  }
  return { events: progress.events, cursor: progress.cursor, dropped: progress.dropped, pages, caughtUp: false };
}
