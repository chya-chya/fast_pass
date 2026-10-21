import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import Redlock, { ResourceLockedError } from 'redlock';
import type { RedlockAbortSignal } from 'redlock';

export type DistributedLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

const AUTOMATIC_EXTENSION_THRESHOLD_MS = 5_000;

@Injectable()
export class SchedulerLockService {
  private readonly logger = new Logger(SchedulerLockService.name);
  private readonly redlock: Redlock;

  constructor(@Inject('REDIS_CLIENT') redis: Redis) {
    this.redlock = new Redlock([redis], {
      driftFactor: 0.01,
      retryCount: 0,
      retryDelay: 200,
      retryJitter: 200,
      automaticExtensionThreshold: AUTOMATIC_EXTENSION_THRESHOLD_MS,
    });
    this.redlock.on('error', (error) => {
      if (!(error instanceof ResourceLockedError)) {
        this.logger.warn('Scheduler distributed lock Redis error');
      }
    });
  }

  async runExclusive<T>(
    resource: string,
    durationMs: number,
    routine: (signal: RedlockAbortSignal) => Promise<T>,
  ): Promise<DistributedLockResult<T>> {
    if (
      !resource ||
      !Number.isInteger(durationMs) ||
      durationMs <= AUTOMATIC_EXTENSION_THRESHOLD_MS
    ) {
      throw new Error('scheduler distributed lock configuration is invalid');
    }

    let entered = false;
    try {
      const value = await this.redlock.using(
        [resource],
        durationMs,
        { retryCount: 0 },
        async (signal) => {
          entered = true;
          return routine(signal);
        },
      );
      return { acquired: true, value };
    } catch (error) {
      // Redlock invokes the routine only after acquiring the lock. A failure
      // before entry therefore means another process owns it (or Redis could
      // not establish a quorum); fail closed and skip this scheduler tick.
      if (!entered) return { acquired: false };
      throw error;
    }
  }
}
