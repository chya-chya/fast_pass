import { SchedulerLockService } from './scheduler-lock.service';
import type { RedlockAbortSignal, Settings as RedlockSettings } from 'redlock';

describe('SchedulerLockService', () => {
  type TestRoutine = (signal: RedlockAbortSignal) => Promise<unknown>;
  type UsingMock = jest.Mock<
    Promise<unknown>,
    [string[], number, Partial<RedlockSettings>, TestRoutine]
  >;

  function serviceWithUsing(using: UsingMock) {
    const service = new SchedulerLockService({} as never);
    Object.defineProperty(service, 'redlock', {
      value: { using },
    });
    return service;
  }

  it('returns acquired only after entering the protected routine', async () => {
    const signal = new AbortController().signal;
    const using: UsingMock = jest.fn(
      (
        _resources: string[],
        _duration: number,
        _settings: Partial<RedlockSettings>,
        routine: TestRoutine,
      ) => routine(signal),
    );
    const service = serviceWithUsing(using);

    await expect(
      service.runExclusive('locks:test', 30_000, () => Promise.resolve('done')),
    ).resolves.toEqual({ acquired: true, value: 'done' });
  });

  it('fails closed when the lock cannot be acquired', async () => {
    const using: UsingMock = jest.fn(() =>
      Promise.reject(new Error('lock unavailable')),
    );
    const service = serviceWithUsing(using);

    await expect(
      service.runExclusive('locks:test', 30_000, () =>
        Promise.resolve('not-run'),
      ),
    ).resolves.toEqual({ acquired: false });
  });

  it('propagates failures after the protected routine starts', async () => {
    const signal = new AbortController().signal;
    const service = serviceWithUsing(
      jest.fn(
        (
          _resources: string[],
          _duration: number,
          _settings: Partial<RedlockSettings>,
          routine: TestRoutine,
        ) => routine(signal),
      ),
    );

    await expect(
      service.runExclusive('locks:test', 30_000, () =>
        Promise.reject(new Error('task failed')),
      ),
    ).rejects.toThrow('task failed');
  });
});
