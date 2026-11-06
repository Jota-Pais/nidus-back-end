import { prisma } from '../../shared/prisma.ts'
import { idDaEspecie } from '../infra/infra.service.ts'
import { compromissosAtivos, disponibilidadeDoParto } from '../reproducao/disponibilidade.ts'
import type { PorSexo } from '../reproducao/disponibilidade.ts'

type Faixa = 'confirmado' | 'previsto'

export type PartoDoEstoque = {
  dtPartoReal: Date | null
  nascidoM: number | null
  nascidoF: number | null
  eutanasiadoM: number | null
  eutanasiadoF: number | null
  desmamadoM: number | null
  desmamadoF: number | null
  compromissos: { qtdM: number; qtdF: number }[]
  casal: { idLinhagem: number }
}

function faixaDo(parto: PartoDoEstoque): Faixa | null {
  if (parto.desmamadoM !== null && parto.desmamadoF !== null) return 'confirmado'
  if (parto.nascidoM !== null && parto.nascidoF !== null) return 'previsto'
  return null
}

const somar = (a: PorSexo, b: PorSexo): PorSexo => ({ m: a.m + b.m, f: a.f + b.f })

export function montarEstoque(
  linhagens: { id: number; nome: string }[],
  partos: PartoDoEstoque[],
) {
  return linhagens.map((linhagem) => {
    const vazio = { m: 0, f: 0 }
    const faixas: Record<Faixa, PorSexo> = { confirmado: vazio, previsto: vazio }

    for (const parto of partos) {
      if (parto.casal.idLinhagem !== linhagem.id) continue

      const faixa = faixaDo(parto)
      if (faixa === null) continue

      faixas[faixa] = somar(faixas[faixa], disponibilidadeDoParto(parto).disponivel)
    }

    return {
      idLinhagem: linhagem.id,
      linhagem: linhagem.nome,
      ...faixas,
      total: somar(faixas.confirmado, faixas.previsto),
    }
  })
}

export async function consultarEstoque(codigoEspecie: string) {
  const idEspecie = await idDaEspecie(codigoEspecie)

  const [linhagens, partos] = await Promise.all([
    prisma.linhagem.findMany({
      where: { idEspecie, ativa: true },
      orderBy: { nome: 'asc' },
      select: { id: true, nome: true },
    }),
    prisma.parto.findMany({
      where: { casal: { caixa: { idEspecie, ativa: true, estado: { in: ['R', 'P', 'E'] } } } },
      select: {
        dtPartoReal: true,
        nascidoM: true,
        nascidoF: true,
        eutanasiadoM: true,
        eutanasiadoF: true,
        desmamadoM: true,
        desmamadoF: true,
        compromissos: compromissosAtivos,
        casal: { select: { idLinhagem: true } },
      },
    }),
  ])

  return { especie: codigoEspecie, linhagens: montarEstoque(linhagens, partos) }
}
