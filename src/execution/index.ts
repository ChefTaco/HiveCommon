/**
 * Execution context v1: the causal tree a unit of agent work belongs to, shared across
 * products (Studio request → Ardent task → model attempt → provider attempt).
 *
 * Isomorphic: no Node built-ins and no runtime dependencies, so the browser UI can read it.
 *
 * An execution context is **attribution only**. It never grants a tool, memory scope, artifact
 * or any other access; products that authorize work keep doing so from their own stores.
 * Readers treat a context they cannot validate (an unknown version, a malformed field) as
 * absent and never reject the request that carried it.
 */
import { readHeader, type HeaderSource, type ValidationResult } from '../contracts/index.js';

/** The HTTP header that carries an execution context: base64url-encoded JSON. */
export const EXECUTION_HEADER = 'x-hive-execution';
/** The key under which A2A message metadata carries an execution context (the JSON object). */
export const EXECUTION_METADATA_KEY = 'hiveExecution';
/** The largest encoded header accepted or produced. Larger contexts are dropped, never truncated. */
export const MAX_EXECUTION_HEADER_LENGTH = 2048;
/** The most causal inputs one context may list (the dependencies of a join). */
export const MAX_EXECUTION_INPUTS = 16;
/** The longest qualified reference. */
export const MAX_REF_LENGTH = 256;

/** What a reference points at. Products may only use these kinds. */
export const EXECUTION_REF_KINDS = ['request', 'task', 'mission', 'step', 'attempt', 'workflow', 'node', 'artifact', 'run'] as const;
export type ExecutionRefKind = (typeof EXECUTION_REF_KINDS)[number];

/** The parts of a qualified reference. */
export interface ExecutionRefParts {
  /** The owning product, such as `ardent`, `studio`, `emberpath` or `magnus`. */
  readonly product: string;
  /** The owning instance within the product, such as `<magnus node>.<profile>` for an Ardent profile. */
  readonly instance: string;
  readonly kind: ExecutionRefKind;
  /** The product-local identifier, such as a task UUID or `<task>/<step>/<attempt>`. */
  readonly id: string;
}

const PRODUCT = /^[a-z][a-z0-9-]{1,31}$/;
const INSTANCE = /^[A-Za-z0-9._-]{1,96}$/;
const LOCAL_ID = /^[A-Za-z0-9._:/-]{1,128}$/;
const REF = /^hx1:([a-z][a-z0-9-]{1,31}):([A-Za-z0-9._-]{1,96}):([a-z]+):([A-Za-z0-9._:/-]{1,128})$/;

/**
 * A qualified reference: `hx1:<product>:<instance>:<kind>:<id>`. Local identifiers are only
 * meaningful to their owner, so they leave a product only in this form.
 */
export function formatExecutionRef(parts: ExecutionRefParts): string {
  if (!PRODUCT.test(parts.product)) throw new TypeError('Execution reference product is invalid');
  if (!INSTANCE.test(parts.instance)) throw new TypeError('Execution reference instance is invalid');
  if (!(EXECUTION_REF_KINDS as readonly string[]).includes(parts.kind)) throw new TypeError('Execution reference kind is invalid');
  if (!LOCAL_ID.test(parts.id)) throw new TypeError('Execution reference id is invalid');
  const ref = `hx1:${parts.product}:${parts.instance}:${parts.kind}:${parts.id}`;
  if (ref.length > MAX_REF_LENGTH) throw new TypeError('Execution reference is too long');
  return ref;
}

/** The parts of a qualified reference, or undefined when it is not one. */
export function parseExecutionRef(value: unknown): ExecutionRefParts | undefined {
  if (typeof value !== 'string' || value.length > MAX_REF_LENGTH) return undefined;
  const match = REF.exec(value);
  if (!match) return undefined;
  const [, product, instance, kind, id] = match as unknown as [string, string, string, string, string];
  if (!(EXECUTION_REF_KINDS as readonly string[]).includes(kind)) return undefined;
  return { product, instance, kind: kind as ExecutionRefKind, id };
}

export function isExecutionRef(value: unknown): value is string {
  return parseExecutionRef(value) !== undefined;
}

/**
 * Execution context, version 1.
 *
 * - `request_id`: the request ID where the tree started (attribution; every hop keeps its own).
 * - `root`: stable for the whole causal tree.
 * - `parent`: the immediate causal parent of `self`.
 * - `self`: the unit that carries this context.
 * - `inputs`: further causal inputs, such as the branches a join waited for.
 * - `attempt`: 1 for the first try of `self`, counting up on retries and continuations.
 * - `deadline_ms`: an absolute epoch-milliseconds deadline. No layer retries past it.
 */
