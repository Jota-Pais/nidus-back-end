import { readFileSync } from 'node:fs'
import { criarApp } from './app.ts'
import { env } from './env.ts'
import { prisma } from './shared/prisma.ts'

// ../package.json resolve tanto em src/ (dev) quanto em dist/ (build).
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

const ambientePorNodeEnv = {
  development: 'desenvolvimento',
  test: 'teste',
  production: 'producao',
} as const

const app = criarApp({
  corsOrigem: env.CORS_ORIGEM,
  ambiente: ambientePorNodeEnv[env.NODE_ENV],
  versao: version,
})

const servidor = app.listen(env.PORT, () => {
  console.log(`Nidus API ouvindo em http://localhost:${env.PORT} [${env.NODE_ENV}]`)
})

// A Render manda SIGTERM ao reciclar a instancia. Fechar servidor e pool antes de sair evita
// request cortado no meio e conexao pendurada na Neon
for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sinal, () => {
    console.log(`\n${sinal} recebido, encerrando.`)
    servidor.close(() => {
      void prisma.$disconnect().then(() => process.exit(0))
    })
  })
}
