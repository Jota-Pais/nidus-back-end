import 'dotenv/config'
import { z } from 'zod'

// Zod no boot: se a configuracao esta errada, o processo nao sobe. Erro de ambiente aparece na
// largada e nao no meio de um request
const esquemaEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3333),
  DATABASE_URL: z
    .string()
    .min(1)
    .startsWith('postgres', { message: 'deve ser uma URL postgresql:// da Neon' }),
  // reduzida a origem (esquema + host + porta). O pacote 'cors' escreve a string
  // configurada literalmente em Access-Control-Allow-Origin e o navegador exige igualdade
  // byte a byte com o 'Origin' que ele manda - sem barra final, sem path, em minusculas.
  CORS_ORIGEM: z
    .url({ message: 'deve ser a URL do front-end' })
    .default('http://localhost:5173')
    .transform((valor) => new URL(valor).origin),
})

const resultado = esquemaEnv.safeParse(process.env)

if (!resultado.success) {
  console.error('Variaveis de ambiente invalidas. Confira o .env (modelo em .env.example):\n')
  console.error(z.prettifyError(resultado.error))
  process.exit(1)
}

export const env = resultado.data
