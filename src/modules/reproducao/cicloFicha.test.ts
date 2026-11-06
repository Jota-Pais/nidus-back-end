import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cicloFicha } from './reproducao.service.ts'

// O banco aqui e de mentira: devolve o parto com os compromissos ativos e a data em que a
// remessa de cada um saiu (null enquanto nao saiu)

const banco = vi.hoisted(() => ({ parto: null as Record<string, unknown> | null }))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: { parto: { findUnique: async () => banco.parto } },
}))

const dia = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const reserva = (qtdM: number, qtdF: number, entregue: string | null) => ({
  qtdM,
  qtdF,
  remessa: { dtRealizada: entregue === null ? null : dia(entregue) },
})

beforeEach(() => {
  banco.parto = {
    id: 3,
    ordem: 1,
    dtAcasalamento: dia('2026-09-08'),
    dtPartoPrevisto: dia('2026-10-01'),
    dtPartoReal: dia('2026-10-01'),
    nascidoM: 5,
    nascidoF: 5,
    dtSelecao: null,
    eutanasiadoM: null,
    eutanasiadoF: null,
    dtDesmamePrevisto: dia('2026-10-23'),
    dtDesmameReal: null,
    desmamadoM: null,
    desmamadoF: null,
    compromissos: [reserva(2, 1, '2026-11-03'), reserva(1, 1, null)],
  }
})

describe('ficha do parto depois da entrega', () => {
  it('o entregue sai do comprometido e aparece a parte', async () => {
    const ciclo = await cicloFicha(3)

    expect(ciclo.comprometido).toEqual({ m: 1, f: 1 })
    expect(ciclo).toMatchObject({ entregue: { m: 2, f: 1 } })
  })

  it('o disponivel continua descontando o entregue: o animal que saiu nao volta a ficar livre', async () => {
    const ciclo = await cicloFicha(3)

    expect(ciclo.disponivel).toEqual({ m: 2, f: 3 })
  })
})
