/**
 * One fixture per error shape the suite's products send. Bodies are as they appear on the
 * wire; expectations are what parseHiveError() must produce.
 */
import type { HiveErrorShape } from '../../src/errors/index.js';

export interface LegacyErrorFixture {
  readonly product: string;
  readonly status: number;
  readonly body: unknown;
  readonly expected: {
    readonly shape: HiveErrorShape;
    readonly code: string;
    readonly message: string;
    readonly status?: number;
    readonly requestId?: string;
    readonly details?: Record<string, unknown>;
  };
}

export const LEGACY_ERROR_FIXTURES: readonly LegacyErrorFixture[] = [
  {
    product: 'Hive standard envelope',
    status: 404,
    body: '{"error":{"code":"not_found","message":"No such project","requestId":"req-1","details":{"id":"p1"}}}',
    expected: { shape: 'envelope', code: 'not_found', message: 'No such project', requestId: 'req-1', details: { id: 'p1' } },
  },
  {
    product: 'Magnus',
    status: 409,
    body: { success: false, error: { code: 'AGENT_BUSY', message: 'Agent is busy' } },
    expected: { shape: 'magnus', code: 'AGENT_BUSY', message: 'Agent is busy' },
  },
  {
    product: 'Ardent',
    status: 422,
    body: { error: { code: 'VALIDATION_ERROR', message: 'name: Required' } },
    expected: { shape: 'envelope', code: 'VALIDATION_ERROR', message: 'name: Required' },
  },
  {
    product: 'ArdentStudio',
    status: 403,
    body: { error: { code: 'unknown_role', message: 'Role is not part of the team' } },
    expected: { shape: 'envelope', code: 'unknown_role', message: 'Role is not part of the team' },
  },
  {
    product: 'Hive Registry',
    status: 401,
    body: '{"error":{"code":"invalid_credential","message":"Registry credential was not accepted"}}',
    expected: { shape: 'envelope', code: 'invalid_credential', message: 'Registry credential was not accepted' },
  },
  {
    product: 'Oathweave',
    status: 401,
    body: { error: 'UNAUTHORIZED', message: 'Bearer token required' },
    expected: { shape: 'oathweave', code: 'UNAUTHORIZED', message: 'Bearer token required' },
  },
  {
    product: 'Emberpath',
    status: 502,
    body: { error: 'Provider request failed' },
    expected: { shape: 'string', code: 'bad_gateway', message: 'Provider request failed' },
  },
  {
    product: 'HiveSkills',
    status: 400,
    body: '{"error":"Skill name is required"}',
    expected: { shape: 'string', code: 'bad_request', message: 'Skill name is required' },
  },
  {
    product: 'Cindertrace',
    status: 500,
    body: { error: 'Internal server error' },
    expected: { shape: 'string', code: 'internal', message: 'Internal server error' },
  },
  {
    product: 'Embermend',
    status: 503,
    body: { error: 'INFERENCE_CAPACITY_UNAVAILABLE' },
    expected: { shape: 'code', code: 'INFERENCE_CAPACITY_UNAVAILABLE', message: 'The service is unavailable' },
  },
  {
    product: 'HiveMem (string detail)',
    status: 404,
    body: { detail: 'Memory not found' },
    expected: { shape: 'fastapi', code: 'not_found', message: 'Memory not found' },
  },
  {
    product: 'HiveMem (validation detail)',
    status: 422,
    body: {
      detail: [
        { loc: ['body', 'query'], msg: 'field required', type: 'value_error.missing' },
        { loc: ['query', 'limit'], msg: 'ensure this value is less than or equal to 100', type: 'value_error.number.not_le' },
      ],
    },
    expected: {
      shape: 'fastapi-validation',
      code: 'validation_failed',
      message: 'body.query: field required (and 1 more)',
      details: {
        issues: [
          { path: 'body.query', message: 'field required', type: 'value_error.missing' },
          { path: 'query.limit', message: 'ensure this value is less than or equal to 100', type: 'value_error.number.not_le' },
        ],
      },
    },
  },
  {
    product: 'HiveMem (object detail)',
    status: 409,
    body: { detail: { code: 'duplicate_memory', message: 'Already stored' } },
    expected: { shape: 'fastapi', code: 'duplicate_memory', message: 'Already stored' },
  },
  {
    product: 'ChatterMost (Mattermost)',
    status: 401,
    body: {
      id: 'api.context.session_expired.app_error',
      message: 'Invalid or expired session, please login again.',
      detailed_error: '',
      request_id: 'mm-request-1',
      status_code: 401,
    },
    expected: {
      shape: 'mattermost',
      code: 'api.context.session_expired.app_error',
      message: 'Invalid or expired session, please login again.',
      requestId: 'mm-request-1',
    },
  },
  {
    product: 'OAuth 2.0',
    status: 400,
    body: { error: 'invalid_grant', error_description: 'The authorization code has expired' },
    expected: { shape: 'oauth', code: 'invalid_grant', message: 'The authorization code has expired' },
  },
  {
    product: 'OAuth 2.0 (no description)',
    status: 401,
    body: { error: 'invalid_client' },
    expected: { shape: 'code', code: 'invalid_client', message: 'Authentication is required' },
  },
  {
    product: 'Plain text',
    status: 502,
    body: 'upstream connect error or disconnect/reset before headers',
    expected: { shape: 'text', code: 'bad_gateway', message: 'upstream connect error or disconnect/reset before headers' },
  },
  {
    product: 'HTML proxy page',
    status: 504,
    body: '<!DOCTYPE html><html><body><h1>504 Gateway Time-out</h1></body></html>',
    expected: { shape: 'text', code: 'gateway_timeout', message: 'An upstream service timed out' },
  },
  {
    product: 'Empty body',
    status: 503,
    body: '',
    expected: { shape: 'empty', code: 'unavailable', message: 'The service is unavailable' },
  },
];
