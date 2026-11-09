// O que a colonia tem livre, por linhagem: os vivos sem reserva, contados nos animais. Confirmado
// e quem ja desmamou; previsto, quem ainda mama. Quem morreu sai pela baixa

import { prisma } from '../../shared/prisma.ts'
import type { PorSexo } from '../colonia/tipos.ts'
import { idDaEspecie } from '../infra/infra.service.ts'

type Faixa = 'confirmado' | 'previsto'

/** Os vivos livres de um parto, num sexo */
export type LivresNoEstoque = { idLinhagem: number; desmamado: boolean; sexo: string; qtd: number }

export function montarEstoque(linhagens: { id: number; nome: string }[], livres: LivresNoEstoque[]) {
  return linhagens.map((linhagem) => {
    const faixas: Record<Faixa, PorSexo> = { confirmado: { m: 0, f: 0 }, previsto: { m: 0, f: 0 } }

    for (const grupo of livres) {
      if (grupo.idLinhagem !== linhagem.id) continue

      const faixa = faixas[grupo.desmamado ? 'confirmado' : 'previsto']
      if (grupo.sexo === 'M') faixa.m += grupo.qtd
      else faixa.f += grupo.qtd
    }

    return {
      idLinhagem: linhagem.id,
      linhagem: linhagem.nome,
      ...faixas,
      total: { m: faixas.confirmado.m + faixas.previsto.m, f: faixas.confirmado.f + faixas.previsto.f },
    }
  })
}

/** GET /api/estoque */
export async function consultarEstoque(codigoEspecie: string) {
  const idEspecie = await idDaEspecie(codigoEspecie)

  const [linhagens, linhas] = await Promise.all([
    prisma.linhagem.findMany({
      where: { idEspecie, ativa: true },
      orderBy: { nome: 'asc' },
      select: { id: true, nome: true },
    }),
    prisma.animal.groupBy({
      by: ['idParto', 'sexo'],
      where: { situacao: 'vivo', idPedido: null, caixa: { idEspecie } },
      _count: { _all: true },
    }),
  ])

  const partos =
    linhas.length === 0
      ? []
      : await prisma.parto.findMany({
          where: { id: { in: [...new Set(linhas.map((linha) => linha.idParto))] } },
          select: { id: true, dtDesmameReal: true, casal: { select: { idLinhagem: true } } },
        })

  const livres = linhas.flatMap((linha): LivresNoEstoque[] => {
    const parto = partos.find((p) => p.id === linha.idParto)
    if (parto === undefined) return []

    return [
      {
        idLinhagem: parto.casal.idLinhagem,
        desmamado: parto.dtDesmameReal !== null,
        sexo: linha.sexo,
        qtd: linha._count._all,
      },
    ]
  })

  return { especie: codigoEspecie, linhagens: montarEstoque(linhagens, livres) }
}
