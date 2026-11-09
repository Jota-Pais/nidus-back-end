// A escolha de animais dentro de um grupo equivalente. Dentro da caixa, rato da mesma idade,
// linhagem e sexo e tudo a mesma coisa: toda operacao fala em (caixa, sexo, nascimento,
// quantidade), e o sistema pega quaisquer N vivos do grupo.
//
// Primeiro os livres; se nao bastarem, os reservados do pedido que o tecnico indicar. Com
// reservados de um pedido so, sao deles; de mais de um, e o tecnico quem escolhe. Entre iguais,
// pela ordem de id. Os escolhidos ficam travados (FOR UPDATE) ate o fim da transacao, e quem
// escolhe ao mesmo tempo pula os travados (SKIP LOCKED) em vez de esperar.

import { Prisma } from '@prisma/client'
import { campoInvalido, erroDeRegra } from '../../shared/erros.ts'
import { dataLegivel } from '../../shared/traducao.ts'
import { exigirOrdem } from '../reproducao/ordemDasDatas.ts'
import { idadesNaCaixa } from './consultas.ts'
import { ROTULO_DO_SEXO, quantosDoSexo } from './tipos.ts'
import type { Sexo } from './tipos.ts'

type Transacao = Pick<Prisma.TransactionClient, '$queryRaw'>

/** O grupo de onde saem os animais. Sem caixa ou sem parto, vale qualquer um */
export type Grupo = {
  sexo: Sexo
  idCaixa?: number | undefined
  idParto?: number | undefined
  /** 'aaaa-mm-dd': o nascimento (parto real) dos animais */
  dtNascimento?: string | undefined
}

export type Escolha = {
  /** De qual pedido saem os reservados quando os livres nao bastam */
  idPedido?: number | undefined
  /** Nunca os reservados: a troca de sexo, por exemplo, nao mexe em animal de pedido */
  soLivres?: boolean | undefined
  /**
   * So os reservados do pedido indicado, sem passar pelos livres: a mudanca que junta numa caixa
   * os animais de um pedido
   */
  soDoPedido?: boolean | undefined
  /** Ids ja escolhidos nesta transacao, que o FOR UPDATE nao esconde de quem os travou */
  excluir?: number[] | undefined
  /** O campo do formulario que recebe a mensagem quando falta dizer o pedido */
  campoDoPedido?: string | undefined
}

export type Escolhido = {
  id: number
  idCaixa: number
  idPedido: number | null
  /** Quando chegou na caixa atual; null: nunca mudou desde que nasceu */
  dtMovimento: Date | null
  dtNascimento: Date
}

function condicoes(grupo: Grupo, excluir: number[]): Prisma.Sql {
  const filtros = [Prisma.sql`a."situacao" = 'vivo'`, Prisma.sql`a."sexo" = ${grupo.sexo}`]

  if (grupo.idCaixa !== undefined) filtros.push(Prisma.sql`a."id_caixa" = ${grupo.idCaixa}`)
  if (grupo.idParto !== undefined) filtros.push(Prisma.sql`a."id_parto" = ${grupo.idParto}`)
  if (grupo.dtNascimento !== undefined) {
    // a data vai como texto e vira date no banco: nada de fuso no meio
    filtros.push(Prisma.sql`p."dt_parto_real" = ${grupo.dtNascimento}::date`)
  }
  if (excluir.length > 0) filtros.push(Prisma.sql`a."id" NOT IN (${Prisma.join(excluir)})`)

  return Prisma.join(filtros, ' AND ')
}

/** Ate 'qtd' vivos do grupo, livres (idPedido null) ou do pedido, travados e pela ordem de id */
function travarVivos(
  tx: Transacao,
  grupo: Grupo,
  excluir: number[],
  idPedido: number | null,
  qtd: number,
): Promise<Escolhido[]> {
  const doPedido = idPedido === null ? Prisma.sql`a."id_pedido" IS NULL` : Prisma.sql`a."id_pedido" = ${idPedido}`

  return tx.$queryRaw<Escolhido[]>`
    SELECT a."id", a."id_caixa" AS "idCaixa", a."id_pedido" AS "idPedido", a."dt_movimento" AS "dtMovimento", p."dt_parto_real" AS "dtNascimento"
      FROM "colonia"."animal" a
      JOIN "reproducao"."parto" p ON p."id" = a."id_parto"
     WHERE ${condicoes(grupo, excluir)} AND ${doPedido}
     ORDER BY a."id"
     LIMIT ${qtd}
       FOR UPDATE OF a SKIP LOCKED`
}

