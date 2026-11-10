import { describe, expect, it } from 'vitest'
import type { Reservado } from '../colonia/escolha.ts'
import { exigirQueServemNaEntrega } from './entrega.service.ts'
import { conferirReserva, descreverQuantidade, exigirQueRecebeReserva, statusDo } from './pedido.ts'
import { somarPorLugar } from './reserva.service.ts'

// As regras do pedido sem banco: o status, a conta da reserva contra o que ele pede e a idade na
// data da entrega

const recusa = (codigo: string, trecho: string) =>
  expect.objectContaining({ status: 409, codigo, message: expect.stringContaining(trecho) })

/** 2 machos, 1 femea e 2 de qualquer sexo */
const pedido = { qtdM: 2, qtdF: 1, qtdQualquer: 2 }
const nada = { m: 0, f: 0 }

describe('status do pedido', () => {
  it('le o status do banco, que ja guarda a palavra', () => {
    expect(statusDo({ status: 'reservado' })).toBe('reservado')
  })

  it('status fora do dominio e bug, nao entrada do usuario', () => {
    expect(() => statusDo({ status: 'AP' })).toThrow(/fora do dominio/)
  })
})

describe('quantidade no texto', () => {
  it('so o que nao e zero, no singular e no plural', () => {
    expect(descreverQuantidade({ m: 2, f: 1, qualquer: 3 })).toBe('2 machos, 1 fêmea e 3 de qualquer sexo')
    expect(descreverQuantidade({ m: 1, f: 0, qualquer: 0 })).toBe('1 macho')
    expect(descreverQuantidade({ m: 0, f: 2, qualquer: 1 })).toBe('2 fêmeas e 1 de qualquer sexo')
  })
})

describe('a reserva contra o pedido', () => {
  it('o pedido aprovado so se reserva inteiro, o qualquer virando macho ou femea', () => {
    expect(() => conferirReserva(pedido, nada, { m: 4, f: 1 }, true)).not.toThrow()
    expect(() => conferirReserva(pedido, nada, { m: 2, f: 3 }, true)).not.toThrow()
    expect(() => conferirReserva(pedido, nada, { m: 2, f: 2 }, true)).toThrow(
      recusa('PEDIDO_INCOMPLETO', 'falta 1 de qualquer sexo'),
    )
    expect(() => conferirReserva(pedido, nada, { m: 1, f: 0 }, true)).toThrow(
      recusa('PEDIDO_INCOMPLETO', 'faltam 1 macho, 1 fêmea e 2 de qualquer sexo'),
    )
  })

  it('nunca passa do pedido: nem o sexo acima de qtd mais o qualquer, nem o total', () => {
    expect(() => conferirReserva(pedido, nada, { m: 5, f: 0 }, true)).toThrow(
      recusa('PEDIDO_EXCEDIDO', 'ficariam 5 machos para um pedido de 2 machos, 1 fêmea e 2 de qualquer sexo'),
    )
    expect(() => conferirReserva(pedido, nada, { m: 0, f: 4 }, false)).toThrow(recusa('PEDIDO_EXCEDIDO', ''))
    expect(() => conferirReserva(pedido, nada, { m: 3, f: 3 }, false)).toThrow(recusa('PEDIDO_EXCEDIDO', ''))
  })

  it('a reserva em falta se completa aos poucos, somando ao que o pedido ja tem, ate cobrir', () => {
    const tem = { m: 2, f: 1 }

    expect(() => conferirReserva(pedido, tem, { m: 1, f: 0 }, false)).not.toThrow()
    expect(() => conferirReserva(pedido, tem, { m: 1, f: 1 }, false)).not.toThrow()
    expect(() => conferirReserva(pedido, tem, { m: 2, f: 1 }, false)).toThrow(recusa('PEDIDO_EXCEDIDO', 'ficariam 4 machos e 2 fêmeas'))
  })
})

describe('quem recebe reserva', () => {
  const semFalta = { m: 0, f: 0, qualquer: 0 }
  const comFalta = { m: 1, f: 0, qualquer: 0 }

  it('o aprovado; o reservado, so para completar a falta', () => {
    expect(() => exigirQueRecebeReserva(7, 'aprovado', semFalta)).not.toThrow()
    expect(() => exigirQueRecebeReserva(7, 'reservado', comFalta)).not.toThrow()
    expect(() => exigirQueRecebeReserva(7, 'reservado', semFalta)).toThrow(recusa('PEDIDO_JA_RESERVADO', '#7 já estão reservados'))
  })

  it('o enviado espera a aprovacao; o entregue e o recusado nao recebem mais', () => {
    expect(() => exigirQueRecebeReserva(7, 'enviado', semFalta)).toThrow(recusa('SEQUENCIA_INVALIDA', 'Aprove o pedido'))
    expect(() => exigirQueRecebeReserva(7, 'entregue', semFalta)).toThrow(recusa('SEQUENCIA_INVALIDA', 'está entregue'))
    expect(() => exigirQueRecebeReserva(7, 'recusado', comFalta)).toThrow(recusa('SEQUENCIA_INVALIDA', 'está recusado'))
  })
})

