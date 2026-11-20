// As caixas que sairam da estante (GET /api/caixas/liberadas): a caixa que esvaziou e foi liberada
// some da grade, mas a ficha dela continua (casais, partos, animais, ocorrencias). E a lista que
// leva a essa ficha, por especie, da liberacao mais recente para a mais antiga

import type { Prisma } from '@prisma/client'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, paraData } from '../../shared/traducao.ts'
import type { MotivoDaLiberacao, Sexo } from '../colonia/tipos.ts'

export type FiltroDasLiberadas = {
  idEspecie: number
  idLinhagem?: number | undefined
  /** parte do codigo da caixa, do numero da estante ou da identificacao do casal */
  busca?: string | undefined
  /** a liberacao a partir deste dia, 'aaaa-mm-dd' */
  de?: string | undefined
  /** a liberacao ate este dia, 'aaaa-mm-dd' */
  ate?: string | undefined
  limite: number
}

/** O casal que morou na caixa, com o que ele deu: os partos nascidos e os animais deles */
export type CasalDaLiberada = {
  id: number
  identificacao: string
  dtFormacao: string
  dtEncerramento: string | null
  motivoEncerramento: string | null
  /** quantos partos nasceram no Nidus (o fechado sem ninhada nao conta) */
  partos: number
  /** a ordem do ultimo parto nascido; null se nenhum nasceu */
  ultimoParto: number | null
  /** os animais de todos os partos do casal, menos o registro anulado */
  nascidos: number
}

/** Uma linha da lista: a caixa liberada e, na que foi de casal, os casais dela */
export type CaixaLiberada = {
  id: number
  codigo: string
  sala: string
  numeroVisivel: string
  tipo: 'casal' | 'estoque'
  /** a da caixa de estoque, ou a do casal mais recente na de casal */
  linhagem: string | null
  idLinhagem: number | null
  /** so na de estoque */
  sexo: Sexo | null
  dtLiberacao: string | null
  motivoLiberacao: MotivoDaLiberacao | null
  /** do mais recente para o mais antigo, na ordem da ficha. Vazio na de estoque que nunca foi de casal */
  casais: CasalDaLiberada[]
}

