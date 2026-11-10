import { describe, expect, it } from 'vitest'
import { faseDaCaixa } from './fase.ts'
import type { CaixaParaFase } from './fase.ts'

const hoje = '2026-11-10'

const casal = (parcial: Partial<CaixaParaFase>): CaixaParaFase => ({
  tipo: 'casal',
  ativa: true,
  ninhadas: [],
  partoPrevisto: null,
  ...parcial,
})

/** uma ninhada nascida ha 'idade' dias */
const ninhada = (idade: number, desmamado: boolean) => {
  const nascimento = new Date(`${hoje}T00:00:00.000Z`)
  nascimento.setUTCDate(nascimento.getUTCDate() - idade)
  return { desmamado, dtNascimento: nascimento.toISOString().slice(0, 10) }
}

describe('fase da caixa', () => {
  it('a caixa de casal segue o que tem dentro: desmamados, depois mamando, depois o parto pendente', () => {
    expect(faseDaCaixa(casal({ partoPrevisto: '2026-11-20' }), hoje)).toEqual({ fase: 'acasalado', atrasado: false })
    expect(faseDaCaixa(casal({ ninhadas: [ninhada(10, false)], partoPrevisto: '2026-11-30' }), hoje)).toEqual({
      fase: 'mamando',
      atrasado: false,
    })
    // desmamados de um parto e filhotes do seguinte na mesma caixa: o que pede trabalho primeiro
    expect(faseDaCaixa(casal({ ninhadas: [ninhada(25, true), ninhada(2, false)] }), hoje)).toEqual({
      fase: 'pronto_estoque',
      atrasado: false,
    })
  })

  it('casal sem ciclo aberto e sem animais nao tem fase', () => {
    expect(faseDaCaixa(casal({}), hoje)).toEqual({ fase: null, atrasado: false })
  })

  it('a caixa de estoque fica em estoque e nunca atrasa; a liberada nao tem fase', () => {
    expect(faseDaCaixa({ ...casal({ ninhadas: [ninhada(40, false)] }), tipo: 'estoque' }, hoje)).toEqual({
      fase: 'estoque',
      atrasado: false,
    })
    expect(faseDaCaixa(casal({ ativa: false, partoPrevisto: '2026-10-01' }), hoje)).toEqual({ fase: null, atrasado: false })
  })

  it('o desmame atrasa depois dos 22 dias: com 22 ainda nao, com 23 sim', () => {
    expect(faseDaCaixa(casal({ ninhadas: [ninhada(22, false)] }), hoje).atrasado).toBe(false)
    expect(faseDaCaixa(casal({ ninhadas: [ninhada(23, false)] }), hoje).atrasado).toBe(true)
    // desmamado nao atrasa, por mais velho que seja
    expect(faseDaCaixa(casal({ ninhadas: [ninhada(40, true)] }), hoje).atrasado).toBe(false)
  })

  it('o parto atrasa no dia seguinte ao previsto: previsto hoje ainda nao, ontem sim', () => {
    expect(faseDaCaixa(casal({ partoPrevisto: hoje }), hoje)).toEqual({ fase: 'acasalado', atrasado: false })
    expect(faseDaCaixa(casal({ partoPrevisto: '2026-11-09' }), hoje)).toEqual({ fase: 'acasalado', atrasado: true })
  })

  it('o atraso vale em qualquer fase: filhotes mamando com o parto seguinte ja passado da data', () => {
    expect(faseDaCaixa(casal({ ninhadas: [ninhada(5, false)], partoPrevisto: '2026-11-01' }), hoje)).toEqual({
      fase: 'mamando',
      atrasado: true,
    })
  })
})
