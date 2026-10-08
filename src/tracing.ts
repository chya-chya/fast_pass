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
  SpanProcessor,
  ReadableSpan,
  Span,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { Context } from '@opentelemetry/api';
import { readTracingConfig } from './observability/tracing-config';

const tracingConfig = readTracingConfig();

if (tracingConfig.enabled) {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

  const otelEndpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
  const traceUrl = otelEndpoint.endsWith('/v1/traces')
    ? otelEndpoint
    : `${otelEndpoint}/v1/traces`;

  const exporterOptions = {
    url: traceUrl,
  };

  const traceExporter = new OTLPTraceExporter(exporterOptions);

  // Use BatchSpanProcessor with custom configuration for high-load optimization
  const batchSpanProcessor = new BatchSpanProcessor(traceExporter, {
    // Reduce delay to 1 second for more frequent exports under high load
    scheduledDelayMillis: 1000,
    // Increase batch size for higher throughput
    maxExportBatchSize: 1024,
    // Significantly increase queue size to prevent dropping spans during bursts (default: 2048)
    maxQueueSize: 10000,
  });

  // Sampling limits trace volume; the duration filter is separately tunable so
  // normal latency spans can be retained during performance comparisons.
  class DurationFilterSpanProcessor implements SpanProcessor {
    constructor(private readonly processor: SpanProcessor) {}

    onStart(span: Span, context: Context) {
      this.processor.onStart(span, context);
    }

    onEnd(span: ReadableSpan) {
      // span.duration is [seconds, nanoseconds]
      if (span.duration) {
        const [seconds, nanoseconds] = span.duration;
        const durationMs = seconds * 1000 + nanoseconds / 1000000;

        if (durationMs >= tracingConfig.minSpanDurationMs) {
          this.processor.onEnd(span);
        }
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
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(tracingConfig.sampleRatio),
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