/** Os pedidos que tem vivos reservados no grupo, para decidir de qual saem os que faltam */
async function pedidosNoGrupo(tx: Transacao, grupo: Grupo, excluir: number[]): Promise<number[]> {
  const linhas = await tx.$queryRaw<{ idPedido: number }[]>`
    SELECT DISTINCT a."id_pedido" AS "idPedido"
      FROM "colonia"."animal" a
      JOIN "reproducao"."parto" p ON p."id" = a."id_parto"
     WHERE ${condicoes(grupo, excluir)} AND a."id_pedido" IS NOT NULL
     ORDER BY 1`

  return linhas.map((linha) => linha.idPedido)
}

/** Onde estao os animais do grupo, como as mensagens dizem */
function ondeDoGrupo(grupo: Grupo): string {
  return grupo.idParto === undefined ? 'nesta caixa e idade' : 'deste parto'
}

/**
 * De qual pedido saem os reservados quando os livres nao bastam: o indicado, ou o unico que tem
 * reservados no grupo. Null quando nao ha reservado nenhum. Com mais de um e nenhum indicado,
 * recusa pedindo qual; o indicado que nao tem reservados no grupo tambem e recusado, dizendo que
 * pedidos tem. 'reservados' e quem falta, como a mensagem diz: 'machos reservados nesta caixa e idade'
 */
export function pedidoDosReservados(
  pedidos: number[],
  indicado: number | undefined,
  campo: string = 'idPedido',
  reservados: string = 'reservados neste grupo',
): number | null {
  const lista = pedidos.map((id) => `#${id}`).join(', ')

  if (indicado !== undefined) {
    if (pedidos.includes(indicado)) return indicado

    const quais = pedidos.length === 0 ? '' : `; os que ha sao dos pedidos ${lista}`

    throw erroDeRegra('SEM_ANIMAIS', `Os livres nao bastam, e o pedido #${indicado} nao tem ${reservados}.`, {
      campos: { [campo]: `O pedido #${indicado} nao tem ${reservados}${quais}.` },
    })
  }

  const [unico, ...outros] = pedidos
  if (unico === undefined) return null
  if (outros.length === 0) return unico

  throw erroDeRegra(
    'PEDIDO_NAO_INDICADO',
    `Os livres nao bastam, e os outros animais estao reservados para os pedidos ${lista}: diga de qual pedido eles saem.`,
    { campos: { [campo]: `Escolha um dos pedidos: ${lista}.` } },
  )
}

function semAnimais(grupo: Grupo, qtd: number, achados: number, idPedido?: number) {
  const doPedido = idPedido === undefined ? '' : ` do pedido #${idPedido}`
  const onde = ondeDoGrupo(grupo)

  return erroDeRegra(
    'SEM_ANIMAIS',
    achados === 0
      ? `Nao ha ${ROTULO_DO_SEXO[grupo.sexo]} vivos${doPedido} ${onde} para esta operacao.`
      : `Pediu ${quantosDoSexo(qtd, grupo.sexo)}${doPedido}, mas so ha ${achados} ${onde} para esta operacao.`,
  )
}

/**
 * A idade do grupo de onde saem os animais de um sexo da caixa: a indicada, ou a unica que ha.
 * Com mais de uma idade naquele sexo, quem registra diz de qual (mensagem no campo)
 */
export async function idadeDoGrupo(
  tx: Parameters<typeof idadesNaCaixa>[0],
  idCaixa: number,
  sexo: Sexo,
  indicada: string | undefined,
  campo: string,
): Promise<string | undefined> {
  if (indicada !== undefined) return indicada

  const idades = await idadesNaCaixa(tx, idCaixa, sexo)

  if (idades.length > 1) {
    throw campoInvalido(
      campo,
      `A caixa tem ${ROTULO_DO_SEXO[sexo]} de mais de uma idade: diga a data de nascimento (${idades.map(dataLegivel).join(', ')}).`,
    )
  }

  return idades[0]
}

/**
 * Escolhe e trava 'qtd' vivos do grupo: livres primeiro, depois os reservados de um pedido. Se o
 * grupo nao tiver os animais, recusa com SEM_ANIMAIS e nada fica travado alem da transacao
 */
