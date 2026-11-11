// A entrega do pedido: os animais reservados saem da colonia, das caixas onde estao de fato, e o
// pedido fica entregue. A caixa que esvaziou e liberada com a data da entrega

import { agora } from '../../shared/relogio.ts'
import type { Prisma } from '@prisma/client'
import { campoInvalido, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, dataLegivel, hojeISO, paraData } from '../../shared/traducao.ts'
import { exigirDepoisDaChegada, travarReservados } from '../colonia/escolha.ts'
import type { Reservado } from '../colonia/escolha.ts'
import { liberarSeVazia } from '../colonia/liberacao.ts'
import { lancarOcorrencia } from '../colonia/ocorrencia.ts'
import { faltaDaReserva, temFalta } from '../colonia/reserva.ts'
import { contarPorSexo, noNumero, quantosDoSexo, sexoDe } from '../colonia/tipos.ts'
import { travarCaixas, travarPedidos } from '../colonia/travas.ts'
import { faixaDoPedido, porQueNaoServe } from '../motor/motor.ts'
import { descreverQuantidade, statusDo } from './pedido.ts'

/** As caixas onde estao os vivos reservados do pedido, em ordem de id */
async function caixasDosReservados(tx: Prisma.TransactionClient, idPedido: number): Promise<number[]> {
  const caixas = await tx.animal.findMany({
    where: { idPedido, situacao: 'vivo' },
    distinct: ['idCaixa'],
    orderBy: { idCaixa: 'asc' },
    select: { idCaixa: true },
  })

  return caixas.map((caixa) => caixa.idCaixa)
}

/**
 * Cada grupo de reservados (o mesmo parto na mesma caixa e do mesmo sexo) tem o desmame registrado
 * ate a data da entrega e a idade, nesse dia, na faixa aceita do pedido, com a mesma tolerancia da
 * busca (motor.porQueNaoServe). A entrega leva todos ou nenhum
 */
export function exigirQueServemNaEntrega(
  reservados: Reservado[],
  faixa: { min: number; max: number },
  dtEntrega: string,
): void {
  const grupos = new Map<string, Reservado[]>()

  for (const animal of reservados) {
    const chave = `${animal.idCaixa}:${animal.idParto}:${animal.sexo}`
    grupos.set(chave, [...(grupos.get(chave) ?? []), animal])
  }

  for (const grupo of grupos.values()) {
    const [animal] = grupo
    if (animal === undefined) continue

    const dtNascimento = dataISO(animal.dtNascimento)
    const quem = `${quantosDoSexo(grupo.length, sexoDe(animal))} da caixa ${animal.codigo} (nascimento em ${dataLegivel(dtNascimento)})`

    if (animal.dtDesmameReal === null) {
      throw erroDeRegra(
        'NAO_DESMAMADO',
        `O desmame de ${quem} ainda não foi registrado: registre o desmame antes da entrega.`,
      )
    }

    const naoServe = porQueNaoServe({ dtNascimento, dtDesmame: dataISO(animal.dtDesmameReal) }, faixa, dtEntrega)

    if (naoServe?.motivo === 'desmame') {
      throw erroDeRegra(
        'NAO_DESMAMADO',
        `O desmame de ${quem} foi em ${dataLegivel(naoServe.dtDesmame)}, depois da data da entrega.`,
      )
    }

    if (naoServe?.motivo === 'idade') {
      const dias = `${naoServe.idade} ${noNumero(naoServe.idade, 'dia', 'dias')}`

      // sem "e de 40 dias": sem o acento, o "e" se le como conjuncao
      throw erroDeRegra(
        'IDADE_FORA_DA_FAIXA',
        `Na entrega em ${dataLegivel(dtEntrega)}, ${quem} ${noNumero(grupo.length, 'teria', 'teriam')} ${dias}, fora da idade aceita no pedido (${naoServe.faixa.min} a ${naoServe.faixa.max} dias). Desfaça a reserva e reserve animais na idade.`,
      )
    }
  }
}

