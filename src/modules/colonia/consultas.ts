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

export type VivosDaCaixa = { vivos: PorSexo; reservados: PorSexo }

/** Os vivos de cada caixa, por sexo, e quantos deles estao reservados. Caixa sem vivo fica zerada */
export async function vivosPorCaixa(banco: Leitura, idsCaixa: number[]): Promise<Map<number, VivosDaCaixa>> {
  const porCaixa = new Map<number, VivosDaCaixa>(
    idsCaixa.map((id) => [id, { vivos: { m: 0, f: 0 }, reservados: { m: 0, f: 0 } }]),
  )
  if (idsCaixa.length === 0) return porCaixa

  const linhas = await banco.animal.groupBy({
    by: ['idCaixa', 'sexo', 'idPedido'],
    where: { idCaixa: { in: idsCaixa }, situacao: 'vivo' },
    _count: { _all: true },
  })

  for (const linha of linhas) {
    const caixa = porCaixa.get(linha.idCaixa)
    if (caixa === undefined) continue

    const lado = linha.sexo === 'M' ? 'm' : 'f'
    caixa.vivos[lado] += linha._count._all
    if (linha.idPedido !== null) caixa.reservados[lado] += linha._count._all
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
  const linhas = await banco.animal.groupBy({
    by: ['idParto', 'sexo'],
    where: { idCaixa, situacao: 'vivo' },
    _count: { _all: true },
  })
  if (linhas.length === 0) return []

  const partos = await banco.parto.findMany({
    where: { id: { in: [...new Set(linhas.map((linha) => linha.idParto))] } },
    orderBy: [{ dtPartoReal: 'asc' }, { id: 'asc' }],
    select: { id: true, ordem: true, dtDesmameReal: true, casal: { select: { identificacao: true } } },
  })

  return partos.map((parto) => ({
    idParto: parto.id,
    ordem: parto.ordem,
    casal: parto.casal.identificacao.trim(),
    ...contar(linhas.filter((linha) => linha.idParto === parto.id)),
    desmamado: parto.dtDesmameReal !== null,
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

  const [pedidos, linhas] = await Promise.all([
    banco.pedido.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, qtdM: true, qtdF: true, qtdQualquer: true },
    }),
    banco.animal.groupBy({
      by: ['idPedido', 'sexo'],
      where: { idPedido: { in: ids }, situacao: { in: ['vivo', 'entregue'] } },
      _count: { _all: true },
    }),
  ])

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
