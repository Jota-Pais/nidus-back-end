// Kanban (um por especie) e a mudanca de coluna de uma caixa

import { erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { estadoCaixa, exigirCodigo } from '../../shared/traducao.ts'
import type { EstadoCaixa } from '../../shared/traducao.ts'
import { casalNoCard, selecaoDoCasalNoCard } from './casalNoCard.ts'
import { codigoDaPosicao } from './endereco.ts'
import { idDaEspecie } from './infra.service.ts'

/** 'GET /api/quadro?especie=' - o kanban de uma especie, com as cinco colunas sempre presentes */
export async function montarQuadro(codigoEspecie: string) {
  const idEspecie = await idDaEspecie(codigoEspecie)

  const caixas = await prisma.caixa.findMany({
    // so caixa de reproducao que ja teve casal - caixa vazia nao aparece no kanban
    where: { idEspecie, ativa: true, finalidade: 'R', casais: { some: {} } },
    orderBy: [{ idEstante: 'asc' }, { face: 'asc' }, { linha: 'asc' }, { coluna: 'asc' }],
    select: {
      id: true,
      face: true,
      linha: true,
      coluna: true,
      estado: true,
      estante: { select: { numeroVisivel: true, colunas: true } },
      casais: selecaoDoCasalNoCard,
    },
  })

  const colunas = estadoCaixa.termos.map((estado) => ({
    estado,
    cards: [] as unknown[],
  }))

  for (const caixa of caixas) {
    const coluna = colunas.find((c) => c.estado === estadoCaixa.paraApi(caixa.estado))
    const casal = caixa.casais[0]

    coluna?.cards.push({
      idCaixa: caixa.id,
      codigo: codigoDaPosicao(caixa.face, caixa.linha, caixa.coluna, caixa.estante.colunas),
      numeroVisivel: caixa.estante.numeroVisivel,
      linhagem: casal?.linhagem.nome ?? null,
      casal: casalNoCard(casal),
    })
  }

  return { colunas }
}

export type PedidoDeTransicao = {
  estado: EstadoCaixa
  confirmar: boolean
}

/**
 * PATCH /api/caixas/:id/estado - arrastar o card para outra coluna. Se o parto atual da caixa
 * tem compromisso ativo, a mudanca so passa com 'confirmar: true'
 */
export async function moverCaixa(idCaixa: number, dados: PedidoDeTransicao) {
  const caixa = await prisma.caixa.findUnique({
    where: { id: idCaixa },
    select: {
      id: true,
      casais: {
        where: { ativo: true },
        take: 1,
        select: { partos: { orderBy: { ordem: 'desc' }, take: 1, select: { id: true } } },
      },
    },
  })

  if (caixa === null) {
    throw naoEncontrado('Caixa')
  }

  const estadoNovo = exigirCodigo(estadoCaixa, dados.estado, 'Estado')
  const partoAtual = caixa.casais[0]?.partos[0]

  const compromissos =
    partoAtual === undefined
      ? 0
      : await prisma.compromisso.count({ where: { idParto: partoAtual.id, dtCancelamento: null } })

  if (compromissos > 0 && !dados.confirmar) {
    throw erroDeRegra(
      'TRANSICAO_CONTRARIA_COMPROMISSO',
      'Esta caixa tem animais comprometidos que esta mudanca pode afetar. Confirmar mesmo assim?',
    )
  }

  const atualizada = await prisma.caixa.update({
    where: { id: idCaixa },
    data: { estado: estadoNovo },
  })

  return { idCaixa: atualizada.id, estado: estadoCaixa.paraApi(atualizada.estado) }
}
