const REMOTE_GRACE_MS = 30_000;

export function assertRemoteLoadWindow(
  config,
  env,
  nowMs = Date.now(),
  graceMs = REMOTE_GRACE_MS,
) {
  if (config.isLocal || env.REMOTE_APPROVAL_VERIFIED !== 'true') return;
  const endsAt = Date.parse(env.REMOTE_APPROVAL_ENDS_AT || '');
  if (
    !Number.isFinite(endsAt) ||
    !Number.isFinite(config.durationMs) ||
    config.durationMs <= 0 ||
    !Number.isFinite(graceMs) ||
    graceMs < 0
  ) {
    throw new Error('remote approval load window is invalid');
  }
  if (nowMs + config.durationMs + graceMs > endsAt) {
    throw new Error(
      'remote approval window cannot cover the full load duration and shutdown grace',
    );
  }
}
