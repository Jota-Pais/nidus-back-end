// Define a senha de um usuario existente, ja como hash - nunca em claro num
// arquivo. Uso interativo, uma vez por pessoa que precisar entrar:
//
//   npm run db:senha -- tecnico@ufsc.br "a senha escolhida"
//
// Separado do seed e da massa de proposito: senha e segredo operacional, nao
// dado de carga nem de demonstracao (`prisma/massa-teste.ts` deixou os tres
// usuarios do semestre com `hashSenha` nulo exatamente para isto nao entrar
// num script versionado).

import { hashSenha } from '../src/modules/login/senha.ts'
import { prisma } from '../src/shared/prisma.ts'

async function main() {
  const [email, senha] = process.argv.slice(2)

  if (email === undefined || senha === undefined) {
    console.error('Uso: npm run db:senha -- <email> "<senha>"')
    process.exitCode = 1
    return
  }

  if (senha.length < 8) {
    console.error('Senha curta demais (minimo 8 caracteres).')
    process.exitCode = 1
    return
  }

  const hash = await hashSenha(senha)
  const atualizado = await prisma.usuario.update({ where: { email }, data: { hashSenha: hash } })

  console.log(`Senha atualizada para ${atualizado.nome} <${atualizado.email}>.`)
}

main()
  .catch((erro: unknown) => {
    console.error('Falhou:', erro)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
