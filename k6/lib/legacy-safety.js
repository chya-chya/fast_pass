export const LOCAL_BASE_URL = 'http://127.0.0.1:3000';

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const FORBIDDEN_ENVIRONMENT_PATTERN =
  /(^|[-_.])(prod|production|shared|staging)([-_.]|$)/i;
const FORBIDDEN_IDENTIFIER_PATTERN =
  /^(default|dev|development|fast_pass|prod|production|shared|staging)$/i;

function normalizeHostname(hostname) {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

export function isLoopbackHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function validateIdentifier(name, value, errors) {
  if (!value) {
    errors.push(`${name} is required`);
    return;
  }

  if (!SAFE_ID_PATTERN.test(value)) {
    errors.push(`${name} must be 3-64 safe identifier characters`);
  }

  if (FORBIDDEN_IDENTIFIER_PATTERN.test(value)) {
    errors.push(`${name} must identify a dedicated disposable resource`);
  }
}

export function validateLegacyEnvironment(env = {}) {
  const errors = [];
  const rawBaseUrl = env.BASE_URL || LOCAL_BASE_URL;
  let parsed;

  try {
    parsed = new URL(rawBaseUrl);
  } catch (_) {
    errors.push('BASE_URL must be a valid absolute URL');
  }

  if (parsed && !['http:', 'https:'].includes(parsed.protocol)) {
    errors.push('BASE_URL must use http or https');
  }

  if (parsed && (parsed.username || parsed.password)) {
    errors.push('BASE_URL must not contain credentials');
  }

  if (parsed && (parsed.pathname !== '/' || parsed.search || parsed.hash)) {
    errors.push('BASE_URL must contain only scheme, host, and optional port');
  }

  const hostname = parsed ? normalizeHostname(parsed.hostname) : '';
  const isLocal = parsed ? isLoopbackHostname(hostname) : false;
  const environmentName = env.TEST_ENVIRONMENT || '';

  if (environmentName !== 'local-disposable') {
    errors.push('TEST_ENVIRONMENT must be local-disposable for legacy scripts');
  }

  if (FORBIDDEN_ENVIRONMENT_PATTERN.test(environmentName)) {
    errors.push('shared, staging, and production environments are forbidden');
  }

  validateIdentifier('TEST_ENV_ID', env.TEST_ENV_ID, errors);
  validateIdentifier('TEST_DATABASE_ID', env.TEST_DATABASE_ID, errors);
  validateIdentifier('TEST_REDIS_ID', env.TEST_REDIS_ID, errors);

  if (env.ALLOW_TEST_DATA_MUTATION !== 'true') {
    errors.push('ALLOW_TEST_DATA_MUTATION=true is required');
  }

  if (!isLocal) {
    if (env.ALLOW_REMOTE_LOAD !== 'true') {
      errors.push('ALLOW_REMOTE_LOAD=true is required for any remote target');
    }
    if (!env.REMOTE_APPROVAL_MANIFEST) {
      errors.push('REMOTE_APPROVAL_MANIFEST is required for any remote target');
    }
    if (
      !env.APPROVED_TARGET_HOST ||
      normalizeHostname(env.APPROVED_TARGET_HOST) !== hostname
    ) {
      errors.push('APPROVED_TARGET_HOST must exactly match the BASE_URL host');
    }
    if (
      !env.APPROVED_TEST_ENV_ID ||
      env.APPROVED_TEST_ENV_ID !== env.TEST_ENV_ID
    ) {
      errors.push('APPROVED_TEST_ENV_ID must exactly match TEST_ENV_ID');
    }

    errors.push(
      'remote execution is disabled for legacy scripts until the phase 12 approval manifest verifier exists',
    );
  }

  return {
    baseUrl: parsed ? parsed.toString().replace(/\/$/, '') : rawBaseUrl,
    hostname,
    isLocal,
    errors,
  };
}

export function assertLegacyEnvironment(env = {}) {
  const result = validateLegacyEnvironment(env);
  if (result.errors.length > 0) {
    throw new Error(
      `Legacy k6 safety guard rejected execution: ${result.errors.join('; ')}`,
    );
  }
  return result;
}

export function randomString(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}
