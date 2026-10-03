import { randomUUID } from 'node:crypto';
import { Request } from 'express';

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,95}$/;

export type CorrelatedRequest = Request & { correlationId?: string };

export function getRequestCorrelationId(request: CorrelatedRequest): string {
  if (request.correlationId) return request.correlationId;
  const raw = request.headers['x-request-id'];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  request.correlationId =
    typeof candidate === 'string' && SAFE_REQUEST_ID.test(candidate)
      ? candidate
      : randomUUID();
  return request.correlationId;
}
