const EMAIL_LOCAL_PART_LIMIT = 64;

function emailToken(value, fallback) {
  const token = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 20);
  return token || fallback;
}

export function transientFixtureEmail(kind, index, nonce) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('fixture email index must be a non-negative integer');
  }

  const prefix = `k6-${emailToken(kind, 'fixture')}-${index.toString(36)}-`;
  const remaining = EMAIL_LOCAL_PART_LIMIT - prefix.length;
  if (remaining < 1) {
    throw new Error('fixture email prefix exceeds the local-part limit');
  }

  const localPart = `${prefix}${emailToken(nonce, 'run').slice(0, remaining)}`;
  return `${localPart}@example.invalid`;
}
