// As leituras de vivos que as operacoes e as telas repetem: por caixa, por parto e por pedido.
// Tudo e contagem de colonia.animal; nenhum numero fica gravado.

import type { Prisma } from '@prisma/client'
import { dataISO } from '../../shared/traducao.ts'
import { faltaDaReserva, temFalta } from './reserva.ts'
import type { FaltaDaReserva, SituacaoDoPedido } from './reserva.ts'
import type { PorSexo, Sexo } from './tipos.ts'

type Leitura = Pick<Prisma.TransactionClient, 'animal' | 'parto' | 'pedido'>

function contar(linhas: { sexo: string; _count: { _all: number } }[]): PorSexo {
  return linhas.reduce(
    (soma, linha) =>
      linha.sexo === 'M' ? { ...soma, m: soma.m + linha._count._all } : { ...soma, f: soma.f + linha._count._all },
    { m: 0, f: 0 },
  )
}

// ------------------------------------------------------------ por caixa

/** Os vivos de um parto dentro de uma caixa: a menor parte que as telas mostram */
export type VivosDoParto = {
  idParto: number
  ordem: number
  /** a identificacao do casal que teve o parto */
  casal: string
  idLinhagem: number
  /** 'aaaa-mm-dd' */
  dtNascimento: string
  desmamado: boolean
  /** a caixa do casal, de onde a ninhada saiu (ou onde ainda esta) */
  caixaDoCasal: { idCaixa: number; codigo: string; numeroVisivel: string }
  vivos: PorSexo
  reservados: PorSexo
}

/** O que esta vivo numa caixa: o total, os reservados, por parto e por pedido */
export type VivosNaCaixa = {
  vivos: PorSexo
  reservados: PorSexo
  /** do nascimento mais antigo para o mais novo */
  partos: VivosDoParto[]
  /** os reservados de cada pedido nesta caixa, em ordem de pedido */
  pedidos: (PorSexo & { idPedido: number })[]
}

/** A caixa sem vivo nenhum */
export const semVivos = (): VivosNaCaixa => ({ vivos: { m: 0, f: 0 }, reservados: { m: 0, f: 0 }, partos: [], pedidos: [] })

function somarNo(contagem: PorSexo, sexo: string, qtd: number): void {
  if (sexo === 'M') contagem.m += qtd
  else contagem.f += qtd
}

/**
 * Os vivos de cada caixa, numa leitura so: o total e os reservados por sexo, por parto de origem
 * e por pedido. E de onde a grade, o card e as fichas tiram os numeros. Caixa sem vivo
 * fica zerada
 */
