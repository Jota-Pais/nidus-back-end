import { describe, expect, it } from 'vitest'
import { montarEstoque } from './estoque.service.ts'
import type { LivresNoEstoque } from './estoque.service.ts'

const livres = (idLinhagem: number, desmamado: boolean, sexo: string, qtd: number): LivresNoEstoque => ({
  idLinhagem,
  desmamado,
  sexo,
  qtd,
})

const linhagens = [
  { id: 1, nome: 'Wistar' },
  { id: 2, nome: 'Swiss' },
]

describe('estoque por linhagem', () => {
  it('soma os vivos livres: confirmado quem ja desmamou, previsto quem ainda mama', () => {
    const [wistar] = montarEstoque(linhagens, [
      livres(1, true, 'M', 3),
      livres(1, true, 'F', 3),
      livres(1, false, 'M', 5),
      livres(1, false, 'F', 2),
      livres(1, true, 'M', 1),
    ])

    expect(wistar).toEqual({
      idLinhagem: 1,
      linhagem: 'Wistar',
      confirmado: { m: 4, f: 3 },
      previsto: { m: 5, f: 2 },
      total: { m: 9, f: 5 },
    })
  })

  it('linhagem sem vivo livre aparece zerada', () => {
    const swiss = montarEstoque(linhagens, [livres(1, true, 'M', 3)])[1]

    expect(swiss).toMatchObject({ confirmado: { m: 0, f: 0 }, previsto: { m: 0, f: 0 }, total: { m: 0, f: 0 } })
  })
})
