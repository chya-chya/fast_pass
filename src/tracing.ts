import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import 'dotenv/config';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';

if (process.env.ENABLE_TRACING === 'true') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

  const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
  const traceUrl = otelEndpoint.endsWith('/v1/traces')
    ? otelEndpoint
    : `${otelEndpoint}/v1/traces`;

  const exporterOptions = {
    url: traceUrl,
  };

  const traceExporter = new OTLPTraceExporter(exporterOptions);
  
  // Use BatchSpanProcessor with custom configuration for Free Tier optimization
  const spanProcessor = new BatchSpanProcessor(traceExporter, {
    // Increase delay to 10 seconds to reduce CPU/Network overhead (Default: 5000ms)
    scheduledDelayMillis: 10000,
    // Keep default batch size (512) or adjust if memory is critical
    maxExportBatchSize: 512,
  });

  const sdk = new NodeSDK({
    spanProcessor,
    instrumentations: [getNodeAutoInstrumentations()],
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'fast_pass',
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(0.1),
    }),
  });

  // Export nothing, just start
  sdk.start();

  process.on('SIGTERM', () => {
    sdk
      .shutdown()
      .then(() => console.log('Tracing terminated'))
      .catch((error: unknown) => {
        console.log('Error terminating tracing', error);
      })
      .finally(() => process.exit(0));
  });
}
