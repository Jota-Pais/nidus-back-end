import { defineConfig } from 'vitest/config'
import unitaria, { SUITES_DE_BANCO } from './vitest.config.ts'

// Os testes de integracao (*.banco.test.ts): os triggers, os CHECKs e os servicos contra um banco
// ja migrado, apontado por DATABASE_URL_TESTE (um branch de teste da Neon ou um Postgres local,
// nunca a producao). Sem a variavel, as suites ficam de fora (skip).
//
//   DATABASE_URL_TESTE="postgresql://..." npm run test:banco
//
// Cada suite abre uma transacao e a desfaz no fim; a da reserva concorrente grava o proprio mundo e
// o apaga no fim. Rodam uma de cada vez: o banco e um so, e a latencia da Neon pede tempo de sobra.

export default defineConfig({
  test: {
    ...unitaria.test,
    include: [SUITES_DE_BANCO],
    exclude: ['**/node_modules/**'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
})
