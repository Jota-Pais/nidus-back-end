import type { Prisma } from '@prisma/client'
import { prisma } from '../../shared/prisma.ts'

type BancoComHistorico = Pick<Prisma.TransactionClient, 'historico'>

export type Alteracao = {
  idUsuario: number
  entidade: 'caixa' | 'casal' | 'parto' | 'solicitacao' | 'usuario' | 'projeto' | 'linhagem' | 'estante'
  idEntidade: number
  acao: string
  descricao: string
  dados?: Prisma.InputJsonValue
}

export function registrarHistorico(banco: BancoComHistorico, alteracao: Alteracao) {
  return banco.historico.create({
    data: {
      idUsuario: alteracao.idUsuario,
      entidade: alteracao.entidade,
      idEntidade: alteracao.idEntidade,
      acao: alteracao.acao,
      descricao: alteracao.descricao.slice(0, 300),
      ...(alteracao.dados === undefined ? {} : { dados: alteracao.dados }),
    },
  })
}

export type FiltroDoHistorico = {
  entidade?: string | undefined
  idEntidade?: number | undefined
  limite: number
}

export async function listarHistorico(filtro: FiltroDoHistorico) {
  const registros = await prisma.historico.findMany({
    where: {
      ...(filtro.entidade === undefined ? {} : { entidade: filtro.entidade }),
      ...(filtro.idEntidade === undefined ? {} : { idEntidade: filtro.idEntidade }),
    },
    orderBy: { id: 'desc' },
    take: filtro.limite,
    include: { usuario: { select: { nome: true } } },
  })

  return {
    historico: registros.map((registro) => ({
      id: registro.id,
      dataHora: registro.dtHora.toISOString(),
      usuario: registro.usuario.nome,
      entidade: registro.entidade,
      idEntidade: registro.idEntidade,
      acao: registro.acao,
      descricao: registro.descricao,
      dados: registro.dados,
    })),
  }
}
