// A reserva dos animais de um pedido: reservar o pedido aprovado inteiro, completar a reserva que
// ficou em falta e desfazer a reserva. A reserva fica no animal (colonia.animal.id_pedido), e cada
// uma vira uma ocorrencia na trilha.
//
// Uma reserva confere so o que ela mesma reserva: os animais que marca (vivos, livres, do lugar e do
// sexo pedidos) e o teto do proprio pedido. A falta de outro pedido na mesma ninhada ou caixa e
// desse outro pedido, e nao bloqueia esta.
//
// As travas seguem a ordem de colonia/travas.ts: o pedido, depois os animais.

import { agora } from '../../shared/relogio.ts'
import type { Prisma } from '@prisma/client'
import { avisarAnimaisReservados } from '../../shared/email.ts'
import { erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, dataLegivel, hojeISO, paraData } from '../../shared/traducao.ts'
import { contagemDosPedidos } from '../colonia/consultas.ts'
import { escolherAnimais, travarReservados } from '../colonia/escolha.ts'
import type { Escolhido } from '../colonia/escolha.ts'
import { caixaLiberada } from '../colonia/liberacao.ts'
import { lancarOcorrencia } from '../colonia/ocorrencia.ts'
import { faltaDaReserva, temFalta } from '../colonia/reserva.ts'
import { SEXOS, contarPorSexo, doSexo, noNumero, quantosDoSexo } from '../colonia/tipos.ts'
import type { PorSexo } from '../colonia/tipos.ts'
import { travarPedidos } from '../colonia/travas.ts'
import { dataDoDesmame, faixaDoPedido, porQueNaoServe } from '../motor/motor.ts'
import type { Ninhada } from '../motor/motor.ts'
import { PARA_O_AVISO, avisarPesquisador } from './aviso.ts'
import { conferirReserva, exigirQueRecebeReserva, statusDo } from './pedido.ts'

type Transacao = Prisma.TransactionClient

/** Um lugar de onde sair animais, como a busca o devolve: a caixa e a data de nascimento */
export type ItemDaReserva = { idCaixa: number; dtNascimento: string; machos: number; femeas: number }

/** Os itens do mesmo lugar somados num so */
export function somarPorLugar(itens: ItemDaReserva[]): ItemDaReserva[] {
  const porLugar = new Map<string, ItemDaReserva>()

  for (const item of itens) {
    const chave = `${item.idCaixa}:${item.dtNascimento}`
    const somado = porLugar.get(chave)
    porLugar.set(chave, {
      ...item,
      machos: (somado?.machos ?? 0) + item.machos,
      femeas: (somado?.femeas ?? 0) + item.femeas,
    })
  }

  return [...porLugar.values()]
}

/** O lugar como a reserva o confere: a caixa, a idade e o desmame dos livres e quantos ha */
type Lugar = {
  codigo: string
  ninhada: Ninhada
  linhagens: number[]
  livres: PorSexo
}

/**
 * Le os vivos livres do lugar (a caixa e a data de nascimento) e os partos de onde vieram. O lugar
 * so esta desmamado quando todos estao, como na busca
 */
async function lerLugar(tx: Transacao, item: ItemDaReserva): Promise<Lugar> {
  const caixa = await tx.caixa.findUnique({ where: { id: item.idCaixa }, select: { codigo: true, ativa: true } })

  if (caixa === null) throw naoEncontrado('Caixa')
  if (!caixa.ativa) throw caixaLiberada(caixa.codigo)

  const linhas = await tx.animal.groupBy({
    by: ['idParto', 'sexo'],
    where: { idCaixa: item.idCaixa, situacao: 'vivo', idPedido: null, parto: { dtPartoReal: paraData(item.dtNascimento) } },
    _count: { _all: true },
  })

  const partos =
    linhas.length === 0
      ? []
      : await tx.parto.findMany({
          where: { id: { in: [...new Set(linhas.map((linha) => linha.idParto))] } },
          select: { dtDesmameReal: true, idLinhagem: true },
        })

  const desmames = partos.map((parto) =>
    dataDoDesmame(item.dtNascimento, parto.dtDesmameReal === null ? null : dataISO(parto.dtDesmameReal)),
  )

  return {
    codigo: caixa.codigo,
    ninhada: { dtNascimento: item.dtNascimento, dtDesmame: desmames.reduce((maior, d) => (d > maior ? d : maior), item.dtNascimento) },
    linhagens: [...new Set(partos.map((parto) => parto.idLinhagem))],
    livres: linhas.reduce<PorSexo>(
      (soma, linha) =>
        linha.sexo === 'M' ? { ...soma, m: soma.m + linha._count._all } : { ...soma, f: soma.f + linha._count._all },
      { m: 0, f: 0 },
    ),
  }
}