export async function escolherAnimais(
  tx: Transacao,
  grupo: Grupo,
  qtd: number,
  escolha: Escolha = {},
): Promise<Escolhido[]> {
  if (qtd === 0) return []

  const excluir = escolha.excluir ?? []

  if (escolha.soDoPedido === true) {
    if (escolha.idPedido === undefined) {
      throw campoInvalido(escolha.campoDoPedido ?? 'idPedido', 'Diga de qual pedido sao os reservados que mudam.')
    }

    const doPedido = await travarVivos(tx, grupo, excluir, escolha.idPedido, qtd)
    if (doPedido.length < qtd) throw semAnimais(grupo, qtd, doPedido.length, escolha.idPedido)
    return doPedido
  }

  const livres = await travarVivos(tx, grupo, excluir, null, qtd)
  const faltam = qtd - livres.length

  if (faltam === 0) return livres

  const idPedido =
    escolha.soLivres === true
      ? null
      : pedidoDosReservados(
          await pedidosNoGrupo(tx, grupo, excluir),
          escolha.idPedido,
          escolha.campoDoPedido,
          `${ROTULO_DO_SEXO[grupo.sexo]} reservados ${ondeDoGrupo(grupo)}`,
        )

  const reservados = idPedido === null ? [] : await travarVivos(tx, grupo, excluir, idPedido, faltam)
  const escolhidos = [...livres, ...reservados]

  if (escolhidos.length < qtd) throw semAnimais(grupo, qtd, escolhidos.length)

  return escolhidos
}

/** Um vivo reservado de um pedido, com o que a entrega confere nele */
export type Reservado = Escolhido & {
  sexo: Sexo
  idParto: number
  /** o desmame registrado do parto; null enquanto a ninhada nao desmamou */
  dtDesmameReal: Date | null
  /** o codigo da caixa onde ele esta */
  codigo: string
}

/**
 * Todos os vivos reservados do pedido, travados (FOR UPDATE) e pela ordem de id. Sem pular os
 * travados: quem desfaz, recusa ou entrega precisa de todos, entao espera quem os tem (uma baixa,
 * uma mudanca) terminar e le o que ela gravou. Quem chama ja travou o pedido
 */
export function travarReservados(tx: Transacao, idPedido: number): Promise<Reservado[]> {
  return tx.$queryRaw<Reservado[]>`
    SELECT a."id", a."id_caixa" AS "idCaixa", a."id_pedido" AS "idPedido", a."dt_movimento" AS "dtMovimento",
           a."sexo", a."id_parto" AS "idParto", p."dt_parto_real" AS "dtNascimento",
           p."dt_desmame_real" AS "dtDesmameReal", c."codigo"
      FROM "colonia"."animal" a
      JOIN "reproducao"."parto" p ON p."id" = a."id_parto"
      JOIN "infra"."caixa" c ON c."id" = a."id_caixa"
     WHERE a."situacao" = 'vivo' AND a."id_pedido" = ${idPedido}
     ORDER BY a."id"
       FOR UPDATE OF a`
}

/** Os pedidos dos escolhidos que estavam reservados, sem repetir: os que podem ficar em falta */
export function pedidosTocados(escolhidos: Pick<Escolhido, 'idPedido'>[]): number[] {
  return [...new Set(escolhidos.flatMap((animal) => (animal.idPedido === null ? [] : [animal.idPedido])))]
}

function maisRecente(datas: (Date | null)[]): Date | null {
  return datas.reduce<Date | null>((maior, data) => (data !== null && (maior === null || data > maior) ? data : maior), null)
}

/**
 * A chegada mais recente dos animais na caixa onde estao: o fato deles nesta caixa nao fica antes
 * dela. Null quando nenhum chegou de outra caixa (estao onde nasceram)
 */
export function chegadaDosAnimais(animais: Pick<Escolhido, 'dtMovimento'>[]): Date | null {
  return maisRecente(animais.map((animal) => animal.dtMovimento))
}

/**
 * A saida (baixa, entrega) ou a chegada numa caixa nova nao pode ser antes do nascimento nem da
 * chegada dos escolhidos na caixa onde estao (chegadaDosAnimais). O mesmo dia vale. Mensagem no
 * campo da data
 */
export function exigirDepoisDaChegada(campo: string, data: string, escolhidos: Escolhido[]): void {
  exigirOrdem(campo, data, {
    depoisDe: [
      { evento: 'do nascimento dos animais', data: maisRecente(escolhidos.map((animal) => animal.dtNascimento)) },
      { evento: 'da chegada dos animais na caixa', data: chegadaDosAnimais(escolhidos) },
    ],
  })
}
