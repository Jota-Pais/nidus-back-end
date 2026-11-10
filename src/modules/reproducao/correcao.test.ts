import { describe, expect, it } from 'vitest'
import { acasalamentoQueAcompanha, dePara, descricaoDaCorrecao, planoDaContagem } from './correcao.service.ts'

// O plano da correcao da contagem do nascimento. As regras da correcao contra os animais e a
// trilha estao em reproducao.regras.test.ts

const d =(iso: string) => new Date(`${iso}T00:00:00.000Z`)
const pendente = (dtAcasalamento: string) => ({ id: 2, dtAcasalamento: d(dtAcasalamento), dtPartoReal: null, dtSemNinhada: null })

describe('o acasalamento seguinte na correcao da data do nascimento', () => {
  it('o que o sistema abriu (6 dias depois) acompanha a data nova', () => {
    expect(acasalamentoQueAcompanha(pendente('2026-09-30'), '2026-09-24', '2026-09-26')).toEqual({
      idParto: 2,
      antes: '2026-09-30',
      depois: '2026-10-02',
    })
  })

  it('o corrigido a mao, o nascido e o fechado sem ninhada ficam', () => {
    expect(acasalamentoQueAcompanha(pendente('2026-09-29'), '2026-09-24', '2026-09-26')).toBeNull()
    expect(acasalamentoQueAcompanha({ ...pendente('2026-09-30'), dtPartoReal: d('2026-10-23') }, '2026-09-24', '2026-09-26')).toBeNull()
    expect(acasalamentoQueAcompanha({ ...pendente('2026-09-30'), dtSemNinhada: d('2026-10-30') }, '2026-09-24', '2026-09-26')).toBeNull()
  })

  it('sem parto seguinte, ou com a mesma data, nada acompanha', () => {
    expect(acasalamentoQueAcompanha(null, '2026-09-24', '2026-09-26')).toBeNull()
    expect(acasalamentoQueAcompanha(pendente('2026-09-30'), '2026-09-24', '2026-09-24')).toBeNull()
  })
})

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
        'Correção do 2º parto',
        [dePara('20/09/2026', '18/09/2026', 'nascimento'), dePara('2 machos e 2 fêmeas', '3 machos e 2 fêmeas', 'contagem')],
        'contagem errada',
      ),
    ).toBe('Correção do 2º parto (nascimento de 20/09/2026 para 18/09/2026; contagem de 2 machos e 2 fêmeas para 3 machos e 2 fêmeas): contagem errada')
  })

  it('o que nao mudou fica de fora', () => {
    expect(
      descricaoDaCorrecao('Correção do 1º parto', [dePara('20/09/2026', '20/09/2026', 'nascimento'), dePara('5 machos e 5 fêmeas', '4 machos e 5 fêmeas', 'contagem')], 'x'),
    ).toBe('Correção do 1º parto (contagem de 5 machos e 5 fêmeas para 4 machos e 5 fêmeas): x')
    expect(descricaoDaCorrecao('Correção do acasalamento do 1º parto', [dePara('01/09/2026', '01/09/2026')], 'x')).toBe(
      'Correção do acasalamento do 1º parto: x',
    )
  })
})
