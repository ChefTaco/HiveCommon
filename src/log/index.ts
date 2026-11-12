/**
 * A small structured JSON logger. One line per entry, secrets redacted, and the current
 * request ID and trace ID added automatically from the request context.
 */
import { getRequestContext, type RequestContext } from '../context/index.js';
import { redact } from './redact.js';

export { redact, redactHeaders, redactText, isSensitiveKey, REDACTED, type RedactOptions } from './redact.js';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
const SEVERITY: Readonly<Record<LogLevel | 'silent', number>> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 100 };

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  fatal(message: string, fields?: LogFields): void;
  /** A logger that adds `bindings` to every line. */
  child(bindings: LogFields): Logger;
  isLevelEnabled(level: LogLevel): boolean;
  readonly level: LogLevel | 'silent';
}

export interface LoggerOptions {
  /** Minimum level written. Defaults to `LOG_LEVEL` when valid, else `info`. */
  readonly level?: LogLevel | 'silent';
  /** Fields on every line, such as `{ service: 'hivemem' }`. */
  readonly bindings?: LogFields;
  /** Where lines go. Defaults to `process.stdout.write` with a trailing newline. */
  readonly write?: (line: string) => void;
  /** Redact secrets. On by default; turn off only for trusted, already-clean fields. */
  readonly redact?: boolean;
  /** Extra keys to redact. */
  readonly redactKeys?: readonly string[];
  /** Include `err.stack` for Error fields. Off by default. */
  readonly stacks?: boolean;
  readonly now?: () => number;
  /** Where the request context comes from. Defaults to the AsyncLocalStorage context. */
  readonly context?: () => RequestContext | undefined;
}

function defaultLevel(): LogLevel {
  const value = typeof process !== 'undefined' ? process.env['LOG_LEVEL']?.toLowerCase() : undefined;
  return LOG_LEVELS.includes(value as LogLevel) ? (value as LogLevel) : 'info';
}

function serializeErrors(fields: Record<string, unknown>, stacks: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) {
      const code = (value as { code?: unknown }).code;
      const status = (value as { status?: unknown }).status;
      result[key] = {
        name: value.name,
        message: value.message,
        ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
        ...(typeof status === 'number' ? { status } : {}),
        ...(stacks && value.stack ? { stack: value.stack } : {}),
      };
    } else result[key] = value;
  }
  return result;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));
  } catch {
    return JSON.stringify({ level: 'error', msg: 'log entry could not be serialised' });
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? defaultLevel();
  const threshold = SEVERITY[level];
  const write = options.write ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const shouldRedact = options.redact ?? true;
  const now = options.now ?? Date.now;
  const context = options.context ?? getRequestContext;
  const bindings = options.bindings ?? {};

  const emit = (entryLevel: LogLevel, message: string, fields: LogFields | undefined): void => {
    if (SEVERITY[entryLevel] < threshold) return;
    const current = context();
    const merged: Record<string, unknown> = {
      ...bindings,
      ...(current ? current.bindings : {}),
      ...serializeErrors({ ...fields }, options.stacks ?? false),
    };
    // Reserved fields win over bindings so a caller cannot forge them.
    const entry = {
      ...(shouldRedact ? redact(merged, { keys: options.redactKeys ?? [] }) : merged),
      time: new Date(now()).toISOString(),
      level: entryLevel,
      msg: shouldRedact ? redact(message) : message,
      ...(current ? { requestId: current.requestId, traceId: current.trace.traceId } : {}),
    };
    write(safeStringify(entry));
  };

  const logger: Logger = {
    level,
    trace: (message, fields) => emit('trace', message, fields),
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    fatal: (message, fields) => emit('fatal', message, fields),
    child: childBindings => createLogger({ ...options, level, bindings: { ...bindings, ...childBindings } }),
    isLevelEnabled: candidate => SEVERITY[candidate] >= threshold,
  };
  return logger;
}
