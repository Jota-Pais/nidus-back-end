// Carga inicial do Nidus: grava os valores de `prisma/dados-iniciais.ts`. Os parametros
// biologicos nao vao para o banco: sao as constantes de `src/shared/parametros.ts`.
//
//   npm run db:seed
//
// IDEMPOTENTE: roda quantas vezes quiser sem duplicar nada. Onde ha unique
// natural o insert e `upsert`; onde nao ha (estante), busca pela chave natural do
// dado antes de criar.
//
// Usuarios e o projeto CEUA ficam fora daqui, em `prisma/criar-usuarios.ts`, que
// roda depois deste.

import { especies, estantes, paresGeneticos } from './dados-iniciais.ts'
import { prisma } from '../src/shared/prisma.ts'

async function semearEspeciesELinhagens() {
  for (const especie of especies) {
    const gravada = await prisma.especie.upsert({
      where: { nome: especie.nome },
      update: {},
      create: { nome: especie.nome },
    })

    for (const nome of especie.linhagens) {
      await prisma.linhagem.upsert({
        where: { idEspecie_nome: { idEspecie: gravada.id, nome } },
        update: {},
        create: { idEspecie: gravada.id, nome },
      })
    }
  }
}

async function semearParesGeneticos() {
  for (const par of paresGeneticos) {
    await prisma.grupoGeneticoPar.upsert({
      where: { grupoMacho_grupoFemea: par },
      update: {},
      create: par,
    })
  }
}

async function semearEstantes() {
  for (const estante of estantes) {
    const jaTem = await prisma.estante.findFirst({
      where: {
        fabricante: estante.fabricante,
        modelo: estante.modelo,
        numeroVisivel: estante.numeroVisivel,
      },
    })

    if (jaTem) continue

    await prisma.estante.create({
      data: {
        ...estante,
        // Derivada, e o banco cobra: CHECK estante_capacidade_derivada.
        capacidade: estante.faces * estante.linhas * estante.colunas,
      },
    })
  }
}

async function conferir() {
  const [qtdEspecie, qtdLinhagem, qtdPar, qtdEstante] = await Promise.all([
    prisma.especie.count(),
    prisma.linhagem.count(),
    prisma.grupoGeneticoPar.count(),
    prisma.estante.count(),
  ])

  const salas = await prisma.estante.findMany({
    distinct: ['sala'],
    select: { sala: true },
    orderBy: { sala: 'asc' },
  })

  console.log('Carga inicial no banco:')
  console.table([
    { tabela: 'especie', linhas: qtdEspecie, esperado: especies.length },
    {
      tabela: 'linhagem',
      linhas: qtdLinhagem,
      esperado: especies.reduce((total, e) => total + e.linhagens.length, 0),
    },
    { tabela: 'grupo_genetico_par', linhas: qtdPar, esperado: paresGeneticos.length },
    { tabela: 'estante', linhas: qtdEstante, esperado: estantes.length },
  ])
  console.log('Salas com estante instalada:', salas.map((s) => s.sala).join(', '))
}

async function main() {
  await semearEspeciesELinhagens()
  await semearParesGeneticos()
  await semearEstantes()
  await conferir()
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (erro: unknown) => {
    console.error('Carga inicial falhou:', erro)
    await prisma.$disconnect()
    process.exit(1)
  })
