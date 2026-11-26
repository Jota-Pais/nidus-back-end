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

import { especies, estantes, salas } from './dados-iniciais.ts'
import { prisma } from '../src/shared/prisma.ts'

async function semearEspeciesELinhagens() {
  for (const especie of especies) {
    const gravada = await prisma.especie.upsert({
      where: { nome: especie.nome },
      update: {},
      create: { nome: especie.nome },
    })

    for (const { nome, cruzamento } of especie.linhagens) {
      await prisma.linhagem.upsert({
        where: { idEspecie_nome: { idEspecie: gravada.id, nome } },
        update: {},
        create: { idEspecie: gravada.id, nome, cruzamento },
      })
    }
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

/**
 * Os formatos nao sao da carga: os 4 da spec vem da migration 20261126150000_estante_com_formato.
 * A estante acha o dela pelo nome
 */
async function semearEstantes(idDaSala: Map<string, number>) {
  for (const { sala, formato, numeroVisivel } of estantes) {
    const doFormato = await prisma.formato.findFirst({ where: { nome: formato, ativo: true } })

    if (doFormato === null) {
      throw new Error(`A estante ${numeroVisivel} usa o formato ${formato}, que nao esta no banco: aplique as migrations antes.`)
    }

    const jaTem = await prisma.estante.findFirst({
      where: { idFormato: doFormato.id, numeroVisivel },
    })

    if (jaTem) continue

    const idSala = idDaSala.get(sala)

    if (idSala === undefined) {
      throw new Error(`A estante ${numeroVisivel} aponta para a ${sala}, que nao esta em salas.`)
    }

    await prisma.estante.create({
      data: { idSala, idFormato: doFormato.id, numeroVisivel },
    })
  }
}

async function conferir() {
  const [qtdEspecie, qtdLinhagem, qtdSala, qtdEstante] = await Promise.all([
    prisma.especie.count(),
    prisma.linhagem.count(),
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
    { tabela: 'sala', linhas: qtdSala, esperado: salas.length },
    { tabela: 'estante', linhas: qtdEstante, esperado: estantes.length },
  ])
  console.log('Salas com estante instalada:', salasComEstante.map((s) => s.nome).join(', '))
}

async function main() {
  await semearEspeciesELinhagens()
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
