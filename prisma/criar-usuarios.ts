// Os tres usuarios do semestre e o projeto CEUA da pesquisadora: o minimo para um banco
// novo ter login e a tela Solicitar animais ter projeto. O primeiro acesso so cria
// pesquisador, e nenhuma rota cria tecnico, gestor ou projeto, entao o caminho e este
// script, depois de `npm run db:seed`:
//
//   npm run db:usuarios
//
// So cria o que falta: usuario que ja existe (pelo e-mail) e projeto que ja existe (pelo
// numero) ficam como estao, senha inclusive. Rodar de novo nao muda nada.
//
// `hashSenha` nasce nulo: senha nunca vai em claro num script versionado. Os e-mails abaixo
// sao de exemplo, de caixas que a equipe nao controla, e o primeiro acesso so serve a conta
// com o e-mail real da pessoa: o codigo vai para quem for dono da caixa, e quem tiver a
// gestor@ufsc.br entraria como gestor. Nestas contas a senha vem de
// `npm run db:senha -- <email> "<senha>"`, e antes de ligar o envio de e-mail elas passam
// para o e-mail real ou ficam inativas.

import { prisma } from '../src/shared/prisma.ts'

const usuarios = [
  { nome: 'Beatriz Lima', email: 'pesquisador@ufsc.br', perfil: 'P' },
  { nome: 'Ana Souza', email: 'tecnico@ufsc.br', perfil: 'T' },
  { nome: 'Carlos Mendes', email: 'gestor@ufsc.br', perfil: 'G' },
]

/** O projeto da pesquisadora, vigente durante 2026 */
const projeto = {
  numero: '23080.001234/2026-11',
  titulo: 'Avaliacao de modelo experimental de hipertensao',
  responsavel: 'pesquisador@ufsc.br',
  dtVigenciaInicio: new Date('2026-01-01T00:00:00.000Z'),
  dtVigenciaFim: new Date('2026-12-31T00:00:00.000Z'),
  cotaAutorizada: 200,
  situacao: 'V',
}

async function main() {
  const resumo: { registro: string; situacao: string }[] = []

  for (const usuario of usuarios) {
    const jaTem = await prisma.usuario.findUnique({ where: { email: usuario.email } })

    if (jaTem === null) {
      await prisma.usuario.create({ data: { ...usuario, hashSenha: null } })
    }

    resumo.push({ registro: usuario.email, situacao: jaTem === null ? 'criado' : 'ja existia' })
  }

  const jaTemProjeto = await prisma.projeto.findUnique({ where: { numero: projeto.numero } })

  if (jaTemProjeto === null) {
    const { responsavel, ...dados } = projeto
    const pesquisadora = await prisma.usuario.findUniqueOrThrow({ where: { email: responsavel } })

    await prisma.projeto.create({ data: { ...dados, idUsuarioResponsavel: pesquisadora.id } })
  }

  resumo.push({ registro: `projeto ${projeto.numero}`, situacao: jaTemProjeto === null ? 'criado' : 'ja existia' })

  console.table(resumo)
}

main()
  .catch((erro: unknown) => {
    console.error('Falhou:', erro)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
