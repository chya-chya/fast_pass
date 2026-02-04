import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import 'dotenv/config';
import {
  BatchSpanProcessor,
  SpanProcessor,
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
  const batchSpanProcessor = new BatchSpanProcessor(traceExporter, {
    // Increase delay to 10 seconds to reduce CPU/Network overhead (Default: 5000ms)
    scheduledDelayMillis: 10000,
    // Keep default batch size (512) or adjust if memory is critical
    maxExportBatchSize: 512,
  });

  // Custom SpanProcessor to filter spans with duration < 1s
  class DurationFilterSpanProcessor implements SpanProcessor {
    constructor(private readonly processor: SpanProcessor) {}

    onStart(span: any, context: any) {
      this.processor.onStart(span, context);
    }

    onEnd(span: any) {
      // span.duration is [seconds, nanoseconds]
      if (span.duration && span.duration[0] >= 1) {
        this.processor.onEnd(span);
      }
    }

    async shutdown() {
      return this.processor.shutdown();
    }

    async forceFlush() {
      return this.processor.forceFlush();
    }
  }

  const sdk = new NodeSDK({
    spanProcessor: new DurationFilterSpanProcessor(batchSpanProcessor),
    instrumentations: [getNodeAutoInstrumentations()],
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'fast_pass',
    }),
    // Sampler removed implies AlwaysOnSampler (100%), but we filter at SpanProcessor
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
