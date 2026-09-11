import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { env } from '../env.ts'

// Uma unica instancia para todo o processo: cada PrismaClient abre seu proprio
// pool, e o free tier da Neon tem limite de conexao.
//
// A partir do Prisma 7 a conexao entra por driver adapter e nao mais pela `url`
// do schema.prisma - a URL da CLI (migrate, studio) fica em prisma.config.ts.
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })

export const prisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})