export async function vivosNasCaixas(banco: Leitura, idsCaixa: number[]): Promise<Map<number, VivosNaCaixa>> {
  const porCaixa = new Map<number, VivosNaCaixa>(idsCaixa.map((id) => [id, semVivos()]))
  if (idsCaixa.length === 0) return porCaixa

  const linhas = await banco.animal.groupBy({
    by: ['idCaixa', 'idParto', 'sexo', 'idPedido'],
    where: { idCaixa: { in: idsCaixa }, situacao: 'vivo' },
    _count: { _all: true },
  })
  if (linhas.length === 0) return porCaixa

  const partos = await banco.parto.findMany({
    where: { id: { in: [...new Set(linhas.map((linha) => linha.idParto))] } },
    orderBy: [{ dtPartoReal: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      ordem: true,
      dtPartoReal: true,
      dtDesmameReal: true,
      casal: {
        select: {
          identificacao: true,
          idLinhagem: true,
          caixa: { select: { id: true, codigo: true, estante: { select: { numeroVisivel: true } } } },
        },
      },
    },
  })

  for (const [idCaixa, caixa] of porCaixa) {
    const daCaixa = linhas.filter((linha) => linha.idCaixa === idCaixa)
    const pedidos = new Map<number, PorSexo>()

    for (const linha of daCaixa) {
      somarNo(caixa.vivos, linha.sexo, linha._count._all)
      if (linha.idPedido === null) continue

      somarNo(caixa.reservados, linha.sexo, linha._count._all)
      const doPedido = pedidos.get(linha.idPedido) ?? { m: 0, f: 0 }
      somarNo(doPedido, linha.sexo, linha._count._all)
      pedidos.set(linha.idPedido, doPedido)
    }

    caixa.pedidos = [...pedidos.entries()]
      .sort(([a], [b]) => a - b)
      .map(([idPedido, qtd]) => ({ idPedido, ...qtd }))

    caixa.partos = partos.flatMap((parto) => {
      const doParto = daCaixa.filter((linha) => linha.idParto === parto.id)
      if (doParto.length === 0 || parto.dtPartoReal === null) return []

      return [
        {
          idParto: parto.id,
          ordem: parto.ordem,
          casal: parto.casal.identificacao.trim(),
          idLinhagem: parto.casal.idLinhagem,
          dtNascimento: dataISO(parto.dtPartoReal),
          desmamado: parto.dtDesmameReal !== null,
          caixaDoCasal: {
            idCaixa: parto.casal.caixa.id,
            codigo: parto.casal.caixa.codigo,
            numeroVisivel: parto.casal.caixa.estante.numeroVisivel,
          },
          vivos: contar(doParto),
          reservados: contar(doParto.filter((linha) => linha.idPedido !== null)),
        },
      ]
    })
  }

  return porCaixa
}

/** Uma ninhada que ainda esta numa caixa: os vivos de um parto, mamando ou desmamados */
export type NinhadaNaCaixa = {
  idParto: number
  ordem: number
  casal: string
  m: number
  f: number
  desmamado: boolean
}

/** Os vivos de uma caixa por parto de origem, na ordem dos partos. Vazio quando nao ha vivo */
export async function ninhadasNaCaixa(banco: Leitura, idCaixa: number): Promise<NinhadaNaCaixa[]> {
  const naCaixa = (await vivosNasCaixas(banco, [idCaixa])).get(idCaixa)

  return (naCaixa?.partos ?? []).map((parto) => ({
    idParto: parto.idParto,
    ordem: parto.ordem,
    casal: parto.casal,
    m: parto.vivos.m,
    f: parto.vivos.f,
    desmamado: parto.desmamado,
  }))
}

/**
 * As datas de nascimento dos vivos de um sexo numa caixa, da mais antiga para a mais nova. Com
 * mais de uma, quem tira animais dela diz de qual idade
 */
export async function idadesNaCaixa(banco: Leitura, idCaixa: number, sexo: Sexo): Promise<string[]> {
  const partos = await banco.parto.findMany({
    where: { animais: { some: { idCaixa, sexo, situacao: 'vivo' } } },
    distinct: ['dtPartoReal'],
    orderBy: { dtPartoReal: 'asc' },
    select: { dtPartoReal: true },
  })

  return partos.flatMap((parto) => (parto.dtPartoReal === null ? [] : [dataISO(parto.dtPartoReal)]))
}

// ------------------------------------------------------------ por parto

/** Os campos de cada animal do parto que a ficha e as correcoes contam */
export const selecaoDoAnimalDoParto = {
  id: true,
  sexo: true,
  situacao: true,
  idCaixa: true,
  idPedido: true,
  dtMovimento: true,
  dtSaida: true,
  caixa: { select: { codigo: true, tipo: true, estante: { select: { numeroVisivel: true } } } },
} satisfies Prisma.AnimalSelect

export type AnimalDoParto = Prisma.AnimalGetPayload<{ select: typeof selecaoDoAnimalDoParto }>

/** Todos os animais do parto, onde estiverem e na situacao que estiverem, pela ordem de id */
export function animaisDoParto(banco: Leitura, idParto: number): Promise<AnimalDoParto[]> {
  return banco.animal.findMany({
    where: { idParto },
    orderBy: { id: 'asc' },
    select: selecaoDoAnimalDoParto,
  })
}

// ------------------------------------------------------------ por pedido

/** Cada pedido com o que pede e os animais que pesam nele (vivos reservados mais entregues) */
export async function contagemDosPedidos(banco: Leitura, ids: number[]): Promise<Map<number, SituacaoDoPedido>> {
  if (ids.length === 0) return new Map()

  // uma consulta de cada vez: dentro da transacao da reserva ou da anulacao, a conexao e uma so
  const pedidos = await banco.pedido.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, qtdM: true, qtdF: true, qtdQualquer: true },
  })
  const linhas = await banco.animal.groupBy({
    by: ['idPedido', 'sexo'],
    where: { idPedido: { in: ids }, situacao: { in: ['vivo', 'entregue'] } },
    _count: { _all: true },
  })

  return new Map(
    pedidos.map((pedido) => [
      pedido.id,
      {
        status: pedido.status,
        pedido: { qtdM: pedido.qtdM, qtdF: pedido.qtdF, qtdQualquer: pedido.qtdQualquer },
        tem: contar(linhas.filter((linha) => linha.idPedido === pedido.id)),
      },
    ]),
  )
}

export type FaltaDoPedido = FaltaDaReserva & { idPedido: number }

/**
 * A falta de cada pedido reservado que ficou com menos animais do que pede: o dono da falta e o
 * pedido cujo animal morreu ou foi anulado. Pedido entregue nunca tem falta
 */
export async function faltasDosPedidos(banco: Leitura, ids: number[]): Promise<FaltaDoPedido[]> {
  const contagens = await contagemDosPedidos(banco, ids)

  return [...contagens.entries()]
    .filter(([, contagem]) => contagem.status === 'reservado')
    .map(([idPedido, contagem]) => ({ idPedido, ...faltaDaReserva(contagem.pedido, contagem.tem) }))
    .filter(temFalta)
    .sort((a, b) => a.idPedido - b.idPedido)
}
