// A mudanca de posicao de uma caixa na estante

import { agora } from '../../shared/relogio.ts'
import { erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { caixaLiberada } from '../colonia/liberacao.ts'
import { travarCaixas } from '../colonia/travas.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { lerPosicao } from './posicao.ts'
import type { PosicaoNaEstante } from './posicao.ts'

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
      throw erroDeRegra('POSICAO_OCUPADA', 'Esta posição da estante já tem uma caixa ativa.')
    }

    const movida = await tx.caixa.update({
      where: { id: idCaixa },
      data: {
        idEstante: posicao.estante.id,
        face: posicao.face,
        linha: posicao.linha,
        coluna: posicao.coluna,
        dtManutencao: agora(),
      },
      select: { codigo: true },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'caixa',
      idEntidade: idCaixa,
      acao: 'mudanca_de_posicao',
      descricao: `Caixa ${movida.codigo} mudou de lugar: de ${caixa.codigo} para ${movida.codigo} (estante ${posicao.estante.numeroVisivel})`,
      dados: {
        antes: { idEstante: caixa.idEstante, codigo: caixa.codigo },
        depois: { idEstante: posicao.estante.id, codigo: movida.codigo },
      },
    })

    return { idCaixa, idEstante: posicao.estante.id, codigo: movida.codigo }
  })
}
