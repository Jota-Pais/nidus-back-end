// Carga inicial do Nidus: grava os valores de `prisma/dados-iniciais.ts`. Os parametros
// biologicos nao vao para o banco: sao as constantes de `src/shared/parametros.ts`.
//
//   npm run db:seed
//
// IDEMPOTENTE: roda quantas vezes quiser sem duplicar nada. Onde ha unique
// natural o insert e `upsert`; onde nao ha (sala e estante), busca pela chave natural
// do dado antes de criar.
//
// Usuarios e o projeto CEUA ficam fora daqui, em `prisma/criar-usuarios.ts`, que
// roda depois deste.

import { especies, estantes, paresGeneticos, salas } from './dados-iniciais.ts'
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

/** Devolve o id de cada sala pelo nome, para as estantes apontarem para ela */
async function semearSalas() {
  const idDaSala = new Map<string, number>()

  for (const nome of salas) {
    const jaTem = await prisma.sala.findFirst({ where: { nome }, orderBy: { id: 'asc' } })
    const sala = jaTem ?? (await prisma.sala.create({ data: { nome } }))

    idDaSala.set(nome, sala.id)
  }

  return idDaSala
}

async function semearEstantes(idDaSala: Map<string, number>) {
  for (const { sala, ...estante } of estantes) {
    const jaTem = await prisma.estante.findFirst({
      where: {
        fabricante: estante.fabricante,
        modelo: estante.modelo,
        numeroVisivel: estante.numeroVisivel,
      },
    })

    if (jaTem) continue

    const idSala = idDaSala.get(sala)

    if (idSala === undefined) {
      throw new Error(`A estante ${estante.numeroVisivel} aponta para a ${sala}, que nao esta em salas.`)
    }

    await prisma.estante.create({
      data: {
        ...estante,
        idSala,
        // Derivada, e o banco cobra: CHECK estante_capacidade_derivada.
        capacidade: estante.faces * estante.linhas * estante.colunas,
      },
    })
  }
}

async function conferir() {
  const [qtdEspecie, qtdLinhagem, qtdPar, qtdSala, qtdEstante] = await Promise.all([
    prisma.especie.count(),
    prisma.linhagem.count(),
    prisma.grupoGeneticoPar.count(),
    prisma.sala.count(),
    prisma.estante.count(),
  ])

  const salasComEstante = await prisma.sala.findMany({
    where: { ativa: true, estantes: { some: { ativa: true } } },
    select: { nome: true },
    orderBy: { nome: 'asc' },
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
    { tabela: 'sala', linhas: qtdSala, esperado: salas.length },
    { tabela: 'estante', linhas: qtdEstante, esperado: estantes.length },
  ])
  console.log('Salas com estante instalada:', salasComEstante.map((s) => s.nome).join(', '))
}

async function main() {
  await semearEspeciesELinhagens()
  await semearParesGeneticos()
  await semearEstantes(await semearSalas())
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
