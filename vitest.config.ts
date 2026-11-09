import { configDefaults, defineConfig } from 'vitest/config'

/** Os testes de integracao, contra um banco de verdade: rodam so pelo vitest.banco.config.ts */
export const SUITES_DE_BANCO = 'src/**/*.banco.test.ts'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, SUITES_DE_BANCO],
    env: {
      // O `env.ts` valida a configuracao no boot e derruba o processo se ela
      // estiver errada - decisao boa e que fica como esta. O efeito colateral e
      // que importar QUALQUER modulo que chegue ao Prisma exige a variavel, e
      // em CI (e em clone novo) nao existe `.env`: o `vitest` morria no import,
      // antes de rodar teste nenhum.
      //
      // Este valor e so para satisfazer a validacao. Nenhum teste abre conexao
      // por ele - quem precisa de banco de verdade e teste de integracao
      // (*.banco.test.ts, `npm run test:banco`), que le DATABASE_URL_TESTE do
      // ambiente e nao daqui.
      DATABASE_URL: 'postgresql://placeholder/nidus-testes',
      NODE_ENV: 'test',
    },
  },
})
