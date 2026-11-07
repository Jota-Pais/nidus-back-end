import type { Prisma } from '@prisma/client'
import { prisma } from '../../shared/prisma.ts'

type BancoComHistorico = Pick<Prisma.TransactionClient, 'historico'>

/** Nome mostrado em "Quem" quando nao ha pessoa por tras da acao */
export const NOME_DO_SISTEMA = 'Sistema'

export type Alteracao = {
  /** null so quando foi o proprio sistema. Obrigatorio para nenhuma acao ficar sem dono por esquecimento */
  idUsuario: number | null
  entidade: 'caixa' | 'casal' | 'parto' | 'solicitacao' | 'usuario' | 'projeto' | 'linhagem' | 'sala' | 'estante'
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
  busca?: string | undefined
  limite: number
}

export async function listarHistorico(filtro: FiltroDoHistorico) {
  const registros = await prisma.historico.findMany({
    where: {
      ...(filtro.entidade === undefined ? {} : { entidade: filtro.entidade }),
      ...(filtro.idEntidade === undefined ? {} : { idEntidade: filtro.idEntidade }),
      ...(filtro.busca === undefined
        ? {}
        : {
            OR: [
              { descricao: { contains: filtro.busca, mode: 'insensitive' as const } },
              { usuario: { nome: { contains: filtro.busca, mode: 'insensitive' as const } } },
              // quem busca por "Sistema" acha o que o sistema fez, como na coluna Quem
              ...(NOME_DO_SISTEMA.toLowerCase().includes(filtro.busca.toLowerCase()) ? [{ idUsuario: null }] : []),
            ],
          }),
    },
    orderBy: { id: 'desc' },
    take: filtro.limite,
    include: { usuario: { select: { nome: true } } },
  })

  return {
    historico: registros.map((registro) => ({
      id: registro.id,
      dataHora: registro.dtHora.toISOString(),
      usuario: registro.usuario?.nome ?? NOME_DO_SISTEMA,
      entidade: registro.entidade,
      idEntidade: registro.idEntidade,
      acao: registro.acao,
      descricao: registro.descricao,
      dados: registro.dados,
    })),
  }
}