/** Os animais mudaram de caixa entre a leitura e a trava: nada fica, e a tela recarrega */
function animaisMudaram() {
  return erroDeRegra('SEM_ANIMAIS', 'Os animais do pedido mudaram durante o registro. Atualize a tela e tente de novo.')
}

/**
 * POST /api/pedidos/:id/entrega - so o pedido reservado e sem falta, numa data a partir do dia do
 * pedido (a rota recusa a data no futuro). Cada reservado sai como entregue, da caixa onde esta, e
 * o pedido grava a data da entrega. As caixas que esvaziaram sao liberadas com essa data: a de
 * estoque fica em Enviado 7 dias contados dela; a de casal, so com o casal encerrado e sem parto
 * pendente
 */
export async function registrarEntrega(idPedido: number, dtEntrega: string, idUsuario: number) {
  return prisma.$transaction(async (tx) => {
    // a ordem das travas: as caixas de onde os animais saem, o pedido, os animais
    const caixas = await caixasDosReservados(tx, idPedido)
    await travarCaixas(tx, caixas)
    await travarPedidos(tx, [idPedido])

    const pedido = await tx.pedido.findUnique({
      where: { id: idPedido },
      select: { status: true, qtdM: true, qtdF: true, qtdQualquer: true, idadeMinDias: true, idadeMaxDias: true, dtCriacao: true },
    })
    if (pedido === null) throw naoEncontrado('Pedido')

    const status = statusDo(pedido)

    if (status === 'entregue') {
      throw erroDeRegra('SEQUENCIA_INVALIDA', `A entrega do pedido #${idPedido} já foi registrada.`)
    }

    if (status === 'recusado') {
      throw erroDeRegra('SEQUENCIA_INVALIDA', `O pedido #${idPedido} foi recusado e não tem entrega.`)
    }

    if (status !== 'reservado') {
      throw erroDeRegra('SEQUENCIA_INVALIDA', `O pedido #${idPedido} ainda não tem animais reservados.`)
    }

    if (dtEntrega < hojeISO(pedido.dtCriacao)) {
      throw campoInvalido('dtEntrega', 'A data da entrega não pode ser antes do pedido.')
    }

    const reservados = await travarReservados(tx, idPedido)
    if (reservados.some((animal) => !caixas.includes(animal.idCaixa))) throw animaisMudaram()

    // o pedido reservado nao tem entregue: o que pesa nele sao os vivos reservados
    const falta = faltaDaReserva(pedido, contarPorSexo(reservados))

    if (temFalta(falta)) {
      throw erroDeRegra(
        'PEDIDO_INCOMPLETO',
        `A reserva do pedido #${idPedido} está em falta (${descreverQuantidade(falta)}): complete a reserva ou desfaça antes de registrar a entrega.`,
      )
    }

    // a data fora de ordem e erro de digitacao, no campo; a idade e regra do pedido
    exigirDepoisDaChegada('dtEntrega', dtEntrega, reservados)
    exigirQueServemNaEntrega(reservados, faixaDoPedido({ min: pedido.idadeMinDias, max: pedido.idadeMaxDias }), dtEntrega)

    // nesta ordem: os animais saem com o pedido reservado, e so depois o pedido fica entregue
    await lancarOcorrencia(tx, {
      tipo: 'entrega',
      dtFato: dtEntrega,
      idUsuario,
      idPedido,
      ids: reservados.map((animal) => animal.id),
    })

    await tx.pedido.update({
      where: { id: idPedido },
      data: { status: 'entregue', dtEntrega: paraData(dtEntrega), dtManutencao: agora() },
    })

    const codigos = new Map(reservados.map((animal) => [animal.idCaixa, animal.codigo]))
    const caixasLiberadas: string[] = []

    for (const idCaixa of caixas) {
      if (await liberarSeVazia(tx, idCaixa, dtEntrega, 'entrega', idUsuario)) {
        caixasLiberadas.push(codigos.get(idCaixa) ?? String(idCaixa))
      }
    }

    return {
      idPedido,
      status: 'entregue' as const,
      dtEntrega,
      entregues: contarPorSexo(reservados),
      caixasLiberadas,
    }
  })
}
