import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  excessPrisma?: PrismaClient;
};

export const prisma = globalForPrisma.excessPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.excessPrisma = prisma;
}

export * from '@prisma/client';
