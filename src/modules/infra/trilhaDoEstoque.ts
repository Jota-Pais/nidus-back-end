// A trilha dos animais que passaram pela caixa de estoque, lida nas ocorrencias: de onde vieram (a
// entrada do cadastro inicial, o nascimento quando ela era de casal, a mudanca de outra caixa, o
// animal a mais da correcao, a volta da baixa anulada) e para onde foram (a mudanca para outra
// caixa, a entrega ao pedido, a baixa). E o que a ficha da caixa liberada, sem nenhum vivo, ainda
// tem para mostrar. Uma leitura so, qualquer que seja o tamanho da trilha

import type { Prisma } from '@prisma/client'
import { prisma } from '../../shared/prisma.ts'
import { dataISO } from '../../shared/traducao.ts'
import { causaDe } from '../colonia/causa.ts'
import type { CausaDaBaixa } from '../colonia/causa.ts'
import { MOTIVO_NAO_CHEGOU_AO_DESMAME, MOTIVO_SELECAO, contarPorSexo } from '../colonia/tipos.ts'
import type { PorSexo } from '../colonia/tipos.ts'

/** Os tipos de ocorrencia que poem animais na caixa ou tiram dela */
export type TipoDaPassagem = 'entrada' | 'nascimento' | 'mudanca' | 'correcao' | 'anulacao' | 'baixa' | 'entrega'

/** O parto de onde vieram os animais da passagem: o cadastro inicial tem ordem e casal nulos */
export type OrigemDaPassagem = PorSexo & {
  idParto: number
  ordem: number | null
  casal: string | null
  dtNascimento: string | null
}

/** Uma passagem de animais pela caixa: os que chegaram ou sairam numa ocorrencia */
export type PassagemDoEstoque = PorSexo & {
  idOcorrencia: number
  dtFato: string
  sentido: 'chegada' | 'saida'
  tipo: TipoDaPassagem
  /**
   * a outra caixa: de onde vieram na mudanca e na volta da baixa anulada, para onde foram na
   * mudanca e na anulacao da baixa feita aqui. Null nas demais
   */
  outraCaixa: { id: number; codigo: string; numeroVisivel: string } | null
  /** so na entrega */
  idPedido: number | null
  /** so na baixa */
  causa: CausaDaBaixa | null
  /** o texto da baixa, da correcao e da anulacao */
  motivo: string | null
  /** os partos dos animais, pela ordem do nascimento */
  origens: OrigemDaPassagem[]
}

const caixaDaPassagem = { select: { id: true, codigo: true, estante: { select: { numeroVisivel: true } } } } as const

/** O que a trilha le de cada ocorrencia */
export const selecaoDaPassagem = {
  id: true,
  tipo: true,
  dtFato: true,
  causa: true,
  motivo: true,
  idCaixaOrigem: true,
  idCaixaDestino: true,
  idPedido: true,
  caixaOrigem: caixaDaPassagem,
  caixaDestino: caixaDaPassagem,
  animais: {
    select: {
      animal: {
        select: {
          sexo: true,
          idCaixa: true,
          situacao: true,
          idParto: true,
          parto: { select: { ordem: true, dtPartoReal: true, casal: { select: { identificacao: true } } } },
          // o animal que ja existia antes da ocorrencia nasceu ou entrou por uma destas; o a mais da
          // correcao, nao
          ocorrencias: {
            where: { ocorrencia: { tipo: { in: ['nascimento', 'entrada'] } } },
            select: { idOcorrencia: true },
            take: 1,
          },
        },
      },
    },
  },
} satisfies Prisma.OcorrenciaSelect

export type OcorrenciaDaTrilha = Prisma.OcorrenciaGetPayload<{ select: typeof selecaoDaPassagem }>
type AnimalDaTrilha = OcorrenciaDaTrilha['animais'][number]['animal']

/**
 * As ocorrencias que podem ter passado animais pela caixa. A baixa anulada nao conta (o animal nao
 * morreu); a anulacao dela, quando os animais voltaram para outra caixa, conta como a saida. A
 * entrega nao grava caixa: o animal entregue fica onde estava, e e por ele que se acha a caixa
 */
export function ondeDaTrilha(idCaixa: number): Prisma.OcorrenciaWhereInput {
  return {
    OR: [
      { tipo: { in: ['entrada', 'nascimento', 'mudanca', 'correcao', 'anulacao'] }, idCaixaDestino: idCaixa },
      { tipo: { in: ['mudanca', 'anulacao'] }, idCaixaOrigem: idCaixa },
      { tipo: 'baixa', idCaixaOrigem: idCaixa, anulacoes: { none: {} } },
      { tipo: 'entrega', animais: { some: { animal: { idCaixa } } } },
    ],
  }
}

