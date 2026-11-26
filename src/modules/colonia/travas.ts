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

/**
 * Trava as caixas ativas da estante em ordem de id, como travarCaixas: a troca de formato da estante
 * reescreve o codigo de todas elas (trigger infra.estante_reescreve_as_caixas). Quem muda uma delas
 * de lugar ao mesmo tempo espera, e a conferencia das que ficariam fora le o que o banco vai reescrever
 */
export async function travarCaixasDaEstante(tx: Transacao, idEstante: number): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "infra"."caixa" WHERE "id_estante" = ${idEstante} AND "ativa" ORDER BY "id" FOR UPDATE`
}

/**
 * Trava as caixas ativas de todas as estantes do formato, em ordem de id: mudar as medidas reescreve o
 * codigo de todas elas (trigger infra.formato_reescreve_as_caixas). O mesmo de travarCaixasDaEstante
 */
export async function travarCaixasDoFormato(tx: Transacao, idFormato: number): Promise<void> {
  await tx.$queryRaw`
    SELECT c."id"
      FROM "infra"."caixa" c
      JOIN "infra"."estante" e ON e."id" = c."id_estante"
     WHERE e."id_formato" = ${idFormato} AND c."ativa"
     ORDER BY c."id"
       FOR UPDATE OF c`
}

/** Trava os pedidos em ordem de id, como o trigger do animal faz em cada reserva que entra ou sai */
export async function travarPedidos(tx: Transacao, ids: number[]): Promise<void> {
  const pedidos = unicosEmOrdem(ids)
  if (pedidos.length === 0) return

  await tx.$queryRaw`SELECT "id" FROM "demanda"."pedido" WHERE "id" IN (${Prisma.join(pedidos)}) ORDER BY "id" FOR UPDATE`
}
