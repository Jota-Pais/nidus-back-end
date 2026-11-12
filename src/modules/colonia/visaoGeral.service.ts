// A visao geral da colonia, no lugar do Kanban: por especie e linhagem, os casais ativos e os
// vivos, quantos mamam, quantos estao reservados, quantos estao livres e a idade dos livres. Tudo e
// contagem de colonia.animal; nada fica gravado

import { prisma } from '../../shared/prisma.ts'
import { codigoDaEspecie, dataISO, hojeISO } from '../../shared/traducao.ts'
import { diasEntre } from '../reproducao/cadeiaTemporal.ts'
import type { PorSexo } from './tipos.ts'

/**
 * As faixas de idade dos livres, em dias desde o nascimento, com os dois limites dentro. Sempre as
 * quatro e nesta ordem; 'ate' nulo e a ultima, sem teto
 */
export const FAIXAS_DE_IDADE_DOS_LIVRES = [
  { de: 0, ate: 21 },
  { de: 22, ate: 35 },
  { de: 36, ate: 60 },
  { de: 61, ate: null },
] as const

export type LivresNaFaixa = PorSexo & { de: number; ate: number | null }

/** Os livres de uma idade em dias, por sexo */
export type LivresNaIdade = PorSexo & { idade: number }

export type LinhagemNaVisaoGeral = {
  idLinhagem: number
  linhagem: string
  /** os casais ativos */
  casais: number
  vivos: PorSexo
  /** os vivos de parto que ainda nao desmamou */
  mamando: PorSexo
  /** os vivos com pedido */
  reservados: PorSexo
  /** os vivos sem pedido, os que mamam inclusive */
  livres: PorSexo
  livresPorIdade: LivresNaFaixa[]
  /** os livres por idade em dias, uma entrada por idade, da menor para a maior, sem entrada zerada */
  livresPorIdadeDias: LivresNaIdade[]
}

export type VisaoGeral = {
  especies: { codigo: string; nome: string; linhagens: LinhagemNaVisaoGeral[] }[]
}

/** Uma especie do catalogo, com todas as linhagens dela */
export type EspecieDoCatalogo = {
  nome: string
  linhagens: { id: number; nome: string; ativa: boolean }[]
}

/** Os vivos de um parto, num sexo, reservados ou nao */
export type GrupoDeVivos = {
  idLinhagem: number
  sexo: string
  reservado: boolean
  /** 'aaaa-mm-dd'; nulo so se o parto nao tiver data, e ai o grupo fica fora das faixas */
  dtNascimento: string | null
  desmamado: boolean
  qtd: number
}

const zero = (): PorSexo => ({ m: 0, f: 0 })

function somar(contagem: PorSexo, sexo: string, qtd: number) {
  if (sexo === 'M') contagem.m += qtd
  else contagem.f += qtd
}

/** A faixa da idade; a idade negativa (data de nascimento no futuro, digitada errado) cai na primeira */
function faixaDaIdade(idade: number): number {
  const dias = Math.max(0, idade)
  return FAIXAS_DE_IDADE_DOS_LIVRES.findIndex((faixa) => dias >= faixa.de && (faixa.ate === null || dias <= faixa.ate))
}

function linhagemZerada(linhagem: { id: number; nome: string }): LinhagemNaVisaoGeral {
  return {
    idLinhagem: linhagem.id,
    linhagem: linhagem.nome,
    casais: 0,
    vivos: zero(),
    mamando: zero(),
    reservados: zero(),
    livres: zero(),
    livresPorIdade: FAIXAS_DE_IDADE_DOS_LIVRES.map((faixa) => ({ de: faixa.de, ate: faixa.ate, m: 0, f: 0 })),
    livresPorIdadeDias: [],
  }
}

const temAlgo = (linhagem: LinhagemNaVisaoGeral) =>
  linhagem.casais > 0 || linhagem.vivos.m + linhagem.vivos.f > 0

/**
 * Monta a visao geral do que ja foi lido. As especies na ordem em que chegam; dentro de cada uma, as
 * linhagens ativas e as inativas que ainda tem vivo ou casal ativo, por nome
 */
