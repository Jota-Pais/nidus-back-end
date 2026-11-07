import type { Prisma } from '@prisma/client'
import { registrarHistorico } from '../historico/historico.service.ts'
import { selecaoDoPartoDaCaixa, situacaoDaCaixa } from './fluxoDoKanban.ts'

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

  const situacao = situacaoDaCaixa(caixa.casais.flatMap((casal) => casal.partos))
  const resta =
    situacao.naCaixa.m + situacao.naCaixa.f + situacao.aEntregar.m + situacao.aEntregar.f

  if (resta > 0) return false

  await tx.caixa.update({ where: { id: caixa.id }, data: { ativa: false, estado: 'R' } })

  await registrarHistorico(tx, {
    idUsuario,
    entidade: 'caixa',
    idEntidade: caixa.id,
    acao: 'liberacao',
    descricao: `Caixa ${caixa.codigo} liberada: o casal encerrou e nao sobrou animal nela`,
  })

  return true
}
