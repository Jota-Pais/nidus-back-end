import { describe, expect, it } from 'vitest'
import { planoDaContagem } from './correcao.service.ts'

// O plano da correcao da contagem do nascimento. As regras da correcao contra os animais e a
// trilha estao em reproducao.regras.test.ts

describe('plano da correcao da contagem', () => {
  it('um sexo sobe e o outro desce: a diferenca comum e troca de sexo', () => {
    expect(planoDaContagem({ m: 5, f: 5 }, { m: 6, f: 4 })).toEqual({
      troca: { de: 'F', para: 'M', qtd: 1 },
      novos: { m: 0, f: 0 },
      anular: { m: 0, f: 0 },
    })
  })

  it('troca e animal a mais juntos', () => {
    expect(planoDaContagem({ m: 5, f: 5 }, { m: 7, f: 4 })).toEqual({
      troca: { de: 'F', para: 'M', qtd: 1 },
      novos: { m: 1, f: 0 },
      anular: { m: 0, f: 0 },
    })
  })

  it('troca e registro a anular juntos', () => {
    expect(planoDaContagem({ m: 5, f: 5 }, { m: 3, f: 6 })).toEqual({
      troca: { de: 'M', para: 'F', qtd: 1 },
      novos: { m: 0, f: 0 },
      anular: { m: 1, f: 0 },
    })
  })

  it('os dois sobem ou os dois descem: so animais a mais ou registros a anular', () => {
    expect(planoDaContagem({ m: 5, f: 5 }, { m: 6, f: 7 })).toEqual({
      troca: null,
      novos: { m: 1, f: 2 },
      anular: { m: 0, f: 0 },
    })
    expect(planoDaContagem({ m: 5, f: 5 }, { m: 4, f: 5 })).toEqual({
      troca: null,
      novos: { m: 0, f: 0 },
      anular: { m: 1, f: 0 },
    })
  })

  it('a mesma contagem nao muda nada', () => {
    expect(planoDaContagem({ m: 5, f: 5 }, { m: 5, f: 5 })).toEqual({
      troca: null,
      novos: { m: 0, f: 0 },
      anular: { m: 0, f: 0 },
    })
  })
})
