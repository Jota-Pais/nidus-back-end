import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      // O `env.ts` valida a configuracao no boot e derruba o processo se ela
      // estiver errada - decisao boa e que fica como esta. O efeito colateral e
      // que importar QUALQUER modulo que chegue ao Prisma exige a variavel, e
      // em CI (e em clone novo) nao existe `.env`: o `vitest` morria no import,
      // antes de rodar teste nenhum.
      //
      // Este valor e so para satisfazer a validacao. Nenhum teste desta suite
      // abre conexao - quem precisa de banco de verdade e teste de integracao,
      // que le a URL do ambiente e nao daqui.
      DATABASE_URL: 'postgresql://placeholder/nidus-testes',
      NODE_ENV: 'test',
    },
  },
})
