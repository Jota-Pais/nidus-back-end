// A unica porta de escrita em colonia.animal. Toda acao sobre animais vira uma ocorrencia ligada
// aos animais que tocou, e o que acontece com eles depende so do tipo da ocorrencia: nenhum
// servico faz INSERT ou UPDATE em animal por fora daqui.
//
// Quem chama ja escolheu e travou os animais (escolha.ts). Cada UPDATE confere tambem o estado
// em que o animal tem de estar (vivo para a baixa, morto para a anulacao...), e se algum nao
// estiver, nada fica: o animal mudou no meio do caminho.

import { agora } from '../../shared/relogio.ts'
import type { Prisma } from '@prisma/client'
import { erroDeRegra } from '../../shared/erros.ts'
import { paraData } from '../../shared/traducao.ts'
import type { PorSexo, Sexo } from './tipos.ts'

type Transacao = Pick<Prisma.TransactionClient, 'animal' | 'ocorrencia'>

type Comum = {
  /** A data do fato, 'aaaa-mm-dd', decidida pelo usuario */
  dtFato: string
  /** null: o proprio sistema */
  idUsuario: number | null
  motivo?: string | undefined
}

/** Os animais que nascem de um parto, na caixa do casal */
type Nascimento = Comum & {
  tipo: 'nascimento'
  idParto: number
  idCaixa: number
  nascidos: PorSexo
}

/** Morte ou eutanasia (a selecao inclusive): os animais ficam mortos na caixa onde estavam */
type Baixa = Comum & {
  tipo: 'baixa'
  idCaixa: number
  /** A baixa da selecao e a do desmame sao de um parto so */
  idParto?: number | undefined
  ids: number[]
}

/** Os animais mudam de caixa e chegam nela na data do fato. A reserva vai junto */
type Mudanca = Comum & {
  tipo: 'mudanca'
  idCaixaOrigem: number
  idCaixaDestino: number
  ids: number[]
}

/** Vivos livres passam a ser do pedido */
type Reserva = Comum & { tipo: 'reserva'; idPedido: number; ids: number[] }

/** Vivos do pedido voltam a ficar livres */
type ReservaDesfeita = Comum & { tipo: 'reserva_desfeita'; idPedido: number; ids: number[] }

/** Os reservados do pedido saem da colonia na data do fato */
type Entrega = Comum & { tipo: 'entrega'; idPedido: number; ids: number[] }

/**
 * A correcao da ficha de um parto que muda animais: troca de sexo de vivos livres, anulacao do
 * registro de animal que nao existiu, animais a mais que nao foram registrados e a data de saida
 * de mortos que acompanha a data corrigida. Os a mais entram em 'novos.idCaixa', o destino da
 * ocorrencia
 */
type Correcao = Comum & {
  tipo: 'correcao'
  idParto: number
  motivo: string
  trocaDeSexo?: { ids: number[]; para: Sexo } | undefined
  anulados?: number[] | undefined
  /**
   * 'chegam': os a mais entram numa caixa de estoque na data do fato, que e a da chegada deles
   * nela; sem, estao na caixa onde nasceram, sem chegada
   */
  novos?: { idCaixa: number; m: number; f: number; chegam: boolean } | undefined
  novaSaida?: { ids: number[]; dtSaida: string } | undefined
}

/**
 * A anulacao de uma baixa: os animais voltam a viver na caixa onde estavam, ou mudam para
 * 'idCaixaDestino' quando ela ja foi liberada. Os 'soltos' perdem a reserva, que o pedido nao
 * comporta mais; os outros voltam a contar nela
 */
type Anulacao = Comum & {
  tipo: 'anulacao'
  idAnulada: number
  motivo: string
  idParto?: number | undefined
  idCaixaOrigem: number
  idCaixaDestino?: number | undefined
  ids: number[]
  soltos: number[]
}

export type Lancamento =
  | Nascimento
  | Baixa
  | Mudanca
  | Reserva
  | ReservaDesfeita
  | Entrega
  | Correcao
  | Anulacao

export type Lancado = { idOcorrencia: number; ids: number[] }

/** Os animais mudaram entre a escolha e a escrita: nada fica, e a tela recarrega */
function animaisMudaram() {
  return erroDeRegra('SEM_ANIMAIS', 'Os animais mudaram durante o registro. Atualize a tela e tente de novo.')
}

/** UPDATE dos animais que estao no estado esperado. Se faltar algum, desfaz tudo */
async function atualizar(
  tx: Transacao,
  ids: number[],
  esperado: Prisma.AnimalWhereInput,
  data: Prisma.AnimalUncheckedUpdateManyInput,
): Promise<void> {
  if (ids.length === 0) return

  const { count } = await tx.animal.updateMany({
    where: { ...esperado, id: { in: ids } },
    data: { ...data, dtManutencao: agora() },
  })

  if (count !== ids.length) throw animaisMudaram()
}

/** INSERT de vivos de um parto numa caixa, devolvendo os ids */
async function criar(
  tx: Transacao,
  idParto: number,
  idCaixa: number,
  dtMovimento: string | null,
  qtd: PorSexo,
): Promise<number[]> {
  const sexos: Sexo[] = [...Array<Sexo>(qtd.m).fill('M'), ...Array<Sexo>(qtd.f).fill('F')]
  if (sexos.length === 0) return []

  const criados = await tx.animal.createManyAndReturn({
    data: sexos.map((sexo) => ({
      idParto,
      sexo,
      idCaixa,
      dtMovimento: dtMovimento === null ? null : paraData(dtMovimento),
    })),
    select: { id: true },
  })

  return criados.map((animal) => animal.id)
}

