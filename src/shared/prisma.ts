import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { env } from '../env.ts'

// Uma unica instancia para todo o processo: cada PrismaClient abre seu proprio pool, e o
// free tier da Neon tem limite de conexao.
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })

export const prisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  // As operacoes da colonia sao uma transacao so, com travas e varias leituras em sequencia. O
  // padrao do Prisma (2 s para pegar a conexao, 5 s para a transacao) nao cobre a Neon gratuita
  // acordando depois de parada nem o back rodando longe do banco, no desenvolvimento
  transactionOptions: { maxWait: 10_000, timeout: 20_000 },
})
