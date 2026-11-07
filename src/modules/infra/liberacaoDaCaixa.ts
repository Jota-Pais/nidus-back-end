import type { Prisma } from '@prisma/client'
import { registrarHistorico } from '../historico/historico.service.ts'
import { naCaixa } from '../reproducao/disponibilidade.ts'
import { selecaoDoPartoDaCaixa, situacaoDaCaixa } from './fluxoDoKanban.ts'
import type { PartoDaCaixa } from './fluxoDoKanban.ts'

export const caixaComEstoque = {
  OR: [{ ativa: true, estado: { in: ['R', 'P', 'E'] } }, { ativa: false }],
}

function temFilhoteMamando(parto: PartoDaCaixa): boolean {
  if (parto.nascidoM === null || parto.desmamadoM !== null) return false
  const resta = naCaixa(parto)
  return resta.m + resta.f > 0
}

export async function liberarCaixaVazia(
  tx: Prisma.TransactionClient,
  idCaixa: number,
  idUsuario: number | null,
): Promise<boolean> {
  const caixa = await tx.caixa.findUnique({
    where: { id: idCaixa },
    select: {
      id: true,
      codigo: true,
      ativa: true,
      casais: { select: { ativo: true, partos: { select: selecaoDoPartoDaCaixa } } },
    },
  })

  if (caixa === null || !caixa.ativa || caixa.casais.some((casal) => casal.ativo)) return false

  const partos = caixa.casais.flatMap((casal) => casal.partos)
  const { aEntregar } = situacaoDaCaixa(partos)

  if (aEntregar.m + aEntregar.f > 0 || partos.some(temFilhoteMamando)) return false

  await tx.caixa.update({ where: { id: caixa.id }, data: { ativa: false, estado: 'R' } })

  await registrarHistorico(tx, {
    idUsuario,
    entidade: 'caixa',
    idEntidade: caixa.id,
    acao: 'liberacao',
    descricao: `Caixa ${caixa.codigo} liberada: o casal encerrou e nao ha filhote mamando nem reserva a entregar. Os desmamados seguem no estoque`,
  })

  return true
}