const selecaoDaLiberada = {
  id: true,
  codigo: true,
  tipo: true,
  sexo: true,
  dtLiberacao: true,
  motivoLiberacao: true,
  linhagem: { select: { id: true, nome: true } },
  estante: { select: { numeroVisivel: true, sala: { select: { nome: true } } } },
  // a mesma ordem da ficha: o casal mais recente primeiro
  casais: {
    orderBy: [{ ativo: 'desc' }, { dtFormacao: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      identificacao: true,
      dtFormacao: true,
      dtEncerramento: true,
      motivoEncerramento: true,
      linhagem: { select: { id: true, nome: true } },
      partos: { select: { id: true, ordem: true, dtPartoReal: true } },
    },
  },
} satisfies Prisma.CaixaSelect

type LiberadaLida = Prisma.CaixaGetPayload<{ select: typeof selecaoDaLiberada }>

/** O where da lista: a especie, a caixa inativa e os filtros opcionais */
export function ondeDasLiberadas(filtro: Omit<FiltroDasLiberadas, 'limite'>): Prisma.CaixaWhereInput {
  const { idLinhagem, busca, de, ate } = filtro
  const contem = (texto: string) => ({ contains: texto, mode: 'insensitive' as const })
  const e: Prisma.CaixaWhereInput[] = []

  // a linhagem e da caixa de estoque, e na de casal vem dos casais dela
  if (idLinhagem !== undefined) e.push({ OR: [{ idLinhagem }, { casais: { some: { idLinhagem } } }] })
  if (busca !== undefined) {
    e.push({
      OR: [
        { codigo: contem(busca) },
        { estante: { numeroVisivel: contem(busca) } },
        { casais: { some: { identificacao: contem(busca) } } },
      ],
    })
  }

  return {
    idEspecie: filtro.idEspecie,
    ativa: false,
    ...(de === undefined && ate === undefined
      ? {}
      : {
          dtLiberacao: {
            ...(de === undefined ? {} : { gte: paraData(de) }),
            ...(ate === undefined ? {} : { lte: paraData(ate) }),
          },
        }),
    ...(e.length === 0 ? {} : { AND: e }),
  }
}

/**
 * A linha da lista a partir da caixa lida e de quantos animais (sem o anulado) cada parto teve. A
 * linhagem da caixa de casal e a do casal mais recente, como na ficha
 */
export function linhaDaLiberada(caixa: LiberadaLida, nascidosPorParto: Map<number, number>): CaixaLiberada {
  const deEstoque = caixa.tipo === 'estoque'
  const linhagem = deEstoque ? caixa.linhagem : (caixa.casais[0]?.linhagem ?? caixa.linhagem)

  return {
    id: caixa.id,
    codigo: caixa.codigo,
    sala: caixa.estante.sala.nome,
    numeroVisivel: caixa.estante.numeroVisivel,
    tipo: deEstoque ? 'estoque' : 'casal',
    linhagem: linhagem?.nome ?? null,
    idLinhagem: linhagem?.id ?? null,
    sexo: deEstoque ? ((caixa.sexo === 'M' ? 'M' : 'F') as Sexo) : null,
    dtLiberacao: caixa.dtLiberacao === null ? null : dataISO(caixa.dtLiberacao),
    motivoLiberacao: caixa.motivoLiberacao as MotivoDaLiberacao | null,
    casais: caixa.casais.map((casal) => {
      const nascidos = casal.partos.filter((parto) => parto.dtPartoReal !== null)
      const ordens = nascidos.flatMap((parto) => (parto.ordem === null ? [] : [parto.ordem]))

      return {
        id: casal.id,
        identificacao: casal.identificacao.trim(),
        dtFormacao: dataISO(casal.dtFormacao),
        dtEncerramento: casal.dtEncerramento === null ? null : dataISO(casal.dtEncerramento),
        motivoEncerramento: casal.motivoEncerramento,
        partos: nascidos.length,
        ultimoParto: ordens.length === 0 ? null : Math.max(...ordens),
        nascidos: casal.partos.reduce((soma, parto) => soma + (nascidosPorParto.get(parto.id) ?? 0), 0),
      }
    }),
  }
}

/** Quantos animais cada parto teve, menos o registro anulado: uma leitura para todos os partos */
async function nascidosDosPartos(idsPartos: number[]): Promise<Map<number, number>> {
  if (idsPartos.length === 0) return new Map()

  const linhas = await prisma.animal.groupBy({
    by: ['idParto'],
    where: { idParto: { in: idsPartos }, situacao: { not: 'anulado' } },
    _count: { _all: true },
  })

  return new Map(linhas.map((linha) => [linha.idParto, linha._count._all]))
}

/**
 * GET /api/caixas/liberadas - as caixas liberadas da especie, da liberacao mais recente para a mais
 * antiga, no maximo 'limite'. temMais diz se ha outras depois delas. Duas leituras, qualquer que
 * seja o tamanho da lista: as caixas com os casais e partos, e a contagem dos animais por parto
 */
export async function listarLiberadas(filtro: FiltroDasLiberadas) {
  const lidas = await prisma.caixa.findMany({
    where: ondeDasLiberadas(filtro),
    orderBy: [{ dtLiberacao: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    // uma a mais so para saber se ha outras
    take: filtro.limite + 1,
    select: selecaoDaLiberada,
  })

  const caixas = lidas.slice(0, filtro.limite)
  const idsPartos = caixas.flatMap((caixa) => caixa.casais.flatMap((casal) => casal.partos.map((parto) => parto.id)))
  const nascidos = await nascidosDosPartos(idsPartos)

  return {
    caixas: caixas.map((caixa) => linhaDaLiberada(caixa, nascidos)),
    temMais: lidas.length > filtro.limite,
  }
}
