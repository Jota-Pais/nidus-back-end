// secao 5 do contrato: estantes, grade de ocupacao e cadastro.

import { Prisma } from '@prisma/client'
import { naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import {
  codigoDaEspecie,
  dataISO,
  estadoCaixa,
  face as faceDic,
  finalidadeCaixa,
  hojeISO,
} from '../../shared/traducao.ts'
import { codigoDaPosicao } from './endereco.ts'
import { calcularProximoEvento } from './proximoEvento.ts'

/** O objeto 'estante' da lista e do cadastro (contrato secao 5) */
function comTopologia(estante: {
  id: number
  sala: string
  fabricante: string
  modelo: string
  numeroVisivel: string
  faces: number
  linhas: number
  colunas: number
  capacidade: number
}) {
  return {
    id: estante.id,
    sala: estante.sala,
    fabricante: estante.fabricante,
    modelo: estante.modelo,
    numeroVisivel: estante.numeroVisivel,
    topologia: {
      faces: estante.faces,
      linhas: estante.linhas,
      colunas: estante.colunas,
      capacidade: estante.capacidade,
    },
  }
}

/** Resolve '?especie=rato' no id da especie. Tabela de 2 linhas no Anexo A */
export async function idDaEspecie(codigo: string): Promise<number> {
  const especies = await prisma.especie.findMany({ select: { id: true, nome: true } })
  const achada = especies.find((especie) => codigoDaEspecie(especie.nome) === codigo)

  if (achada === undefined) {
    throw naoEncontrado(`Especie ${codigo}`)
  }

  return achada.id
}

export type FiltroDeEstantes = {
  sala?: string | undefined
  especie?: string | undefined
}

export async function listarEstantes({ sala, especie }: FiltroDeEstantes = {}) {
  // Filtrar por especie e filtrar a ESTANTE pelo que ela abriga: RF-CIC-01 segrega
  // por especie e a estante entra se tiver ao menos uma caixa ativa daquela especie
  const where: Prisma.EstanteWhereInput = {
    ...(sala === undefined ? {} : { sala }),
    ...(especie === undefined
      ? {}
      : { caixas: { some: { ativa: true, idEspecie: await idDaEspecie(especie) } } }),
  }

  const estantes = await prisma.estante.findMany({
    where,
    orderBy: [{ sala: 'asc' }, { numeroVisivel: 'asc' }],
  })

  if (estantes.length === 0) {
    return { estantes: [] }
  }

  const ocupacaoPorEstante = await prisma.caixa.groupBy({
    by: ['idEstante'],
    where: { ativa: true, idEstante: { in: estantes.map((estante) => estante.id) } },
    _count: { _all: true },
  })

  const ocupadas = new Map(
    ocupacaoPorEstante.map((linha) => [linha.idEstante, linha._count._all]),
  )

  return {
    estantes: estantes.map((estante) => {
      const ocupada = ocupadas.get(estante.id) ?? 0

      return {
        ...comTopologia(estante),
        // RF-INF-06: capacidade instalada, ocupada e livre
        ocupacao: {
          capacidade: estante.capacidade,
          ocupada,
          livre: estante.capacidade - ocupada,
        },
        ativa: estante.ativa,
      }
    }),
  }
}

export async function montarGrade(id: number, agora: Date = new Date()) {
  const hoje = hojeISO(agora)

  const [estante, caixas, parametros] = await Promise.all([
    prisma.estante.findUnique({ where: { id } }),

    prisma.caixa.findMany({
      where: { idEstante: id, ativa: true },
      orderBy: [{ face: 'asc' }, { linha: 'asc' }, { coluna: 'asc' }],
      select: {
        id: true,
        face: true,
        linha: true,
        coluna: true,
        finalidade: true,
        estado: true,
        idEspecie: true,
        especie: { select: { nome: true } },
        casais: {
          // O casal corrente e o ultimo formado. Trazer 1 em vez de filtrar por ativo de
          // proposito: a caixa que acabou de encerrar o casal ainda guarda animais daquela
          // linhagem, e o contrato pede a linhagem da caixa - mas casal na resposta so
          // vale se estiver ativo
          orderBy: { dtFormacao: 'desc' },
          take: 1,
          select: {
            id: true,
            identificacao: true,
            ativo: true,
            linhagem: { select: { nome: true } },
            partos: {
              // Ciclo corrente: o de maior ordem. RN-04 limita a 5
              orderBy: { ordem: 'desc' },
              take: 1,
              select: {
                ordem: true,
                dtPartoPrevisto: true,
                dtPartoReal: true,
                dtDesmamePrevisto: true,
                dtDesmameReal: true,
              },
            },
          },
        },
      },
    }),

    prisma.parametroBiologico.findMany({
      where: { dtVigenciaFim: null, idLinhagem: null },
      select: {
        idEspecie: true,
        maxPartoCasal: true,
        intervaloCicloDias: true,
      },
    }),
  ])

  if (estante === null) {
    throw naoEncontrado('Estante')
  }

  const parametroPorEspecie = new Map(parametros.map((p) => [p.idEspecie, p]))

  // indexar por endereco antes de gerar a grade: a busca vira O(1) por posicao, em vez de
  // varrer a lista de caixas para cada uma das 128.
  const caixaPorEndereco = new Map(
    caixas.map((caixa) => [`${caixa.face}:${caixa.linha}:${caixa.coluna}`, caixa]),
  )

  type CaixaDaGrade = (typeof caixas)[number]

  const conteudoDaPosicao = (caixa: CaixaDaGrade) => {
    const casal = caixa.casais[0]
    const ciclo = casal?.partos[0]
    const parametro = parametroPorEspecie.get(caixa.idEspecie)

    return {
      id: caixa.id,
      especie: codigoDaEspecie(caixa.especie.nome),
      // vem do casal - infra.caixa nao tem linhagem no MVP. null na caixa que nunca
      // teve casal, conforme a secao 1 do contrato (ausencia e sempre null explicito,
      // nunca string vazia).
      linhagem: casal?.linhagem.nome ?? null,
      finalidade: finalidadeCaixa.paraApi(caixa.finalidade),
      estado: estadoCaixa.paraApi(caixa.estado),
      casal:
        casal === undefined || !casal.ativo
          ? null
          : {
              id: casal.id,
              identificacao: casal.identificacao.trim(),
              cicloAtual: ciclo?.ordem ?? 0,
              maxCiclos: parametro?.maxPartoCasal ?? 5,
            },
      proximoEvento:
        casal === undefined || !casal.ativo
          ? null
          : calcularProximoEvento(
              ciclo === undefined
                ? undefined
                : {
                    ordem: ciclo.ordem,
                    dtPartoPrevisto: dataISO(ciclo.dtPartoPrevisto),
                    dtPartoReal: ciclo.dtPartoReal === null ? null : dataISO(ciclo.dtPartoReal),
                    dtDesmamePrevisto: dataISO(ciclo.dtDesmamePrevisto),
                    dtDesmameReal:
                      ciclo.dtDesmameReal === null ? null : dataISO(ciclo.dtDesmameReal),
                  },
              {
                maxCiclos: parametro?.maxPartoCasal ?? 5,
                intervaloCicloDias: parametro?.intervaloCicloDias ?? 6,
                hoje,
              },
            ),
    }
  }

  const faces = Array.from({ length: estante.faces }, (_, indice) => {
    const numeroDaFace = indice + 1
    const posicoes = []

    // ordem linha-major, como o contrato promete: todas as colunas da linha 1, depois da linha
    // 2. O front agrupa pelo campo 'linha' de qualquer forma, mas a promessa e da API.
    for (let linha = 1; linha <= estante.linhas; linha += 1) {
      for (let coluna = 1; coluna <= estante.colunas; coluna += 1) {
        const caixa = caixaPorEndereco.get(`${numeroDaFace}:${linha}:${coluna}`)

        posicoes.push({
          linha,
          coluna,
          codigo: codigoDaPosicao(numeroDaFace, linha, coluna, estante.colunas),
          caixa: caixa === undefined ? null : conteudoDaPosicao(caixa),
        })
      }
    }

    return {
      face: faceDic.paraApi(String(numeroDaFace)),
      linhas: estante.linhas,
      colunas: estante.colunas,
      posicoes,
    }
  })

  return { estante: comTopologia(estante), faces }
}

export type NovaEstante = {
  sala: string
  fabricante: string
  modelo: string
  numeroVisivel: string
  faces: number
  linhas: number
  colunas: number
}

/**
 * 'capacidade' e derivada da topologia e nunca vem do cliente (contrato secao 5). O banco
 * cobra o mesmo no CHECK 'estante_capacidade_derivada' - esta e a mesma conta, do lado de
 * fora, para a resposta sair certa sem reler a linha.
 */
export function capacidadeDerivada(faces: number, linhas: number, colunas: number): number {
  return faces * linhas * colunas
}

export async function cadastrarEstante(dados: NovaEstante) {
  const criada = await prisma.estante.create({
    data: {
      ...dados,
      capacidade: capacidadeDerivada(dados.faces, dados.linhas, dados.colunas),
    },
  })

  return {
    ...comTopologia(criada),
    ocupacao: { capacidade: criada.capacidade, ocupada: 0, livre: criada.capacidade },
    ativa: criada.ativa,
  }
}
