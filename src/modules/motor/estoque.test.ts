import { describe, expect, it } from 'vitest'
import { montarEstoque } from './estoque.service.ts'
import type { PartoDoEstoque } from './estoque.service.ts'

const parto = (dados: Partial<PartoDoEstoque>): PartoDoEstoque => ({
  dtPartoReal: null,
  nascidoM: null,
  nascidoF: null,
  eutanasiadoM: null,
  eutanasiadoF: null,
  desmamadoM: null,
  desmamadoF: null,
  compromissos: [],
  casal: { idLinhagem: 1 },
  ...dados,
})

const linhagens = [
  { id: 1, nome: 'Wistar' },
  { id: 2, nome: 'Swiss' },
]

describe('estoque por linhagem', () => {
  it('separa desmamado e nascido, ja sem os compromissos; parto que nao nasceu nao conta', () => {
    const [wistar] = montarEstoque(linhagens, [
      parto({ nascidoM: 5, nascidoF: 5, desmamadoM: 4, desmamadoF: 3, compromissos: [{ qtdM: 1, qtdF: 0 }] }),
      parto({ nascidoM: 6, nascidoF: 2, eutanasiadoM: 1, eutanasiadoF: 0 }),
      parto({}),
    ])

    expect(wistar).toMatchObject({
      confirmado: { m: 3, f: 3 },
      previsto: { m: 5, f: 2 },
      total: { m: 8, f: 5 },
    })
  })

  it('linhagem sem caixa aparece zerada', () => {
    const swiss = montarEstoque(linhagens, [parto({})])[1]

    expect(swiss).toMatchObject({ total: { m: 0, f: 0 } })
  })

  it('a ninhada fica no estoque com o que nasceu, mesmo depois do proximo parto ser previsto', () => {
    const [wistar] = montarEstoque(linhagens, [
      parto({ nascidoM: 3, nascidoF: 3 }),
      parto({}),
    ])

    expect(wistar?.previsto).toEqual({ m: 3, f: 3 })
  })
})
