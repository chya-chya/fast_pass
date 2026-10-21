export type TracingConfig = {
  enabled: boolean;
  sampleRatio: number;
  minSpanDurationMs: number;
};

function parseNumber(
  name: string,
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function readTracingConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TracingConfig {
  return {
    enabled: environment.ENABLE_TRACING === 'true',
    sampleRatio: parseNumber(
      'OTEL_TRACE_SAMPLE_RATIO',
      environment.OTEL_TRACE_SAMPLE_RATIO,
      0.1,
      0.0001,
      1,
    ),
    minSpanDurationMs: parseNumber(
      'OTEL_MIN_SPAN_DURATION_MS',
      environment.OTEL_MIN_SPAN_DURATION_MS,
      0,
      0,
      60000,
    ),
  };
}
