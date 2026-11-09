// Kanban (um por especie, so de leitura) e a mudanca de posicao de uma caixa

import { erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { hojeISO, paraData } from '../../shared/traducao.ts'
import { COLUNAS, inicioDoEnviado } from '../colonia/coluna.ts'
import { caixaLiberada } from '../colonia/liberacao.ts'
import { travarCaixas } from '../colonia/travas.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { lerCards } from './card.ts'
import type { CardDaCaixa } from './card.ts'
import { idDaEspecie } from './infra.service.ts'
import { lerPosicao } from './posicao.ts'
import type { PosicaoNaEstante } from './posicao.ts'

/** O card como o Kanban o mostra */
function cardDoKanban(caixa: CardDaCaixa) {
  return {
    idCaixa: caixa.id,
    codigo: caixa.codigo,
    numeroVisivel: caixa.numeroVisivel,
    linhagem: caixa.linhagem,
    casal: caixa.casal,
    estoque: caixa.estoque,
  }
}

/**
 * GET /api/quadro?especie= - o Kanban de uma especie, com as quatro colunas sempre presentes e
 * nada gravado: a coluna de cada caixa sai do que ela tem (colunaDaCaixa). Entram as caixas
 * ativas e as de estoque que a entrega esvaziou ha menos de uma semana (Enviado)
 */
export async function montarQuadro(codigoEspecie: string, hoje: string = hojeISO()) {
  const idEspecie = await idDaEspecie(codigoEspecie)

  const caixas = await lerCards(
    prisma,
    {
      idEspecie,
      OR: [{ ativa: true }, { motivoLiberacao: 'entrega', dtLiberacao: { gte: paraData(inicioDoEnviado(hoje)) } }],
    },
    hoje,
  )

  return {
    colunas: COLUNAS.map((estado) => ({
      estado,
      cards: caixas.filter((caixa) => caixa.estado === estado).map(cardDoKanban),
    })),
  }
}

/**
 * PATCH /api/caixas/:id/posicao - a caixa muda de lugar na estante, com tudo o que tem: os animais
 * apontam para a caixa, nao para o endereco. O codigo novo quem escreve e o trigger da posicao
 */
export async function mudarDePosicao(idCaixa: number, destino: PosicaoNaEstante, idUsuario: number) {
  return prisma.$transaction(async (tx) => {
    await travarCaixas(tx, [idCaixa])

    const caixa = await tx.caixa.findUnique({
      where: { id: idCaixa },
      select: { id: true, ativa: true, codigo: true, idEstante: true },
    })

    if (caixa === null) throw naoEncontrado('Caixa')
    if (!caixa.ativa) throw caixaLiberada(caixa.codigo)

    const posicao = await lerPosicao(tx, destino, 'posicao')

    if (posicao.ocupante !== null && posicao.ocupante.id !== idCaixa) {
      throw erroDeRegra('POSICAO_OCUPADA', 'Esta posicao da estante ja tem uma caixa ativa.')
    }

    const movida = await tx.caixa.update({
      where: { id: idCaixa },
      data: {
        idEstante: posicao.estante.id,
        face: posicao.face,
        linha: posicao.linha,
        coluna: posicao.coluna,
        dtManutencao: new Date(),
      },
      select: { codigo: true },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'caixa',
      idEntidade: idCaixa,
      acao: 'mudanca_de_posicao',
      descricao: `Caixa movida de ${caixa.codigo} para ${movida.codigo} (estante ${posicao.estante.numeroVisivel})`,
      dados: {
        antes: { idEstante: caixa.idEstante, codigo: caixa.codigo },
        depois: { idEstante: posicao.estante.id, codigo: movida.codigo },
      },
    })

    return { idCaixa, idEstante: posicao.estante.id, codigo: movida.codigo }
  })
}
