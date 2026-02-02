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
        // 10개의 객체를 직접 관리하는 대신, 하나의 고성능 클라이언트를 사용하거나
        // 필요하다면 ioredis의 Cluster 모드나 내장 설정을 활용합니다.
        const isCluster =
          configService.get<string>('REDIS_CLUSTER_MODE') === 'true';
        const useTls = configService.get<string>('REDIS_USE_TLS') !== 'false'; // Default to true if not specified

        console.log(`[RedisModule] Connecting to Cluster ${host}:${port}, TLS: ${useTls}`);

        if (isCluster) {
          return new Redis.Cluster([{ host, port }], {
            redisOptions: {
              tls: useTls
                ? {
                    checkServerIdentity: () => undefined, // Bypass hostname verification for AWS ElastiCache
                  }
                : undefined,
              // AWS ElastiCache DNS fix: prevent ioredis from re-resolving IPs
              dnsLookup: (address, callback) => callback(null, address),
            } as any, // Cast to any to avoid type definition issues with dnsLookup in redisOptions
          });
        }

        return new Redis({
          host,
          port,
          tls: {},
          // 커넥션 유지 및 자동 재연결 설정
          retryStrategy: (times) => Math.min(times * 50, 2000),
          reconnectOnError: (err) => {
            const targetError = 'READONLY';
            if (err.message.includes(targetError)) return true;
            return false;
          },
          // 1,000명 동시 요청 시 파이프라이닝을 위해 큐 크기 조절
          maxRetriesPerRequest: 3, // 무한 대기 방지 (지연 누적 차단)
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
