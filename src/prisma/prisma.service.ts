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
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required');
    }

    let hostname: string;
    try {
      hostname = new URL(connectionString).hostname.toLowerCase();
    } catch (_) {
      throw new Error('DATABASE_URL is invalid');
    }

    const configuredSslMode = process.env.DB_SSL_MODE;
    if (
      configuredSslMode !== undefined &&
      !['disable', 'require'].includes(configuredSslMode)
    ) {
      throw new Error('DB_SSL_MODE must be disable or require');
    }
    const inferredLocal =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === 'db';
    const sslMode =
      configuredSslMode || (inferredLocal ? 'disable' : 'require');

    const poolConfig: any = {
      connectionString,
      max: Number(process.env.DB_POOL_SIZE) || 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

    if (sslMode === 'disable') {
      poolConfig.ssl = false;
    } else {
      poolConfig.ssl = {
        rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
      };
    }

    const pool = new Pool(poolConfig);
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
