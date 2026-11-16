// Catalogo: as especies com as linhagens, numa chamada so

import { prisma } from '../../shared/prisma.ts'
import { codigoDaEspecie } from '../../shared/traducao.ts'

export async function montarCatalogo() {
  const especies = await prisma.especie.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true,
      nome: true,
      linhagens: {
        orderBy: { id: 'asc' },
        select: { id: true, nome: true, ativa: true },
      },
    },
  })

  return {
    especies: especies.map((especie) => ({
      id: especie.id,
      codigo: codigoDaEspecie(especie.nome),
      nome: especie.nome,
      linhagens: especie.linhagens,
    })),
  }
}
