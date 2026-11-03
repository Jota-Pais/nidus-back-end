import 'dotenv/config'
import { z } from 'zod'

/** Variavel vazia no .env ('CHAVE=', como no .env.example) conta como ausente, nao como texto */
const opcional = <T extends z.ZodType>(tipo: T) =>
  z.preprocess(
    (valor) => (typeof valor === 'string' && valor.trim() === '' ? undefined : valor),
    tipo.optional(),
  )

/** O que production nao sobe sem: sem elas o codigo de acesso nao sai por e-mail */
const OBRIGATORIAS_EM_PRODUCAO = ['BREVO_API_KEY', 'EMAIL_REMETENTE'] as const

// Zod no boot: se a configuracao esta errada, o processo nao sobe. Erro de ambiente aparece na
// largada e nao no meio de um request
export const esquemaEnv = z
  .object({
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
    // E-mail pela API HTTP da Brevo. So production manda e-mail de verdade: em development e
    // test ele vai para o console do servidor, e as duas podem faltar
    BREVO_API_KEY: opcional(z.string().trim()),
    // A Brevo so aceita remetente validado na conta dela
    EMAIL_REMETENTE: opcional(z.email({ message: 'deve ser o e-mail do remetente validado na Brevo' })),
  })
  .superRefine((valores, contexto) => {
    if (valores.NODE_ENV !== 'production') {
      return
    }

    for (const chave of OBRIGATORIAS_EM_PRODUCAO) {
      if (valores[chave] === undefined) {
        contexto.addIssue({
          code: 'custom',
          path: [chave],
          message: 'obrigatoria em production: sem ela o codigo de acesso nao sai por e-mail',
        })
      }
    }
  })

const resultado = esquemaEnv.safeParse(process.env)

if (!resultado.success) {
  console.error('Variaveis de ambiente invalidas. Confira o .env (modelo em .env.example):\n')
  console.error(z.prettifyError(resultado.error))
  process.exit(1)
}

export const env = resultado.data
