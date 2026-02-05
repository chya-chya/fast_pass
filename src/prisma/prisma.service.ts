import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    console.log('🚀 DB Connection with SSL bypass starting...'); // 이 로그를 추가!
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false,
      },
      max: Number(process.env.DB_POOL_SIZE) || 10,
      idleTimeoutMillis: 30000, // 연결이 30초 동안 유휴 상태여야 닫힘 (기본값 10초는 너무 짧아서 재연결 오버헤드 발생)
      connectionTimeoutMillis: 5000, // 연결 시도 5초 초과 시 타임아웃
    });
    const adapter = new PrismaPg(pool);
    super({ adapter });
  }
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