export function montarVisaoGeral(
  especies: EspecieDoCatalogo[],
  casaisAtivos: Map<number, number>,
  grupos: GrupoDeVivos[],
  hoje: string = hojeISO(),
): VisaoGeral {
  return {
    especies: especies.map((especie) => {
      const linhagens = especie.linhagens.map((linhagem) => {
        const contagem = linhagemZerada(linhagem)
        contagem.casais = casaisAtivos.get(linhagem.id) ?? 0

        for (const grupo of grupos) {
          if (grupo.idLinhagem !== linhagem.id) continue

          somar(contagem.vivos, grupo.sexo, grupo.qtd)
          if (!grupo.desmamado) somar(contagem.mamando, grupo.sexo, grupo.qtd)

          if (grupo.reservado) {
            somar(contagem.reservados, grupo.sexo, grupo.qtd)
            continue
          }

          somar(contagem.livres, grupo.sexo, grupo.qtd)
          if (grupo.dtNascimento === null) continue

          const faixa = contagem.livresPorIdade[faixaDaIdade(diasEntre(grupo.dtNascimento, hoje))]
          const idade = diasEntre(grupo.dtNascimento, hoje)
          if (faixa !== undefined) somar(faixa, grupo.sexo, grupo.qtd)

          if (grupo.qtd <= 0) continue
          const dias = Math.max(0, idade)
          let naIdade = contagem.livresPorIdadeDias.find((item) => item.idade === dias)
          if (naIdade === undefined) {
            naIdade = { idade: dias, m: 0, f: 0 }
            contagem.livresPorIdadeDias.push(naIdade)
          }
          somar(naIdade, grupo.sexo, grupo.qtd)
        }

        contagem.livresPorIdadeDias.sort((a, b) => a.idade - b.idade)
        return { ativa: linhagem.ativa, contagem }
      })

      return {
        codigo: codigoDaEspecie(especie.nome),
        nome: especie.nome,
        linhagens: linhagens
          .filter(({ ativa, contagem }) => ativa || temAlgo(contagem))
          .map(({ contagem }) => contagem)
          .sort((a, b) => a.linhagem.localeCompare(b.linhagem, 'pt-BR')),
      }
    }),
  }
}

/** GET /api/visao-geral - quatro leituras: o catalogo, os casais ativos, os vivos e os partos deles */
export async function lerVisaoGeral(hoje: string = hojeISO()): Promise<VisaoGeral> {
  const [especies, casais, vivos] = await Promise.all([
    prisma.especie.findMany({
      orderBy: { id: 'asc' },
      select: { nome: true, linhagens: { select: { id: true, nome: true, ativa: true } } },
    }),
    prisma.casal.groupBy({ by: ['idLinhagem'], where: { ativo: true }, _count: { _all: true } }),
    prisma.animal.groupBy({
      by: ['idParto', 'sexo', 'idPedido'],
      where: { situacao: 'vivo' },
      _count: { _all: true },
    }),
  ])

  const partos =
    vivos.length === 0
      ? []
      : await prisma.parto.findMany({
          where: { id: { in: [...new Set(vivos.map((linha) => linha.idParto))] } },
          select: { id: true, idLinhagem: true, dtPartoReal: true, dtDesmameReal: true },
        })
  const partoPorId = new Map(partos.map((parto) => [parto.id, parto]))

  // a linhagem e a da ninhada, com casal ou sem (a do cadastro inicial)
  const grupos = vivos.flatMap((linha): GrupoDeVivos[] => {
    const parto = partoPorId.get(linha.idParto)
    if (parto === undefined) return []

    return [
      {
        idLinhagem: parto.idLinhagem,
        sexo: linha.sexo,
        reservado: linha.idPedido !== null,
        dtNascimento: parto.dtPartoReal === null ? null : dataISO(parto.dtPartoReal),
        desmamado: parto.dtDesmameReal !== null,
        qtd: linha._count._all,
      },
    ]
  })

  return montarVisaoGeral(
    especies,
    new Map(casais.map((linha) => [linha.idLinhagem, linha._count._all])),
    grupos,
    hoje,
  )
}
