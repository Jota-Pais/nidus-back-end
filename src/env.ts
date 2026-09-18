import 'dotenv/config'
import { z } from 'zod'

// Zod no boot: se a configuracao esta errada, o processo nao sobe. Erro de
// ambiente aparece na largada e nao no meio de um request.
const esquemaEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3333),
  DATABASE_URL: z
    .string()
    .min(1)
    .startsWith('postgres', { message: 'deve ser uma URL postgresql:// da Neon' }),
  CORS_ORIGEM: z.url({ message: 'deve ser a URL do front-end' }).default('http://localhost:5173'),
  /**
   * Senha mestra opcional - decisao explicita do time (17/09/2026), pra
   * suporte e desenvolvimento rapido. Ver o comentario em `login.service.ts`.
   * Sem valor aqui, o caminho da senha mestra nunca bate - fica desligado.
   */
  SENHA_MESTRA: z.string().min(1).optional(),
})

const resultado = esquemaEnv.safeParse(process.env)

if (!resultado.success) {
  console.error('Variaveis de ambiente invalidas. Confira o .env (modelo em .env.example):\n')
  console.error(z.prettifyError(resultado.error))
  process.exit(1)
}

export const env = resultado.data

export type Env = typeof env
