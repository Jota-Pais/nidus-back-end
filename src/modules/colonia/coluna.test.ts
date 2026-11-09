import { describe, expect, it } from 'vitest'
import { colunaDaCaixa } from './coluna.ts'
import type { CaixaNoQuadro } from './coluna.ts'

const hoje = '2026-11-08'

const caixa = (parcial: Partial<CaixaNoQuadro>): CaixaNoQuadro => ({
  tipo: 'estoque',
  ativa: true,
  motivoLiberacao: null,
  dtLiberacao: null,
  vivos: 0,
  reservados: 0,
  ...parcial,
})

describe('coluna do Kanban calculada dos animais', () => {
  it('a caixa de casal ativa fica em Livres, mesmo com todos os vivos reservados', () => {
    expect(colunaDaCaixa(caixa({ tipo: 'casal', vivos: 5, reservados: 5 }), hoje)).toBe('livres')
    expect(colunaDaCaixa(caixa({ tipo: 'casal' }), hoje)).toBe('livres')
  })

  it('a de estoque fica em Reserva so quando tem vivos e todos estao reservados', () => {
    expect(colunaDaCaixa(caixa({ vivos: 4, reservados: 4 }), hoje)).toBe('reserva')
    expect(colunaDaCaixa(caixa({ vivos: 4, reservados: 3 }), hoje)).toBe('estoque')
    expect(colunaDaCaixa(caixa({ vivos: 0, reservados: 0 }), hoje)).toBe('estoque')
  })

  it('a de estoque que a entrega esvaziou fica em Enviado por 7 dias contados da entrega', () => {
    const enviada = (dtLiberacao: string) =>
      colunaDaCaixa(caixa({ ativa: false, motivoLiberacao: 'entrega', dtLiberacao }), hoje)

    expect(enviada('2026-11-08')).toBe('enviado')
    expect(enviada('2026-11-01')).toBe('enviado')
    expect(enviada('2026-10-31')).toBeNull()
  })

  it('liberada por baixa, mudanca ou casal encerrado nao aparece, nem a caixa de casal enviada', () => {
    expect(colunaDaCaixa(caixa({ ativa: false, motivoLiberacao: 'baixa', dtLiberacao: hoje }), hoje)).toBeNull()
    expect(colunaDaCaixa(caixa({ ativa: false, motivoLiberacao: 'mudanca', dtLiberacao: hoje }), hoje)).toBeNull()
    expect(
      colunaDaCaixa(caixa({ tipo: 'casal', ativa: false, motivoLiberacao: 'entrega', dtLiberacao: hoje }), hoje),
    ).toBeNull()
  })
})
