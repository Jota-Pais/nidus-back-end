// Define (ou troca) a senha mestra - guardada como hash em `login.senha_mestra`,
// nunca em arquivo. Uso:
//
//   npm run db:senha-mestra -- "a senha escolhida"
//
// Desativa qualquer senha mestra anterior antes de criar a nova - nunca duas
// ativas ao mesmo tempo (`login.service.ts` so olha `ativa: true`).

import { hashSenha } from '../src/modules/login/senha.ts'
import { prisma } from '../src/shared/prisma.ts'

async function main() {
  const [senha] = process.argv.slice(2)

  if (senha === undefined) {
    console.error('Uso: npm run db:senha-mestra -- "<senha>"')
    process.exitCode = 1
    return
  }

  if (senha.length < 8) {
    console.error('Senha curta demais (minimo 8 caracteres).')
    process.exitCode = 1
    return
  }

  const hash = await hashSenha(senha)

  await prisma.$transaction([
    prisma.senhaMestra.updateMany({ where: { ativa: true }, data: { ativa: false } }),
    prisma.senhaMestra.create({ data: { hashSenha: hash } }),
  ])

  console.log('Senha mestra atualizada.')
}

main()
  .catch((erro: unknown) => {
    console.error('Falhou:', erro)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
