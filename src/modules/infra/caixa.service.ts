// Kanban (um por especie) e a mudanca de coluna de uma caixa

import { ErroDeAplicacao, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { estadoCaixa, exigirCodigo } from '../../shared/traducao.ts'
import type { EstadoCaixa } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { casalNoCard, selecaoDoCasalNoCard } from './casalNoCard.ts'
import { conferirTransicao, selecaoDoPartoDaCaixa, situacaoDaCaixa } from './fluxoDoKanban.ts'
import { codigoDaPosicao } from './endereco.ts'
import { lerCaixasDeEstoque } from './estoque.service.ts'
import { idDaEspecie } from './infra.service.ts'

/** Quanto tempo a caixa de estoque enviada ainda aparece na coluna Enviado */
const DIAS_EM_ENVIADO = 7

/**
 * 'GET /api/quadro?especie=' - o kanban de uma especie, com as cinco colunas sempre presentes. A
 * caixa de casal fica em Livres ou Pre-reserva; a de estoque em Estoque ou Reserva, pelo que tem
 * reservado, e em Enviado por uma semana depois que a entrega a esvazia
 */
export async function montarQuadro(codigoEspecie: string) {
  const idEspecie = await idDaEspecie(codigoEspecie)
  const desde = new Date(Date.now() - DIAS_EM_ENVIADO * 86_400_000)

  const [caixas, estoque] = await Promise.all([
    prisma.caixa.findMany({
    // so caixa que ja teve casal - caixa vazia nao aparece no kanban
    where: { idEspecie, ativa: true, tipo: 'C', casais: { some: {} } },
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
  }),
    lerCaixasDeEstoque(prisma, {
      idEspecie,
      OR: [{ ativa: true }, { estado: 'X', dtManutencao: { gte: desde } }],
    }),
  ])

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
      casal: casalNoCard(caixa.casais, caixa.estado),
      estoque: null,
    })
  }

  for (const caixa of estoque) {
    colunas
      .find((c) => c.estado === estadoCaixa.paraApi(caixa.estado))
      ?.cards.push({
        idCaixa: caixa.id,
        codigo: caixa.codigo,
        numeroVisivel: caixa.numeroVisivel,
        linhagem: caixa.linhagem,
        casal: null,
        estoque: {
          sexo: caixa.sexo,
          total: caixa.total,
          reservado: caixa.reservado,
          nascimentoDe: caixa.nascimentoDe,
          nascimentoAte: caixa.nascimentoAte,
        },
      })
  }

  return { colunas }
}

export type PedidoDeTransicao = {
  estado: EstadoCaixa
  confirmar: boolean
}

/**
 * PATCH /api/caixas/:id/estado - arrastar o card para outra coluna. Confere o fluxo do kanban
 * (fluxoDoKanban.ts) e, se a caixa tem animal reservado ainda nao entregue, a mudanca so passa
 * com 'confirmar: true'
 */
export async function moverCaixa(idCaixa: number, dados: PedidoDeTransicao, idUsuario: number) {
  const caixa = await prisma.caixa.findUnique({
    where: { id: idCaixa },
    select: { id: true, ativa: true, estado: true, codigo: true, tipo: true },
  })

  if (caixa === null || !caixa.ativa) {
    throw naoEncontrado('Caixa')
  }

  if (caixa.tipo === 'E') {
    throw erroDeRegra(
      'TRANSICAO_INVALIDA',
      'A caixa de estoque muda de coluna sozinha: fica em Estoque enquanto tem animal livre e vai para Reserva quando todos estao reservados.',
    )
  }

  const estadoNovo = exigirCodigo(estadoCaixa, dados.estado, 'Estado')

  // os partos de todos os casais da caixa: a ninhada que um casal encerrado deixou continua nela
  const partos = await prisma.parto.findMany({
    where: { casal: { idCaixa } },
    select: selecaoDoPartoDaCaixa,
  })
  const situacao = situacaoDaCaixa(partos)

  conferirTransicao(caixa.estado, estadoNovo)

  if (situacao.aEntregar.m + situacao.aEntregar.f > 0 && !dados.confirmar) {
    throw erroDeRegra(
      'TRANSICAO_CONTRARIA_COMPROMISSO',
      'Esta caixa tem animais comprometidos que esta mudanca pode afetar. Confirmar mesmo assim?',
    )
  }

  const atualizada = await prisma.$transaction(async (tx) => {
    const salva = await tx.caixa.update({
      where: { id: idCaixa },
      data: { estado: estadoNovo },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'caixa',
      idEntidade: idCaixa,
      acao: 'mudanca_de_coluna',
      descricao: `Caixa ${caixa.codigo}: ${estadoCaixa.paraApi(caixa.estado)} -> ${dados.estado}`,
      dados: { antes: estadoCaixa.paraApi(caixa.estado), depois: dados.estado, confirmado: dados.confirmar },
    })

    return salva
  })

  return { idCaixa: atualizada.id, estado: estadoCaixa.paraApi(atualizada.estado) }
}

export type NovaPosicao = {
  idEstante: number
  face: 'frontal' | 'traseira'
  linha: number
  coluna: number
}

export async function mudarDePosicao(idCaixa: number, destino: NovaPosicao, idUsuario: number) {
  const caixa = await prisma.caixa.findUnique({
    where: { id: idCaixa },
    select: { id: true, ativa: true, codigo: true, idEstante: true },
  })

  if (caixa === null || !caixa.ativa) {
    throw naoEncontrado('Caixa')
  }

  const estante = await prisma.estante.findFirst({ where: { id: destino.idEstante, ativa: true } })

  if (estante === null) {
    throw naoEncontrado('Estante')
  }

  const face = destino.face === 'frontal' ? 1 : 2
  const { linha, coluna } = destino

  if (face > estante.faces || linha > estante.linhas || coluna > estante.colunas) {
    throw new ErroDeAplicacao(400, 'VALIDACAO', 'Confira os campos destacados.', {
      campos: { posicao: 'Esta posicao nao existe na estante.' },
    })
  }

  const ocupante = await prisma.caixa.findFirst({
    where: { idEstante: estante.id, face, linha, coluna, ativa: true },
    select: { id: true },
  })

  if (ocupante !== null && ocupante.id !== idCaixa) {
    throw erroDeRegra('POSICAO_OCUPADA', 'Esta posicao da estante ja tem uma caixa ativa.')
  }

  const codigo = codigoDaPosicao(face, linha, coluna, estante.colunas)

  await prisma.$transaction(async (tx) => {
    await tx.caixa.update({
      where: { id: idCaixa },
      data: { idEstante: estante.id, face, linha, coluna, codigo },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'caixa',
      idEntidade: idCaixa,
      acao: 'mudanca_de_posicao',
      descricao: `Caixa movida de ${caixa.codigo} para ${codigo} (estante ${estante.numeroVisivel})`,
      dados: {
        antes: { idEstante: caixa.idEstante, codigo: caixa.codigo },
        depois: { idEstante: estante.id, codigo },
      },
    })
  })

  return { idCaixa, idEstante: estante.id, codigo }
}