/** O pedido como a reserva o confere */
type PedidoDaReserva = { idLinhagem: number; idadeMinDias: number; idadeMaxDias: number; dtDesejada: Date }

/**
 * O lugar serve ao pedido: os livres sao da linhagem pedida, estao na faixa de idade e desmamados
 * na data desejada (a regra da busca, motor.porQueNaoServe) e bastam para o item
 */
function exigirQueServe(lugar: Lugar, item: ItemDaReserva, pedido: PedidoDaReserva): void {
  const nascimento = `do nascimento de ${dataLegivel(item.dtNascimento)}`
  const deQuem = `Os animais da caixa ${lugar.codigo} ${nascimento}`

  if (lugar.livres.m + lugar.livres.f === 0) {
    throw erroDeRegra('SEM_ANIMAIS', `A caixa ${lugar.codigo} não tem animais livres ${nascimento}.`)
  }

  if (lugar.linhagens.some((idLinhagem) => idLinhagem !== pedido.idLinhagem)) {
    throw erroDeRegra('PEDIDO_RESERVA', `${deQuem} não são da linhagem do pedido.`)
  }

  const dtDesejada = dataISO(pedido.dtDesejada)
  const naoServe = porQueNaoServe(
    lugar.ninhada,
    faixaDoPedido({ min: pedido.idadeMinDias, max: pedido.idadeMaxDias }),
    dtDesejada,
  )

  if (naoServe?.motivo === 'idade') {
    const dias = `${naoServe.idade} ${noNumero(naoServe.idade, 'dia', 'dias')}`

    throw erroDeRegra(
      'IDADE_FORA_DA_FAIXA',
      `${deQuem} terão ${dias} em ${dataLegivel(dtDesejada)}, fora da idade aceita no pedido (${naoServe.faixa.min} a ${naoServe.faixa.max} dias).`,
    )
  }

  if (naoServe?.motivo === 'desmame') {
    throw erroDeRegra(
      'NAO_DESMAMADO',
      `${deQuem} só estarão desmamados em ${dataLegivel(naoServe.dtDesmame)}, depois da entrega de ${dataLegivel(dtDesejada)}.`,
    )
  }

  for (const sexo of SEXOS) {
    const pedidos = sexo === 'M' ? item.machos : item.femeas
    const livres = doSexo(lugar.livres, sexo)

    if (pedidos > livres) {
      throw erroDeRegra(
        'SEM_ANIMAIS',
        `A caixa ${lugar.codigo} tem ${quantosDoSexo(livres, sexo)} ${noNumero(livres, 'livre', 'livres')} ${nascimento}, e a reserva pediu ${pedidos}.`,
      )
    }
  }
}

/**
 * POST /api/pedidos/:id/alocacao - reserva os animais dos lugares que a busca sugeriu. No pedido
 * aprovado, os itens cobrem o pedido inteiro e ele passa a reservado; no reservado em falta,
 * completam a falta, ate cobrir. Os animais sao quaisquer vivos livres do lugar, pela ordem de id,
 * travados (SKIP LOCKED): quem reserva ao mesmo tempo pega outros
 */
