/**
 * `@hivemagnus/hive-common/oathweave`: Oathweave access-token verification for suite services.
 * Framework-free; see `/hono` and `/node-http` for middleware.
 */
export {
  createOathweaveVerifier,
  parseBearerToken,
  OATHWEAVE_DEFAULT_CLOCK_TOLERANCE_SEC,
  OATHWEAVE_FAILED_CHECK_TTL_MS,
  OATHWEAVE_MAX_LIFETIME_SEC,
  OATHWEAVE_MAX_TOKEN_LENGTH,
  OATHWEAVE_REQUEST_TIMEOUT_MS,
  OATHWEAVE_SESSION_CACHE_MAX,
  OATHWEAVE_SESSION_CACHE_TTL_MS,
  OATHWEAVE_STREAM_RECHECK_MS,
  type OathweaveVerifier,
  type OathweaveVerifierOptions,
  type VerifyOptions,
} from './verifier.js';
export {
  CLIENT_ID_CLAIMS,
  clientIdOf,
  extractRoles,
  extractScopes,
  principalFromClaims,
  principalKindOf,
  type AcceptPrincipal,
  type ClaimPolicy,
  type ClientIdClaim,
  type OathweavePrincipal,
  type OathweaveServicePrincipal,
  type OathweaveUserPrincipal,
  type PrincipalKind,
} from './claims.js';
export { OathweaveError, isOathweaveError, statusForReason, type OathweaveFailureReason } from './errors.js';
export { assertOathweaveEndpoint, endpointProblem, isLoopbackHost, isOathweaveEndpoint, type EndpointOptions } from './endpoint.js';
export {
  effectivePermissions,
  hasAnyRole,
  hasPermissions,
  hasScopes,
  IdentityLinkError,
  parseIdentityLinks,
  permissionMatches,
  requireIdentityLink,
  requirePermissions,
  uniqueIdentityLink,
  type OathweaveIdentityLink,
  type ParseIdentityLinksOptions,
  type PermissionOptions,
} from './links.js';
export { watchStreamAuthorization, type StreamWatch, type StreamWatchOptions } from './stream.js';
