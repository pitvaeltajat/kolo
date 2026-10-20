import { PrismaClient } from '@prisma/client';

// One client per process, kept across hot-reloads in dev (Next re-evaluates
// modules on every change and would otherwise exhaust the connection pool).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