describe('os lugares da reserva', () => {
  it('o mesmo lugar (caixa e nascimento) vira um item so; outro nascimento na mesma caixa, nao', () => {
    expect(
      somarPorLugar([
        { idCaixa: 2, dtNascimento: '2026-09-01', machos: 1, femeas: 0 },
        { idCaixa: 3, dtNascimento: '2026-09-01', machos: 0, femeas: 2 },
        { idCaixa: 2, dtNascimento: '2026-09-01', machos: 2, femeas: 0 },
        { idCaixa: 2, dtNascimento: '2026-09-05', machos: 1, femeas: 0 },
      ]),
    ).toEqual([
      { idCaixa: 2, dtNascimento: '2026-09-01', machos: 3, femeas: 0 },
      { idCaixa: 3, dtNascimento: '2026-09-01', machos: 0, femeas: 2 },
      { idCaixa: 2, dtNascimento: '2026-09-05', machos: 1, femeas: 0 },
    ])
  })
})

describe('a idade na data real da entrega', () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
  const reservado = (id: number, campos: Partial<Reservado> = {}): Reservado => ({
    id,
    idCaixa: 2,
    idPedido: 7,
    dtMovimento: null,
    dtNascimento: d('2026-09-01'),
    sexo: 'M',
    idParto: 1,
    dtDesmameReal: d('2026-09-23'),
    codigo: 'F2A',
    ...campos,
  })
  // o pedido de 60 a 70 dias aceita de 53 a 80
  const faixa = { min: 53, max: 80 }

  it('dentro da faixa aceita, as pontas inclusive', () => {
    expect(() => exigirQueServemNaEntrega([reservado(1)], faixa, '2026-10-24')).not.toThrow()
    expect(() => exigirQueServemNaEntrega([reservado(1)], faixa, '2026-11-20')).not.toThrow()
  })

  it('fora da faixa e IDADE_FORA_DA_FAIXA, dizendo de quem, quantos e a idade no dia, com a data legivel', () => {
    expect(() => exigirQueServemNaEntrega([reservado(1), reservado(2)], faixa, '2026-11-21')).toThrow(
      recusa(
        'IDADE_FORA_DA_FAIXA',
        'Na entrega em 21/11/2026, 2 machos da caixa F2A (nascimento em 01/09/2026) teriam 81 dias, fora da idade aceita no pedido (53 a 80 dias).',
      ),
    )
    expect(() => exigirQueServemNaEntrega([reservado(1)], faixa, '2026-10-23')).toThrow(
      recusa('IDADE_FORA_DA_FAIXA', 'Na entrega em 23/10/2026, 1 macho da caixa F2A (nascimento em 01/09/2026) teria 52 dias'),
    )
  })

  it('basta um grupo fora da faixa para a entrega inteira parar', () => {
    const novos = reservado(3, { idParto: 2, dtNascimento: d('2026-10-01'), dtDesmameReal: d('2026-10-23'), sexo: 'F' })

    expect(() => exigirQueServemNaEntrega([reservado(1), novos], faixa, '2026-11-08')).toThrow(
      recusa('IDADE_FORA_DA_FAIXA', 'Na entrega em 08/11/2026, 1 fêmea da caixa F2A (nascimento em 01/10/2026) teria 38 dias'),
    )
  })

  it('sem o desmame registrado, ou desmamado depois da entrega, e NAO_DESMAMADO', () => {
    expect(() => exigirQueServemNaEntrega([reservado(1, { dtDesmameReal: null })], faixa, '2026-11-08')).toThrow(
      recusa(
        'NAO_DESMAMADO',
        'O desmame de 1 macho da caixa F2A (nascimento em 01/09/2026) ainda não foi registrado: registre o desmame antes da entrega.',
      ),
    )
    expect(() =>
      exigirQueServemNaEntrega([reservado(1, { dtDesmameReal: d('2026-11-09') }), reservado(2, { dtDesmameReal: d('2026-11-09') })], faixa, '2026-11-08'),
    ).toThrow(
      recusa(
        'NAO_DESMAMADO',
        'O desmame de 2 machos da caixa F2A (nascimento em 01/09/2026) foi em 09/11/2026, depois da data da entrega.',
      ),
    )
  })
})
