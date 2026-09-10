import 'dotenv/config'

import { defineConfig, env } from 'prisma/config'

// A partir do Prisma 7 a URL do banco sai do schema.prisma e vive aqui. Este
// arquivo so e lido pela CLI (migrate, studio, generate) - a aplicacao abre a
// conexao pelo driver adapter em src/shared/prisma.ts.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // Roda tambem depois de `migrate reset`: banco recriado ja volta com a
    // carga inicial do Anexo A, sem passo manual.
    seed: 'tsx prisma/seed.ts',
  },
  // A CLI usa a conexao DIRETA, sem -pooler: o PgBouncer da Neon quebra lock
  // consultivo e prepared statement, que o migrate precisa. No Prisma 7 o
  // datasource nao tem directUrl, entao a separacao e feita aqui. As duas
  // variaveis sao mantidas pelo `neon link`/`neon deploy` - nao editar a mao.
  datasource: {
    url: env('DATABASE_URL_UNPOOLED'),
  },
})
