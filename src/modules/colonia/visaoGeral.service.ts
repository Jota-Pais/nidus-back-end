// A visao geral da colonia, no lugar do Kanban: por especie e linhagem, os casais ativos e os
// vivos, quantos mamam, quantos estao reservados, quantos estao livres e a idade dos livres, e, desde
// o inicio, as baixas do aleitamento (o ajuste de ninhada e a morte no aleitamento) sobre os
// nascidos. Tudo e contagem de colonia.animal e da trilha; nada fica gravado

import { prisma } from '../../shared/prisma.ts'
import { codigoDaEspecie, dataISO, hojeISO } from '../../shared/traducao.ts'
import { diasEntre } from '../reproducao/cadeiaTemporal.ts'
import { causaDe, contarBaixasDoAleitamento } from './causa.ts'
import type { MortoDaBaixa } from './causa.ts'
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
  /** desde o inicio, sem periodo: as baixas do aleitamento e os nascidos de onde elas sairam */
  aleitamento: AleitamentoDaLinhagem
}

/**
 * As baixas do aleitamento da linhagem desde o inicio, e a base da porcentagem: os nascidos de partos
 * registrados no Nidus (de casal; o cadastro inicial chegou desmamado e fica fora), sem o registro
 * anulado
 */
export type AleitamentoDaLinhagem = {
  nascidos: number
  /** as eutanasias no aleitamento (a selecao) */
  ajusteDeNinhada: number
  /** as mortes no aleitamento ('nao chegou ao desmame' inclusive) */
  mortesNoAleitamento: number
}

/** O que a leitura traz para o aleitamento: os nascidos por linhagem e os mortos de parto de casal */
export type AleitamentoLido = {
  nascidos: Map<number, number>
  mortos: (MortoDaBaixa & { idLinhagem: number })[]
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
    aleitamento: { nascidos: 0, ajusteDeNinhada: 0, mortesNoAleitamento: 0 },
  }
}

/** As baixas do aleitamento da linhagem, sobre os nascidos dela */
function aleitamentoDaLinhagem(idLinhagem: number, lido: AleitamentoLido): AleitamentoDaLinhagem {
  const { ajusteDeNinhada, mortesNoAleitamento } = contarBaixasDoAleitamento(
    lido.mortos.filter((morto) => morto.idLinhagem === idLinhagem),
  )

  return {
    nascidos: lido.nascidos.get(idLinhagem) ?? 0,
    ajusteDeNinhada: ajusteDeNinhada.m + ajusteDeNinhada.f,
    mortesNoAleitamento: mortesNoAleitamento.m + mortesNoAleitamento.f,
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
  aleitamento: AleitamentoLido = { nascidos: new Map(), mortos: [] },
): VisaoGeral {
  return {
    especies: especies.map((especie) => {
      const linhagens = especie.linhagens.map((linhagem) => {
        const contagem = linhagemZerada(linhagem)
        contagem.casais = casaisAtivos.get(linhagem.id) ?? 0
        contagem.aleitamento = aleitamentoDaLinhagem(linhagem.id, aleitamento)

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

/**
 * Os nascidos de partos de casal por linhagem (sem o registro anulado), e os mortos deles com a causa
 * da baixa que nao foi anulada: o que o aleitamento da visao geral conta
 */
async function lerAleitamento(): Promise<AleitamentoLido> {
  const [partos, ligacoes] = await Promise.all([
    prisma.parto.findMany({
      where: { idCasal: { not: null }, dtPartoReal: { not: null } },
      select: { idLinhagem: true, _count: { select: { animais: { where: { situacao: { not: 'anulado' } } } } } },
    }),
    prisma.ocorrenciaAnimal.findMany({
      where: {
        ocorrencia: { tipo: 'baixa', anulacoes: { none: {} } },
        animal: { situacao: 'morto', parto: { idCasal: { not: null } } },
      },
      select: {
        ocorrencia: { select: { causa: true } },
        animal: { select: { sexo: true, dtSaida: true, parto: { select: { idLinhagem: true, dtDesmameReal: true } } } },
      },
    }),
  ])

  const nascidos = new Map<number, number>()
  for (const parto of partos) {
    nascidos.set(parto.idLinhagem, (nascidos.get(parto.idLinhagem) ?? 0) + parto._count.animais)
  }

  return {
    nascidos,
    mortos: ligacoes.flatMap(({ ocorrencia, animal }) =>
      animal.dtSaida === null
        ? []
        : [
            {
              idLinhagem: animal.parto.idLinhagem,
              sexo: animal.sexo,
              dtSaida: animal.dtSaida,
              causa: causaDe(ocorrencia.causa),
              parto: { comCasal: true, dtDesmameReal: animal.parto.dtDesmameReal },
            },
          ],
    ),
  }
}

/**
 * GET /api/visao-geral - o catalogo, os casais ativos, os vivos e os partos deles, e o aleitamento
 * (os nascidos e as baixas de parto de casal)
 */
export async function lerVisaoGeral(hoje: string = hojeISO()): Promise<VisaoGeral> {
  const [especies, casais, vivos, aleitamento] = await Promise.all([
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
    lerAleitamento(),
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
    aleitamento,
  )
}
