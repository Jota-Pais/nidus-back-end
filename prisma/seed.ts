// Carga inicial do Nidus: grava os valores de `prisma/dados-iniciais.ts`.
//
//   npm run db:seed
//
// IDEMPOTENTE: roda quantas vezes quiser sem duplicar nada. Onde ha unique
// natural o insert e `upsert`; onde nao ha (parametro, tolerancia e estante),
// busca pela chave natural do dado antes de criar.
//
// Usuarios e o projeto CEUA ficam fora daqui, em `prisma/criar-usuarios.ts`, que
// roda depois deste.

import {
  especies,
  estantes,
  inicioVigencia,
  paresGeneticos,
  parametrosBiologicos,
  toleranciasIdade,
} from './dados-iniciais.ts'
import { prisma } from '../src/shared/prisma.ts'

async function semearEspeciesELinhagens() {
  for (const especie of especies) {
    const gravada = await prisma.especie.upsert({
      where: { nome: especie.nome },
      update: { nomeCientifico: especie.nomeCientifico },
      create: { nome: especie.nome, nomeCientifico: especie.nomeCientifico },
    })

    for (const nome of especie.linhagens) {
      await prisma.linhagem.upsert({
        where: { idEspecie_nome: { idEspecie: gravada.id, nome } },
        update: {},
        create: { idEspecie: gravada.id, nome },
      })
    }

    // Um parametro por especie, valendo para todas as linhagens dela.
    const jaTem = await prisma.parametroBiologico.findFirst({
      where: {
        idEspecie: gravada.id,
        idLinhagem: null,
        dtVigenciaInicio: inicioVigencia,
      },
    })

    if (!jaTem) {
      await prisma.parametroBiologico.create({
        data: {
          idEspecie: gravada.id,
          idLinhagem: null,
          ...parametrosBiologicos,
          dtVigenciaInicio: inicioVigencia,
          dtVigenciaFim: null,
        },
      })
    }
  }
}

async function semearToleranciaIdade() {
  for (const faixa of toleranciasIdade) {
    const jaTem = await prisma.toleranciaIdade.findFirst({
      where: { idadeMinDias: faixa.idadeMinDias, dtVigenciaInicio: inicioVigencia },
    })

    if (!jaTem) {
      await prisma.toleranciaIdade.create({
        data: { ...faixa, dtVigenciaInicio: inicioVigencia, dtVigenciaFim: null },
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
  const [qtdEspecie, qtdLinhagem, qtdParametro, qtdTolerancia, qtdPar, qtdEstante] =
    await Promise.all([
      prisma.especie.count(),
      prisma.linhagem.count(),
      prisma.parametroBiologico.count(),
      prisma.toleranciaIdade.count(),
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
    { tabela: 'parametro_biologico', linhas: qtdParametro, esperado: especies.length },
    { tabela: 'tolerancia_idade', linhas: qtdTolerancia, esperado: toleranciasIdade.length },
    { tabela: 'grupo_genetico_par', linhas: qtdPar, esperado: paresGeneticos.length },
    { tabela: 'estante', linhas: qtdEstante, esperado: estantes.length },
  ])
  console.log('Salas com estante instalada:', salas.map((s) => s.sala).join(', '))
}

async function main() {
  await semearEspeciesELinhagens()
  await semearToleranciaIdade()
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
