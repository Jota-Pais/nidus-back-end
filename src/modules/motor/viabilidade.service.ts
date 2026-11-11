// A viabilidade do pedido para quem pede: a mesma busca de atendimento do tecnico, resumida em
// "da ou nao da". A resposta nao leva numero de estoque, so o veredito e o motivo

import { agora as instanteAtual } from '../../shared/relogio.ts'
import { naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { codigoDaEspecie } from '../../shared/traducao.ts'
import type { Pedido } from './motor.ts'
import { buscarAtendimento } from './motor.service.ts'

export type Viabilidade = { viavel: boolean; motivo: string | null }

/** o que a viabilidade le do corpo de POST /api/pedidos */
export type PedidoDeViabilidade = {
  idLinhagem: number
  machos: number
  femeas: number
  qualquer: number
  idadeMin: number
  idadeMax: number
  dataEntrega: string
}

// texto para quem pede, por isso com acento, como os e-mails
export const DATA_PROXIMA_DEMAIS =
  'Essa data é muito próxima: a equipe provavelmente não consegue entregar esses animais a tempo.'

/**
 * Da quando a colonia cobre o pedido na data, contando os partos previstos (secao 6.1), ou quando
 * a data ainda permite acasalamento novo pela timeline reversa (secao 1.5). Fora isso, nao da
 */
export function resumirBusca(busca: {
  deficit: Pedido
  acasalamentoNovo: { viavel: boolean }
}): Viabilidade {
  const { m, f, qualquer } = busca.deficit
  const coloniaAtende = m + f + qualquer === 0

  if (coloniaAtende || busca.acasalamentoNovo.viavel) {
    return { viavel: true, motivo: null }
  }

  return { viavel: false, motivo: DATA_PROXIMA_DEMAIS }
}

/** POST /api/pedidos/viabilidade */
export async function avaliarViabilidade(
  pedido: PedidoDeViabilidade,
  agora: Date = instanteAtual(),
): Promise<Viabilidade> {
  const linhagem = await prisma.linhagem.findUnique({
    where: { id: pedido.idLinhagem },
    select: { especie: { select: { nome: true } } },
  })

  if (linhagem === null) {
    throw naoEncontrado('Linhagem')
  }

  const busca = await buscarAtendimento(
    {
      especie: codigoDaEspecie(linhagem.especie.nome),
      idLinhagem: pedido.idLinhagem,
      machos: pedido.machos,
      femeas: pedido.femeas,
      qualquer: pedido.qualquer,
      idadeMin: pedido.idadeMin,
      idadeMax: pedido.idadeMax,
      dataEntrega: pedido.dataEntrega,
    },
    agora,
  )

  return resumirBusca(busca)
}