export async function reservarAnimais(idPedido: number, itensPedidos: ItemDaReserva[], usuario: UsuarioDaSessao) {
  const itens = somarPorLugar(itensPedidos)

  const reserva = await prisma.$transaction(async (tx) => {
    await travarPedidos(tx, [idPedido])

    const pedido = await tx.pedido.findUnique({ where: { id: idPedido }, include: PARA_O_AVISO })
    if (pedido === null) throw naoEncontrado('Pedido')

    const status = statusDo(pedido)
    const tem = (await contagemDosPedidos(tx, [idPedido])).get(idPedido)?.tem ?? { m: 0, f: 0 }
    const novos = {
      m: itens.reduce((soma, item) => soma + item.machos, 0),
      f: itens.reduce((soma, item) => soma + item.femeas, 0),
    }

    exigirQueRecebeReserva(idPedido, status, faltaDaReserva(pedido, tem))
    conferirReserva(pedido, tem, novos, status === 'aprovado')

    const escolhidos: Escolhido[] = []

    for (const item of itens) {
      exigirQueServe(await lerLugar(tx, item), item, pedido)

      for (const sexo of SEXOS) {
        const doLugar = await escolherAnimais(
          tx,
          { idCaixa: item.idCaixa, sexo, dtNascimento: item.dtNascimento },
          sexo === 'M' ? item.machos : item.femeas,
          { soLivres: true, excluir: escolhidos.map((animal) => animal.id) },
        )
        escolhidos.push(...doLugar)
      }
    }

    await lancarOcorrencia(tx, {
      tipo: 'reserva',
      dtFato: hojeISO(),
      idUsuario: usuario.id,
      idPedido,
      ids: escolhidos.map((animal) => animal.id),
    })

    // o banco (demanda.pedido_coerente) confere que os reservados cobrem o pedido exatamente
    if (status === 'aprovado') {
      await tx.pedido.update({ where: { id: idPedido }, data: { status: 'reservado', dtManutencao: agora() } })
    }

    return { pedido, passouAReservado: status === 'aprovado', novos, falta: faltaDaReserva(pedido, { m: tem.m + novos.m, f: tem.f + novos.f }) }
  })

  // so a reserva do pedido inteiro avisa: completar a falta nao muda nada para quem pediu
  if (reserva.passouAReservado) avisarPesquisador(reserva.pedido, avisarAnimaisReservados)

  return {
    idPedido,
    status: 'reservado' as const,
    reservados: reserva.novos,
    falta: temFalta(reserva.falta) ? reserva.falta : null,
  }
}

/**
 * Solta todos os vivos reservados do pedido: voltam a ficar livres, onde estao, e a trilha ganha a
 * reserva desfeita com o motivo. O morto e o entregue guardam o pedido como registro. Quem chama ja
 * travou o pedido e muda o status dele em seguida, na mesma transacao
 */
export async function soltarReservados(
  tx: Transacao,
  idPedido: number,
  motivo: string,
  idUsuario: number | null,
): Promise<PorSexo> {
  const reservados = await travarReservados(tx, idPedido)

  await lancarOcorrencia(tx, {
    tipo: 'reserva_desfeita',
    dtFato: hojeISO(),
    idUsuario,
    idPedido,
    motivo,
    ids: reservados.map((animal) => animal.id),
  })

  return contarPorSexo(reservados)
}

export const MOTIVO_DA_RESERVA_DESFEITA = 'Reserva desfeita pela equipe'

/**
 * POST /api/pedidos/:id/devolucao - desfaz a reserva do pedido reservado, com falta ou sem: os
 * animais voltam a ficar livres e o pedido volta a aprovado, aguardando animais para reservar de
 * novo. Quem pediu nao e avisado
 */
export async function desfazerReserva(idPedido: number, usuario: UsuarioDaSessao) {
  const soltos = await prisma.$transaction(async (tx) => {
    await travarPedidos(tx, [idPedido])

    const pedido = await tx.pedido.findUnique({ where: { id: idPedido }, select: { status: true } })
    if (pedido === null) throw naoEncontrado('Pedido')

    if (statusDo(pedido) !== 'reservado') {
      throw erroDeRegra(
        'SEQUENCIA_INVALIDA',
        `O pedido #${idPedido} não tem animais reservados: não há reserva para desfazer.`,
      )
    }

    const soltos = await soltarReservados(tx, idPedido, MOTIVO_DA_RESERVA_DESFEITA, usuario.id)

    // o banco confere que nenhum vivo ficou reservado
    await tx.pedido.update({ where: { id: idPedido }, data: { status: 'aprovado', dtManutencao: agora() } })

    return soltos
  })

  return { idPedido, status: 'aprovado' as const, soltos }
}