export interface ExecutionContext {
  readonly v: 1;
  readonly request_id?: string;
  readonly root: string;
  readonly parent?: string;
  readonly self?: string;
  readonly inputs?: readonly string[];
  readonly attempt?: number;
  readonly deadline_ms?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const REQUEST_ID = /^[A-Za-z0-9._:@/+=-]{1,128}$/;

/**
 * Validate an execution context. Unknown keys are dropped from the result. An unsupported
 * version is reported as the issue `unsupported_version`, which readers treat as absent.
 */
export function validateExecutionContext(value: unknown): ValidationResult<ExecutionContext> {
  if (!isRecord(value)) return { ok: false, issues: ['not_an_object'] };
  if (value.v !== 1) return { ok: false, issues: ['unsupported_version'] };
  const issues: string[] = [];
  if (!isExecutionRef(value.root)) issues.push('root');
  for (const key of ['parent', 'self'] as const) if (value[key] !== undefined && !isExecutionRef(value[key])) issues.push(key);
  if (value.request_id !== undefined && (typeof value.request_id !== 'string' || !REQUEST_ID.test(value.request_id))) issues.push('request_id');
  if (value.inputs !== undefined && (!Array.isArray(value.inputs) || value.inputs.length > MAX_EXECUTION_INPUTS || !value.inputs.every(isExecutionRef))) issues.push('inputs');
  if (value.attempt !== undefined && (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1 || (value.attempt as number) > 1_000_000)) issues.push('attempt');
  if (value.deadline_ms !== undefined && (!Number.isSafeInteger(value.deadline_ms) || (value.deadline_ms as number) < 0)) issues.push('deadline_ms');
  if (issues.length) return { ok: false, issues };
  const context: ExecutionContext = {
    v: 1,
    root: value.root as string,
    ...(value.request_id !== undefined ? { request_id: value.request_id as string } : {}),
    ...(value.parent !== undefined ? { parent: value.parent as string } : {}),
    ...(value.self !== undefined ? { self: value.self as string } : {}),
    ...(value.inputs !== undefined && (value.inputs as unknown[]).length ? { inputs: [...(value.inputs as string[])] } : {}),
    ...(value.attempt !== undefined ? { attempt: value.attempt as number } : {}),
    ...(value.deadline_ms !== undefined ? { deadline_ms: value.deadline_ms as number } : {}),
  };
  return { ok: true, value: context };
}

/** A valid execution context, or undefined. Never throws. */
export function parseExecutionContext(value: unknown): ExecutionContext | undefined {
  const result = validateExecutionContext(value);
  return result.ok ? result.value : undefined;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/** The header value for a context, or undefined when the encoding would exceed the limit. */
export function encodeExecutionHeader(context: ExecutionContext): string | undefined {
  const valid = parseExecutionContext(context);
  if (!valid) return undefined;
  const encoded = toBase64Url(JSON.stringify(valid));
  return encoded.length <= MAX_EXECUTION_HEADER_LENGTH ? encoded : undefined;
}

/** The context in a header value, or undefined when it is absent, too long or invalid. */
export function decodeExecutionHeader(value: string | null | undefined): ExecutionContext | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > MAX_EXECUTION_HEADER_LENGTH) return undefined;
  const json = fromBase64Url(text);
  if (json === undefined) return undefined;
  try {
    return parseExecutionContext(JSON.parse(json) as unknown);
  } catch {
    return undefined;
  }
}

/** The execution context in a set of headers, or undefined. */
export function readExecutionHeader(headers: HeaderSource): ExecutionContext | undefined {
  return decodeExecutionHeader(readHeader(headers, EXECUTION_HEADER));
}

/** Headers that carry `context`: empty when there is none or it does not fit. */
export function executionHeaders(context: ExecutionContext | undefined): Record<string, string> {
  if (!context) return {};
  const encoded = encodeExecutionHeader(context);
  return encoded ? { [EXECUTION_HEADER]: encoded } : {};
}

export interface ExecutionChildOptions {
  readonly attempt?: number;
  readonly requestId?: string;
  /** A deadline for the child. The earlier of this and the parent's applies. */
  readonly deadlineMs?: number;
  readonly inputs?: readonly string[];
}

/** A new tree rooted at `self`. */
export function rootExecution(self: string, options: ExecutionChildOptions = {}): ExecutionContext {
  return childExecution(undefined, self, options);
}

/**
 * The context for a unit of work caused by `parent`: the same root, `parent.self` (or the root)
 * as its parent, and the earlier of the two deadlines. Without a parent it starts a new tree.
 */
export function childExecution(parent: ExecutionContext | undefined, self: string, options: ExecutionChildOptions = {}): ExecutionContext {
  if (!isExecutionRef(self)) throw new TypeError('Execution self reference is invalid');
  const deadlines = [parent?.deadline_ms, options.deadlineMs].filter((value): value is number => typeof value === 'number');
  const inputs = (options.inputs ?? []).filter(isExecutionRef).slice(0, MAX_EXECUTION_INPUTS);
  const requestId = options.requestId ?? parent?.request_id;
  const causalParent = parent ? (parent.self ?? parent.root) : undefined;
  return {
    v: 1,
    root: parent?.root ?? self,
    ...(requestId !== undefined && REQUEST_ID.test(requestId) ? { request_id: requestId } : {}),
    ...(causalParent !== undefined && causalParent !== self ? { parent: causalParent } : {}),
    self,
    ...(inputs.length ? { inputs } : {}),
    ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
    ...(deadlines.length ? { deadline_ms: Math.min(...deadlines) } : {}),
  };
}

/** Milliseconds left before the context's deadline (never negative), or undefined without one. */
export function executionTimeRemaining(context: ExecutionContext | undefined, now: number = Date.now()): number | undefined {
  return context?.deadline_ms === undefined ? undefined : Math.max(0, context.deadline_ms - now);
}
