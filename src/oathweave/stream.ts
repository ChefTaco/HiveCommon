/**
 * Re-checking authorization on long-lived connections (SSE, WebSocket, long poll).
 *
 * A stream verified once at open would outlive a sign-out. `watchStreamAuthorization()`
 * re-verifies every `OATHWEAVE_STREAM_RECHECK_MS` (the verifier's 10 s session cache keeps
 * that cheap) and ends the stream at the token's expiry, so sign-out takes effect within
 * about 15 seconds on open streams as well as on ordinary requests.
 */
import { OathweaveError } from './errors.js';
import { OATHWEAVE_STREAM_RECHECK_MS } from './verifier.js';

export interface StreamWatchOptions {
  /** Re-verify the caller. Usually `() => verifier.verify(token)`. Rejecting ends the stream. */
  readonly recheck: () => Promise<{ readonly expiresAt: number }>;
  /** Token expiry in epoch seconds. The stream ends then even if rechecks pass. */
  readonly expiresAt: number;
  /** Called once when the stream must close. */
  readonly onEnd: (error: OathweaveError) => void;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export interface StreamWatch {
  stop(): void;
  readonly stopped: boolean;
}

export function watchStreamAuthorization(options: StreamWatchOptions): StreamWatch {
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? OATHWEAVE_STREAM_RECHECK_MS;
  let stopped = false;
  let inFlight = false;
  const end = (error: OathweaveError): void => {
    if (stopped) return;
    stop();
    options.onEnd(error);
  };
  const expiryDelay = Math.max(0, options.expiresAt * 1000 - now());
  // setTimeout cannot hold more than ~24.8 days; tokens never live that long.
  const expiryTimer = setTimeout(() => end(new OathweaveError('expired')), Math.min(expiryDelay, 2_147_483_647));
  const interval = setInterval(() => {
    if (inFlight || stopped) return;
    inFlight = true;
    options.recheck().then(
      () => { inFlight = false; },
      (error: unknown) => {
        inFlight = false;
        end(error instanceof OathweaveError ? error : new OathweaveError('session_inactive', { cause: error }));
      },
    );
  }, intervalMs);
  // Never keep a process alive just to watch a stream.
  expiryTimer.unref?.();
  interval.unref?.();
  function stop(): void {
    stopped = true;
    clearTimeout(expiryTimer);
    clearInterval(interval);
  }
  return {
    stop,
    get stopped() { return stopped; },
  };
}