/** Aplica nos animais o que o tipo da ocorrencia manda, e devolve os animais tocados */
async function aplicar(tx: Transacao, lancamento: Lancamento): Promise<number[]> {
  const dtFato = paraData(lancamento.dtFato)

  switch (lancamento.tipo) {
    case 'nascimento':
      return criar(tx, lancamento.idParto, lancamento.idCaixa, null, lancamento.nascidos)

    case 'baixa':
      await atualizar(
        tx,
        lancamento.ids,
        { situacao: 'vivo', idCaixa: lancamento.idCaixa },
        { situacao: 'morto', dtSaida: dtFato },
      )
      return lancamento.ids

    case 'mudanca':
      await atualizar(
        tx,
        lancamento.ids,
        { situacao: 'vivo', idCaixa: lancamento.idCaixaOrigem },
        { idCaixa: lancamento.idCaixaDestino, dtMovimento: dtFato },
      )
      return lancamento.ids

    case 'reserva':
      await atualizar(tx, lancamento.ids, { situacao: 'vivo', idPedido: null }, { idPedido: lancamento.idPedido })
      return lancamento.ids

    case 'reserva_desfeita':
      await atualizar(tx, lancamento.ids, { situacao: 'vivo', idPedido: lancamento.idPedido }, { idPedido: null })
      return lancamento.ids

    case 'entrega':
      await atualizar(
        tx,
        lancamento.ids,
        { situacao: 'vivo', idPedido: lancamento.idPedido },
        { situacao: 'entregue', dtSaida: dtFato },
      )
      return lancamento.ids

    case 'correcao': {
      const { trocaDeSexo, anulados = [], novos, novaSaida } = lancamento
      const trocados = trocaDeSexo?.ids ?? []
      const comSaidaNova = novaSaida?.ids ?? []

      if (trocaDeSexo !== undefined) {
        // so vivo livre troca de sexo: o reservado conta no pedido pelo sexo que tem
        await atualizar(
          tx,
          trocados,
          { situacao: 'vivo', idPedido: null, idParto: lancamento.idParto },
          { sexo: trocaDeSexo.para },
        )
      }

      await atualizar(tx, anulados, { situacao: 'vivo', idParto: lancamento.idParto }, { situacao: 'anulado' })

      if (novaSaida !== undefined) {
        await atualizar(
          tx,
          comSaidaNova,
          { situacao: 'morto', idParto: lancamento.idParto },
          { dtSaida: paraData(novaSaida.dtSaida) },
        )
      }

      const criados =
        novos === undefined
          ? []
          : await criar(tx, lancamento.idParto, novos.idCaixa, novos.chegam ? lancamento.dtFato : null, novos)

      return [...new Set([...trocados, ...anulados, ...comSaidaNova, ...criados])]
    }

    case 'anulacao': {
      const { idCaixaDestino, soltos } = lancamento
      const mudou = idCaixaDestino !== undefined && idCaixaDestino !== lancamento.idCaixaOrigem
      const volta: Prisma.AnimalUncheckedUpdateManyInput = {
        situacao: 'vivo',
        dtSaida: null,
        ...(mudou ? { idCaixa: idCaixaDestino, dtMovimento: dtFato } : {}),
      }
      const esperado = { situacao: 'morto', idCaixa: lancamento.idCaixaOrigem }
      const comReserva = lancamento.ids.filter((id) => !soltos.includes(id))

      await atualizar(tx, comReserva, esperado, volta)
      await atualizar(tx, soltos, esperado, { ...volta, idPedido: null })
      return lancamento.ids
    }
  }
}

/** Os campos da ocorrencia que cada tipo preenche */
function camposDaOcorrencia(lancamento: Lancamento) {
  switch (lancamento.tipo) {
    case 'nascimento':
      return { idParto: lancamento.idParto, idCaixaDestino: lancamento.idCaixa }
    case 'baixa':
      return { idParto: lancamento.idParto ?? null, idCaixaOrigem: lancamento.idCaixa }
    case 'mudanca':
      return { idCaixaOrigem: lancamento.idCaixaOrigem, idCaixaDestino: lancamento.idCaixaDestino }
    case 'reserva':
    case 'reserva_desfeita':
    case 'entrega':
      return { idPedido: lancamento.idPedido }
    case 'correcao':
      return { idParto: lancamento.idParto, idCaixaDestino: lancamento.novos?.idCaixa ?? null }
    case 'anulacao':
      return {
        idAnulada: lancamento.idAnulada,
        idParto: lancamento.idParto ?? null,
        idCaixaOrigem: lancamento.idCaixaOrigem,
        idCaixaDestino: lancamento.idCaixaDestino ?? null,
      }
  }
}

/**
 * Lanca a ocorrencia: aplica nos animais o que o tipo manda e grava a ocorrencia com os animais
 * que ela tocou, na mesma transacao
 */
export async function lancarOcorrencia(tx: Transacao, lancamento: Lancamento): Promise<Lancado> {
  const ids = await aplicar(tx, lancamento)

  const ocorrencia = await tx.ocorrencia.create({
    data: {
      tipo: lancamento.tipo,
      dtFato: paraData(lancamento.dtFato),
      idUsuario: lancamento.idUsuario,
      dtRegistro: agora(),
      motivo: lancamento.motivo ?? null,
      ...camposDaOcorrencia(lancamento),
      animais: { createMany: { data: ids.map((idAnimal) => ({ idAnimal })) } },
    },
    select: { id: true },
  })

  return { idOcorrencia: ocorrencia.id, ids }
}
