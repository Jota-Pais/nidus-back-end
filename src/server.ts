import { readFileSync } from 'node:fs'
import { criarApp } from './app.ts'
import { env } from './env.ts'
import { recusarSemResposta } from './modules/demanda/demanda.service.ts'
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

const UMA_HORA_EM_MS = 60 * 60 * 1000

const varrerPedidosSemResposta = () => {
  recusarSemResposta().catch((erro: unknown) => {
    console.error('[pedido] a recusa dos pedidos sem resposta falhou:', erro)
  })
}

varrerPedidosSemResposta()
const varredura = setInterval(varrerPedidosSemResposta, UMA_HORA_EM_MS)

// A Render manda SIGTERM ao reciclar a instancia. Fechar servidor e pool antes de sair evita
// request cortado no meio e conexao pendurada na Neon
for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sinal, () => {
    console.log(`\n${sinal} recebido, encerrando.`)
    clearInterval(varredura)
    servidor.close(() => {
      void prisma.$disconnect().then(() => process.exit(0))
    })
  })
}