/** Os animais da ocorrencia que passaram pela caixa, e em que sentido; null se nenhum passou */
function animaisDaPassagem(
  ocorrencia: OcorrenciaDaTrilha,
  idCaixa: number,
): { sentido: 'chegada' | 'saida'; animais: AnimalDaTrilha[] } | null {
  const tocados = ocorrencia.animais.map((ligacao) => ligacao.animal)
  const { idCaixaOrigem: origem, idCaixaDestino: destino } = ocorrencia

  switch (ocorrencia.tipo) {
    case 'entrada':
    case 'nascimento':
      return { sentido: 'chegada', animais: tocados }
    case 'correcao':
      // so os a mais, que entraram na caixa: o trocado de sexo e o anulado ja estavam na trilha
      return {
        sentido: 'chegada',
        animais: tocados.filter((animal) => animal.ocorrencias.length === 0 && animal.situacao !== 'anulado'),
      }
    case 'mudanca':
      if (origem === destino) return null
      return { sentido: destino === idCaixa ? 'chegada' : 'saida', animais: tocados }
    case 'anulacao':
      // a volta para a propria caixa da baixa desfaz uma baixa que a trilha ja nao conta
      if (destino === null || origem === destino) return null
      return { sentido: destino === idCaixa ? 'chegada' : 'saida', animais: tocados }
    case 'baixa':
      return { sentido: 'saida', animais: tocados }
    case 'entrega':
      // a entrega leva animais de varias caixas: so os desta
      return { sentido: 'saida', animais: tocados.filter((animal) => animal.idCaixa === idCaixa) }
    default:
      return null
  }
}

/** Os animais pelos partos de onde vieram, pela data do nascimento (e o parto, no empate) */
function origensDosAnimais(animais: AnimalDaTrilha[]): OrigemDaPassagem[] {
  const porParto = new Map<number, AnimalDaTrilha[]>()
  for (const animal of animais) porParto.set(animal.idParto, [...(porParto.get(animal.idParto) ?? []), animal])

  return [...porParto.entries()]
    .map(([idParto, doParto]) => {
      const { parto } = doParto[0] as AnimalDaTrilha
      return {
        idParto,
        ordem: parto.ordem,
        casal: parto.casal?.identificacao.trim() ?? null,
        dtNascimento: parto.dtPartoReal === null ? null : dataISO(parto.dtPartoReal),
        ...contarPorSexo(doParto),
      }
    })
    .sort((a, b) => (a.dtNascimento ?? '').localeCompare(b.dtNascimento ?? '') || a.idParto - b.idParto)
}

/** O motivo como a ficha mostra: o que o sistema grava sem acento vira o texto da tela */
const MOTIVO_LEGIVEL: Record<string, string> = {
  [MOTIVO_SELECAO]: 'eutanásia de seleção',
  [MOTIVO_NAO_CHEGOU_AO_DESMAME]: 'não chegou ao desmame',
}

export function motivoLegivel(motivo: string | null): string | null {
  return motivo === null ? null : (MOTIVO_LEGIVEL[motivo] ?? motivo)
}

/**
 * As passagens pela caixa a partir das ocorrencias lidas (ondeDaTrilha), pela data do fato e, no
 * mesmo dia, pela ordem do registro. A ocorrencia que nao passou nenhum animal pela caixa fica de fora
 */
export function passagensDaCaixa(ocorrencias: OcorrenciaDaTrilha[], idCaixa: number): PassagemDoEstoque[] {
  const ordenadas = [...ocorrencias].sort((a, b) => a.dtFato.getTime() - b.dtFato.getTime() || a.id - b.id)

  return ordenadas.flatMap((ocorrencia) => {
    const passagem = animaisDaPassagem(ocorrencia, idCaixa)
    if (passagem === null || passagem.animais.length === 0) return []

    const { sentido, animais } = passagem
    const tipo = ocorrencia.tipo as TipoDaPassagem
    const outra = sentido === 'chegada' ? ocorrencia.caixaOrigem : ocorrencia.caixaDestino
    const temOutraCaixa = tipo === 'mudanca' || tipo === 'anulacao'
    const temMotivo = tipo === 'baixa' || tipo === 'correcao' || tipo === 'anulacao'

    return [
      {
        idOcorrencia: ocorrencia.id,
        dtFato: dataISO(ocorrencia.dtFato),
        sentido,
        tipo,
        outraCaixa:
          temOutraCaixa && outra !== null
            ? { id: outra.id, codigo: outra.codigo, numeroVisivel: outra.estante.numeroVisivel }
            : null,
        idPedido: tipo === 'entrega' ? ocorrencia.idPedido : null,
        causa: tipo === 'baixa' ? causaDe(ocorrencia.causa) : null,
        motivo: temMotivo ? motivoLegivel(ocorrencia.motivo) : null,
        ...contarPorSexo(animais),
        origens: origensDosAnimais(animais),
      },
    ]
  })
}

/** A trilha da caixa: as passagens de animais por ela, da mais antiga para a mais recente */
export async function trilhaDaCaixa(idCaixa: number): Promise<PassagemDoEstoque[]> {
  const ocorrencias = await prisma.ocorrencia.findMany({
    where: ondeDaTrilha(idCaixa),
    orderBy: [{ dtFato: 'asc' }, { id: 'asc' }],
    select: selecaoDaPassagem,
  })

  return passagensDaCaixa(ocorrencias, idCaixa)
}
