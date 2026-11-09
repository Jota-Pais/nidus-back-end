import { describe, expect, it } from 'vitest'
import { dePara, descricaoDaCorrecao, planoDaContagem } from './correcao.service.ts'

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

describe('descricao da correcao, que a ficha mostra como evento', () => {
  it('diz o que mudou entre parenteses, antes do motivo', () => {
    expect(
      descricaoDaCorrecao(
        'Correcao do 2o parto',
        [dePara('20/09/2026', '18/09/2026', 'nascimento'), dePara('2 machos e 2 femeas', '3 machos e 2 femeas', 'contagem')],
        'contagem errada',
      ),
    ).toBe('Correcao do 2o parto (nascimento de 20/09/2026 para 18/09/2026; contagem de 2 machos e 2 femeas para 3 machos e 2 femeas): contagem errada')
  })

  it('o que nao mudou fica de fora', () => {
    expect(
      descricaoDaCorrecao('Correcao do 1o parto', [dePara('20/09/2026', '20/09/2026', 'nascimento'), dePara('5 machos e 5 femeas', '4 machos e 5 femeas', 'contagem')], 'x'),
    ).toBe('Correcao do 1o parto (contagem de 5 machos e 5 femeas para 4 machos e 5 femeas): x')
    expect(descricaoDaCorrecao('Correcao do acasalamento do 1o parto', [dePara('01/09/2026', '01/09/2026')], 'x')).toBe(
      'Correcao do acasalamento do 1o parto: x',
    )
  })
})
