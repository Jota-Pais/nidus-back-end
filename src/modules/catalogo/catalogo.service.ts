// Secao 4 do contrato: todo o dado de referencia numa chamada so.
//
// Sao os dados do Anexo A - carga inicial que quase nunca muda (RNF-05). O
// front chama uma vez no boot e cacheia com `staleTime` longo, entao o custo
// aqui e uma vez por sessao, nao por tela.
//
// As seis consultas saem em paralelo: nao dependem uma da outra e o free tier
// da Neon cobra latencia de rede, nao CPU - serializar isto seria somar seis
// RTTs sem motivo.

import { prisma } from '../../shared/prisma.ts'
import { codigoDaEspecie, dataISO } from '../../shared/traducao.ts'

export async function montarCatalogo() {
  const [especies, salas, pares, parametros, tolerancias, modelos] = await Promise.all([
    prisma.especie.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        nome: true,
        nomeCientifico: true,
        linhagens: {
          orderBy: { id: 'asc' },
          select: { id: true, nome: true, ativa: true },
        },
      },
    }),

    // Nao existe tabela `sala` no MVP (entra na fase 2): a sala e coluna da
    // estante, e a lista sai do que esta instalado.
    prisma.estante.findMany({
      where: { ativa: true },
      distinct: ['sala'],
      orderBy: { sala: 'asc' },
      select: { sala: true },
    }),

    prisma.grupoGeneticoPar.findMany({
      where: { ativo: true },
      orderBy: [{ grupoMacho: 'asc' }, { grupoFemea: 'asc' }],
      select: { grupoMacho: true, grupoFemea: true },
    }),

    // Vigente = sem data de fim (RN-01: o parametro e versionado, e o passado
    // continua no banco para o calculo antigo seguir reproduzivel).
    prisma.parametroBiologico.findMany({
      where: { dtVigenciaFim: null },
      orderBy: [{ idEspecie: 'asc' }, { idLinhagem: 'asc' }],
    }),

    prisma.toleranciaIdade.findMany({
      where: { dtVigenciaFim: null },
      orderBy: { idadeMinDias: 'asc' },
      select: { idadeMinDias: true, idadeMaxDias: true, variacaoDias: true },
    }),

    // Modelo de estante tambem nao e tabela no MVP: os quatro modelos sao as
    // topologias distintas ja cadastradas. RF-INF-01 - um quinto entra por
    // cadastro, nao por deploy.
    prisma.estante.findMany({
      distinct: ['fabricante', 'modelo'],
      orderBy: [{ fabricante: 'asc' }, { modelo: 'asc' }],
      select: {
        fabricante: true,
        modelo: true,
        faces: true,
        linhas: true,
        colunas: true,
        capacidade: true,
      },
    }),
  ])

  return {
    especies: especies.map((especie) => ({
      id: especie.id,
      codigo: codigoDaEspecie(especie.nome),
      nome: especie.nome,
      nomeCientifico: especie.nomeCientifico,
      linhagens: especie.linhagens,
    })),
    salas: salas.map((estante) => estante.sala),
    paresGeneticos: pares,
    parametrosBiologicos: parametros.map((parametro) => ({
      idEspecie: parametro.idEspecie,
      idLinhagem: parametro.idLinhagem,
      gestacaoDias: parametro.gestacaoDias,
      aleitamentoDias: parametro.aleitamentoDias,
      intervaloCicloDias: parametro.intervaloCicloDias,
      maxPartoCasal: parametro.maxPartoCasal,
      expectativaM: parametro.expectativaM,
      expectativaF: parametro.expectativaF,
      dtVigenciaInicio: dataISO(parametro.dtVigenciaInicio),
      dtVigenciaFim: parametro.dtVigenciaFim === null ? null : dataISO(parametro.dtVigenciaFim),
    })),
    toleranciasIdade: tolerancias,
    modelosEstante: modelos,
  }
}
