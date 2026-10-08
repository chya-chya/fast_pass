import { ReservationMetricsService } from './reservation-metrics.service';
import {
  RESERVATION_CONSUMER_GROUP,
  RESERVATION_DLQ_STREAM,
  RESERVATION_STREAM,
} from './test-run-tracker.service';

describe('ReservationMetricsService', () => {
  function metric() {
    return {
      inc: jest.fn(),
      labels: jest.fn().mockReturnThis(),
      observe: jest.fn(),
      set: jest.fn(),
    };
  }

  function createService(redis: Record<string, jest.Mock>) {
    const metrics = {
      requestOutcome: metric(),
      lua: metric(),
      enqueue: metric(),
      processed: metric(),
      persistence: metric(),
      batchSize: metric(),
      batchDuration: metric(),
      depth: metric(),
      processing: metric(),
      retry: metric(),
      dlq: metric(),
      oldest: metric(),
      collectionUp: metric(),
      retryComplete: metric(),
    };
    const service = new ReservationMetricsService(
      redis as never,
      metrics.requestOutcome as never,
      metrics.lua as never,
      metrics.enqueue as never,
      metrics.processed as never,
      metrics.persistence as never,
      metrics.batchSize as never,
      metrics.batchDuration as never,
      metrics.depth as never,
      metrics.processing as never,
      metrics.retry as never,
      metrics.dlq as never,
      metrics.oldest as never,
      metrics.collectionUp as never,
      metrics.retryComplete as never,
    );
    return { service, metrics };
  }

  it('publishes stream, PEL, retry, DLQ, and oldest-message gauges', async () => {
    const now = 1_700_000_005_000;
    const redis = {
      xlen: jest.fn((key) =>
        Promise.resolve(key === RESERVATION_DLQ_STREAM ? 1 : 3),
      ),
      xrange: jest
        .fn()
        .mockResolvedValue([[`${now - 5000}-0`, ['payload', '{}']]]),
      xinfo: jest
        .fn()
        .mockResolvedValue([
          ['name', RESERVATION_CONSUMER_GROUP, 'pending', 2],
        ]),
      xpending: jest.fn().mockResolvedValue([
        ['1-0', 'worker-1', 10, 1],
        ['2-0', 'worker-1', 10, 2],
      ]),
    };
    const { service, metrics } = createService(redis);

    await service.refreshQueueMetrics(now);

    expect(redis.xlen).toHaveBeenCalledWith(RESERVATION_STREAM);
    expect(metrics.depth.set).toHaveBeenCalledWith(3);
    expect(metrics.processing.set).toHaveBeenCalledWith(2);
    expect(metrics.retry.set).toHaveBeenCalledWith(1);
    expect(metrics.dlq.set).toHaveBeenCalledWith(1);
    expect(metrics.oldest.set).toHaveBeenCalledWith(5);
    expect(metrics.retryComplete.set).toHaveBeenCalledWith(1);
    expect(metrics.collectionUp.set).toHaveBeenCalledWith(1);
  });

  it('marks collection unavailable without replacing gauges with false zeroes', async () => {
    const redis = {
      xlen: jest.fn().mockRejectedValue(new Error('redis unavailable')),
      xrange: jest.fn(),
      xinfo: jest.fn(),
      xpending: jest.fn(),
    };
    const { service, metrics } = createService(redis);

    await expect(service.refreshQueueMetrics()).resolves.toBeUndefined();

    expect(metrics.collectionUp.set).toHaveBeenCalledWith(0);
    expect(metrics.depth.set).not.toHaveBeenCalled();
  });

  it('records only stable outcome labels and stream-based persistence latency', () => {
    const { service, metrics } = createService({} as never);
    service.recordRequestOutcome('accepted');
    service.recordLuaResult('MISS', 2);
    service.observePersistenceLatency('1700000000000-0', 1_700_000_001_500);
    service.observeSchedulerBatch(3, 0.25);

    expect(metrics.requestOutcome.labels).toHaveBeenCalledWith('accepted');
    expect(metrics.lua.labels).toHaveBeenCalledWith('MISS');
    expect(metrics.lua.inc).toHaveBeenCalledWith(2);
    expect(metrics.persistence.observe).toHaveBeenCalledWith(1.5);
    expect(metrics.batchSize.observe).toHaveBeenCalledWith(3);
    expect(metrics.batchDuration.observe).toHaveBeenCalledWith(0.25);
  });
});
