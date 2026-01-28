import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: (configService: ConfigService) => {
        const poolSize =
          Number(configService.get<number>('REDIS_POOL_SIZE')) || 10;
        const clients = Array.from({ length: poolSize }, () => {
          return new Redis({
            host: configService.get<string>('REDIS_HOST'),
            port: configService.get<number>('REDIS_PORT'),
            tls: {},
            connectionName: 'fast-pass-app',
            // ioredis options for robustness
            maxRetriesPerRequest: null,
          });
        });

        let index = 0;
        // Proxy to round-robin requests
        const proxy = new Proxy(
          {},
          {
            get: (target, prop) => {
              // Special handling for properties that might break if switched mid-stream
              // But for simple command execution, this works well.
              // We pick a client for THIS access
              const client = clients[index++ % clients.length];

              const value = client[prop as keyof Redis];

              if (typeof value === 'function') {
                return value.bind(client);
              }
              // eslint-disable-next-line @typescript-eslint/no-unsafe-return
              return value;
            },
          },
        );

        return proxy;
      },
      inject: [ConfigService],
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
