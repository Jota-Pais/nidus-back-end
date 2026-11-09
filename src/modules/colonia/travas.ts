// As travas (SELECT ... FOR UPDATE) das operacoes da colonia. As regras de casal, parto e caixa
// ficam no codigo (o banco so cobra o animal e o pedido), entao cada operacao trava as linhas que
// confere antes de ler, e quem chega depois espera e le o que a primeira gravou.
//
// Sempre nesta ordem, para duas operacoes nunca esperarem uma pela outra (deadlock):
// a baixa que se anula -> casal -> parto -> caixas (em ordem de id) -> pedidos (em ordem de id) ->
// animais (a escolha).

import { Prisma } from '@prisma/client'

type Transacao = Pick<Prisma.TransactionClient, '$queryRaw'>

function unicosEmOrdem(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b)
}

/**
 * Trava a ocorrencia (a baixa que se anula): duas anulacoes da mesma baixa ficam em fila, e a
 * segunda ve as ocorrencias de anulacao que a primeira gravou
 */
export async function travarOcorrencia(tx: Transacao, idOcorrencia: number): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "colonia"."ocorrencia" WHERE "id" = ${idOcorrencia} FOR UPDATE`
}

export async function travarCasal(tx: Transacao, idCasal: number): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "reproducao"."casal" WHERE "id" = ${idCasal} FOR UPDATE`
}

export async function travarParto(tx: Transacao, idParto: number): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "reproducao"."parto" WHERE "id" = ${idParto} FOR UPDATE`
}

/** Trava as caixas em ordem de id: duas mudancas em sentidos opostos ficam em fila */
export async function travarCaixas(tx: Transacao, ids: number[]): Promise<void> {
  const caixas = unicosEmOrdem(ids)
  if (caixas.length === 0) return

  await tx.$queryRaw`SELECT "id" FROM "infra"."caixa" WHERE "id" IN (${Prisma.join(caixas)}) ORDER BY "id" FOR UPDATE`
}

/** Trava os pedidos em ordem de id, como o trigger do animal faz em cada reserva que entra ou sai */
export async function travarPedidos(tx: Transacao, ids: number[]): Promise<void> {
  const pedidos = unicosEmOrdem(ids)
  if (pedidos.length === 0) return

  await tx.$queryRaw`SELECT "id" FROM "demanda"."pedido" WHERE "id" IN (${Prisma.join(pedidos)}) ORDER BY "id" FOR UPDATE`
}
