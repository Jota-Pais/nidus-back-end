// Catalogo: as especies com as linhagens e os pares geneticos, numa chamada so

import { prisma } from '../../shared/prisma.ts'
import { codigoDaEspecie } from '../../shared/traducao.ts'

export async function montarCatalogo() {
  const [especies, pares] = await Promise.all([
    prisma.especie.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        nome: true,
        linhagens: {
          orderBy: { id: 'asc' },
          select: { id: true, nome: true, ativa: true },
        },
      },
    }),

    prisma.grupoGeneticoPar.findMany({
      where: { ativo: true },
      orderBy: [{ grupoMacho: 'asc' }, { grupoFemea: 'asc' }],
      select: { grupoMacho: true, grupoFemea: true },
    }),
  ])

  return {
    especies: especies.map((especie) => ({
      id: especie.id,
      codigo: codigoDaEspecie(especie.nome),
      nome: especie.nome,
      linhagens: especie.linhagens,
    })),
    paresGeneticos: pares,
  }
}
