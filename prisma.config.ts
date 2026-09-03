import 'dotenv/config'

import { defineConfig, env } from 'prisma/config'

// A partir do Prisma 7 a URL do banco sai do schema.prisma e vive aqui. Este
// arquivo so e lido pela CLI (migrate, studio, generate) - a aplicacao abre a
// conexao pelo driver adapter em src/shared/prisma.ts.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
})
