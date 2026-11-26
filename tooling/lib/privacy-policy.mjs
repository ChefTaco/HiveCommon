/**
 * Shared privacy and secret policy for Hive:Magnus repositories.
 * Findings carry a line number and a rule name, never the matching value.
 */

/** Directories that hold runtime state, credentials or agent data and are never committed. */
export const DEFAULT_FORBIDDEN_DIRS = Object.freeze([
  'certs', 'backups', 'state', 'artifacts', '.ardent', '.magnus', '.cindertrace', '.hive-dev', '.ssh',
  'audit-logs', 'terminal-audit',
]);

/** Variable names whose literal values are credentials. Names ending in PASSWORD need 8 characters, others 16. */
export const DEFAULT_SECRET_NAMES = Object.freeze([
  'DEPLOY_PASSWORD', 'SSH_PASSWORD', 'IAM_AGENT_SECRET', 'HIVE_ROUTER_SECRET', 'HIVEMEM_JWT_SECRET', 'API_SECRET',
  'JWT_SECRET', 'SESSION_SECRET', 'NODE_MANAGER_SECRET', 'AWS_SECRET_ACCESS_KEY',
]);

/** Account names that may appear in /home/<name> and /Users/<name> paths (documentation placeholders). */
export const DEFAULT_HOME_USERS = Object.freeze(['operator', 'deploy', 'user', 'x', 'foo', 'bar']);

const DIR_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;
const HOME_USER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function validated(values, pattern, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  for (const value of values) {
    if (typeof value !== 'string' || !pattern.test(value) || value === '.' || value === '..') {
      throw new TypeError(`Invalid ${label}: ${JSON.stringify(String(value)).slice(0, 80)}`);
    }
  }
  return values;
}

/** Validates extra forbidden directory names (also used by the shell scanner). */
export const validateDirNames = names => validated(names, DIR_NAME, 'forbidden directory name');

/** Builds the forbidden-path test. `dirs` replaces nothing: it adds to DEFAULT_FORBIDDEN_DIRS. */
export function forbiddenPathMatcher({ dirs = [], allow = [] } = {}) {
  const all = [...DEFAULT_FORBIDDEN_DIRS, ...validateDirNames(dirs)];
  const allowed = allow.map(pattern => new RegExp(pattern, 'i'));
  const forbidden = new RegExp('(^|/)\\.env($|\\.(?!example$))|(^|/)\\.npmrc$|\\.(pem|key|crt|p12|pfx|db|sqlite|sqlite3|bundle)'
    + '(?:-(?:wal|shm|journal))?$|(^|/)[^/]+\\.local\\.md$|(^|/)\\.private-terms$|(^|/)\\.vscode/mcp\\.json$'
    + `|(^|/)(${all.map(escape).join('|')})/`, 'i');
  return path => forbidden.test(path) && !allowed.some(pattern => pattern.test(path));
}

/** True when a repository-relative path may never be committed. */
export function forbiddenPath(path, options) {
  return forbiddenPathMatcher(options)(path);
}

const TOKEN_RULES = [
  ['OpenAI key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36,}\b/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
];

// Exempt only an explicitly fake value, never unrelated words elsewhere on its line.
function placeholder(value) {
  return /^(?:change[-_]me[-_]|replace[-_]|playwright[-_]|dummy[-_]|your[-_]|mock[-_]|ci-only-|\$\{|<)/i.test(value)
    || /(?:^|[-_])(?:test|fixture|example|placeholder)(?:[-_]|$)/i.test(value);
}

/** Provider tokens, private keys and literal values assigned to credential variables. */
export function secretFindings(content, { secretNames = [] } = {}) {
  const names = [...new Set([...DEFAULT_SECRET_NAMES, ...validated(secretNames, SECRET_NAME, 'secret variable name')])];
  const assignments = new RegExp(`\\b(${names.join('|')})["']?\\s*[:=]\\s*(?:["']([^"'\\r\\n]+)["']|([^\\s#;,'"}]+))`, 'g');
  const findings = [];
  for (const [index, line] of content.split('\n').entries()) {
    for (const [rule, pattern] of TOKEN_RULES) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) findings.push({ line: index + 1, rule });
    }
    // Quoted and unquoted shell/JSON/YAML/TS literal credentials. Expressions are not literals.
    for (const match of line.matchAll(assignments)) {
      const value = (match[2] ?? match[3]).split(/\\[nr]/, 1)[0];
      const minimum = match[1].endsWith('PASSWORD') ? 8 : 16;
      const expression = match[2] == null && (/^(?:[A-Za-z_$][\w$]*(?:\.|\(|\[)|\$|\.\*)/.test(value)
        || (match[0].includes(':') && /^[A-Za-z_$][\w$]*$/.test(value)));
      if (value.length >= minimum && !placeholder(value) && !expression) {
        findings.push({ line: index + 1, rule: 'literal credential' });
      }
    }
  }
  return findings;
}

/** Private network domains and personal home directories, without any operator denylist. */
export function privateInfrastructureFindings(content, { homeUsers = [] } = {}) {
  const allowed = new Set([...DEFAULT_HOME_USERS, ...validated(homeUsers, HOME_USER, 'home directory user')]);
  const findings = [];
  for (const [index, line] of content.split('\n').entries()) {
    if (/\b(?:[a-z0-9-]+\.)+ts\.net\b/i.test(line)) findings.push({ line: index + 1, rule: 'private network domain' });
    for (const match of line.matchAll(/\/(?:home|Users)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)/g)) {
      if (!allowed.has(match[1])) findings.push({ line: index + 1, rule: 'personal home path' });
    }
  }
  return findings;
}
