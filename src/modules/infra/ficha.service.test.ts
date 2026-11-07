import { describe, expect, it, vi } from 'vitest'
import { montarFicha } from './ficha.service.ts'

// Caixa com dois casais: o CD (id 2), formado depois, e o AB (id 1), encerrado no 5o parto
// com a ninhada ainda na caixa

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const partoBase = {
  dtSelecao: null,
  eutanasiadoM: null,
  eutanasiadoF: null,
  dtDesmameReal: null,
  desmamadoM: null,
  desmamadoF: null,
  compromissos: [],
  dtRegistroParto: null,
  dtRegistroSelecao: null,
  dtRegistroDesmame: null,
}

const partos = [
  {
    ...partoBase,
    id: 10,
    idCasal: 1,
    ordem: 5,
    dtAcasalamento: d('2026-10-04'),
    dtPartoPrevisto: d('2026-10-27'),
    dtPartoReal: d('2026-10-27'),
    nascidoM: 3,
    nascidoF: 4,
  },
  {
    ...partoBase,
    id: 20,
    idCasal: 2,
    ordem: 1,
    dtAcasalamento: d('2026-10-28'),
    dtPartoPrevisto: d('2026-11-20'),
    dtPartoReal: null,
    nascidoM: null,
    nascidoF: null,
  },
]

const casais = [
  { id: 2, identificacao: 'CD', grupoMacho: 'C', grupoFemea: 'D', ativo: true, dtEncerramento: null },
  { id: 1, identificacao: 'AB', grupoMacho: 'A', grupoFemea: 'B', ativo: false, dtEncerramento: d('2026-10-27') },
]

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    caixa: {
      findUnique: async () => ({
        id: 7,
        face: 1,
        linha: 1,
        coluna: 1,
        estado: 'R',
        estante: { numeroVisivel: 'E1', sala: { nome: 'Sala 1' }, colunas: 10 },
        especie: { nome: 'Rato' },
        casais: casais.map(({ id }) => ({ id })),
      }),
    },
    casal: {
      findUnique: async ({ where }: { where: { id: number } }) => {
        const casal = casais.find((c) => c.id === where.id)
        return casal && { ...casal, dtFormacao: d('2026-09-01'), linhagem: { nome: 'Wistar' } }
      },
    },
    parto: {
      findMany: async ({ where }: { where: { idCasal: number; dtPartoReal?: unknown } }) =>
        partos.filter(
          (p) => p.idCasal === where.idCasal && (where.dtPartoReal === undefined || p.dtPartoReal !== null),
        ),
      findUnique: async ({ where }: { where: { id: number } }) => partos.find((p) => p.id === where.id) ?? null,
    },
  },
}))

describe('ficha da caixa com casal novo', () => {
  it('mostra o casal novo e os partos dele', async () => {
    const ficha = await montarFicha(7)

    expect(ficha.casal?.identificacao).toBe('CD')
    expect(ficha.partos.map((p) => p.id)).toEqual([20])
  })

  it('continua mostrando a ninhada que o casal encerrado deixou na caixa', async () => {
    const ficha = await montarFicha(7)

    expect(ficha.anteriores).toEqual([
      {
        casal: expect.objectContaining({ id: 1, identificacao: 'AB', ativo: false }),
        partos: [expect.objectContaining({ id: 10, ordem: 5, nascidoM: 3, nascidoF: 4 })],
      },
    ])
  })
})
