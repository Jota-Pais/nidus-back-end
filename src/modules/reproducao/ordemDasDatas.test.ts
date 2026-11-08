import { describe, expect, it } from 'vitest'
import { exigirOrdem, foraDaOrdem } from './ordemDasDatas.ts'

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const acasalamento = { evento: 'do acasalamento', data: d('2026-09-01') }
const desmame = { evento: 'do desmame', data: d('2026-10-16') }

describe('ordem das datas', () => {
  it('no mesmo dia do evento de antes ou do de depois cabe', () => {
    expect(foraDaOrdem('2026-09-01', { depoisDe: [acasalamento] })).toBeNull()
    expect(foraDaOrdem('2026-10-16', { antesDe: [desmame] })).toBeNull()
  })

  it('antes do evento de que depende diz qual e a data dele', () => {
    expect(foraDaOrdem('2026-08-31', { depoisDe: [acasalamento] })).toBe(
      'Nao pode ser antes do acasalamento (01/09/2026).',
    )
  })

  it('depois do evento que vem a seguir tambem e recusado', () => {
    expect(foraDaOrdem('2026-10-17', { depoisDe: [acasalamento], antesDe: [desmame] })).toBe(
      'Nao pode ser depois do desmame (16/10/2026).',
    )
  })

  it('evento que ainda nao aconteceu nao limita', () => {
    expect(
      foraDaOrdem('2026-08-01', {
        depoisDe: [{ evento: 'da eutanasia', data: null }],
        antesDe: [{ evento: 'do desmame', data: undefined }],
      }),
    ).toBeNull()
  })

  it('a recusa vai no campo da data, para o formulario destacar', () => {
    expect(() => exigirOrdem('dtPartoReal', '2026-08-31', { depoisDe: [acasalamento] })).toThrow(
      expect.objectContaining({
        status: 400,
        codigo: 'VALIDACAO',
        extras: { campos: { dtPartoReal: 'Nao pode ser antes do acasalamento (01/09/2026).' } },
      }),
    )
  })
})
