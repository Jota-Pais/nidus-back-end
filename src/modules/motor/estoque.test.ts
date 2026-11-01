import { describe, expect, it } from 'vitest'
import { montarEstoque } from './estoque.service.ts'
import type { PartoDoEstoque } from './estoque.service.ts'

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const parto = (dados: Partial<PartoDoEstoque>): PartoDoEstoque => ({
  dtPartoReal: null,
  dtPartoPrevisto: d('2026-11-20'),
  nascidoM: null,
  nascidoF: null,
  eutanasiadoM: null,
  eutanasiadoF: null,
  desmamadoM: null,
  desmamadoF: null,
  compromissos: [],
  casal: { idLinhagem: 1, ativo: true },
  ...dados,
})

const linhagens = [
  { id: 1, nome: 'Wistar' },
  { id: 2, nome: 'Swiss' },
]

describe('estoque por linhagem', () => {
  it('separa desmamado, nascido e parto previsto, ja sem os compromissos', () => {
    const [wistar] = montarEstoque(linhagens, [
      parto({ nascidoM: 5, nascidoF: 5, desmamadoM: 4, desmamadoF: 3, compromissos: [{ qtdM: 1, qtdF: 0 }] }),
      parto({ nascidoM: 6, nascidoF: 2, eutanasiadoM: 1, eutanasiadoF: 0 }),
      parto({}),
    ])

    expect(wistar).toMatchObject({
      confirmado: { m: 3, f: 3 },
      previsto: { m: 5, f: 2 },
      projetado: { m: 4, f: 4 },
      total: { m: 12, f: 9 },
      proximoParto: '2026-11-20',
    })
  })

  it('linhagem sem caixa aparece zerada', () => {
    const swiss = montarEstoque(linhagens, [parto({})])[1]

    expect(swiss).toMatchObject({ total: { m: 0, f: 0 }, proximoParto: null })
  })

  it('parto que nao vai acontecer, de casal encerrado, nao conta', () => {
    const [wistar] = montarEstoque(linhagens, [parto({ casal: { idLinhagem: 1, ativo: false } })])

    expect(wistar?.projetado).toEqual({ m: 0, f: 0 })
  })

  it('ninhada de casal encerrado continua contando', () => {
    const [wistar] = montarEstoque(linhagens, [
      parto({ nascidoM: 3, nascidoF: 3, casal: { idLinhagem: 1, ativo: false } }),
    ])

    expect(wistar?.previsto).toEqual({ m: 3, f: 3 })
  })
})
