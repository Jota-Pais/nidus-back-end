import { describe, expect, it } from 'vitest'
import { descreverOcorrencia } from './descricao.ts'
import type { OcorrenciaDescrita } from './descricao.ts'

// O texto de cada ocorrencia: sem ponto de vista na tela Historico, visto da caixa na ficha (o
// eventos.test.ts confere a ficha inteira)

const animais = (m: number, f: number, idCaixa = 2) => [
  ...Array.from({ length: m }, () => ({ animal: { sexo: 'M', idCaixa } })),
  ...Array.from({ length: f }, () => ({ animal: { sexo: 'F', idCaixa } })),
]

const ocorrencia = (tipo: string, campos: Partial<OcorrenciaDescrita> = {}): OcorrenciaDescrita => ({
  id: 1,
  tipo,
  idCaixaOrigem: null,
  idCaixaDestino: null,
  idPedido: null,
  motivo: null,
  parto: null,
  caixaOrigem: null,
  caixaDestino: null,
  anulacao: null,
  animais: [],
  ...campos,
})

const doParto = { parto: { ordem: 2, casal: { identificacao: 'AB' } } }

describe('o texto da ocorrencia, sem ponto de vista', () => {
  it('nascimento, baixa e mudanca dizem as caixas', () => {
    expect(descreverOcorrencia(ocorrencia('nascimento', { ...doParto, caixaDestino: { codigo: 'F1A' }, animais: animais(5, 4) }))).toBe(
      'Nascimento do 2o parto do casal AB: 5 M, 4 F na caixa F1A.',
    )
    expect(descreverOcorrencia(ocorrencia('baixa', { caixaOrigem: { codigo: 'F2A' }, motivo: 'morte', animais: animais(1, 0) }))).toBe(
      'Baixa de 1 M, 0 F na caixa F2A: morte.',
    )
    expect(
      descreverOcorrencia(
        ocorrencia('mudanca', { idCaixaOrigem: 1, idCaixaDestino: 2, caixaOrigem: { codigo: 'F1A' }, caixaDestino: { codigo: 'F2A' }, animais: animais(3, 0) }),
      ),
    ).toBe('3 M, 0 F mudaram da caixa F1A para a caixa F2A.')
  })

  it('a reserva, a reserva desfeita e a entrega dizem o pedido; a desfeita, tambem o motivo', () => {
    expect(descreverOcorrencia(ocorrencia('reserva', { idPedido: 4, animais: animais(2, 1) }))).toBe('2 M, 1 F reservados para o pedido #4.')
    expect(descreverOcorrencia(ocorrencia('reserva_desfeita', { idPedido: 4, motivo: 'Pedido recusado: sem verba', animais: animais(2, 1) }))).toBe(
      'Reserva do pedido #4 desfeita: 2 M, 1 F voltaram a ficar livres (Pedido recusado: sem verba).',
    )
    expect(descreverOcorrencia(ocorrencia('entrega', { idPedido: 4, animais: [...animais(2, 0, 2), ...animais(0, 1, 3)] }))).toBe(
      '2 M, 1 F entregues ao pedido #4.',
    )
  })

  it('a anulacao diz para onde os animais voltaram, e a correcao, o motivo', () => {
    expect(
      descreverOcorrencia(ocorrencia('anulacao', { caixaOrigem: { codigo: 'F2A' }, motivo: 'engano', animais: animais(1, 0) })),
    ).toBe('Baixa anulada: 1 M, 0 F voltaram a viver na caixa F2A. Motivo: engano')
    expect(descreverOcorrencia(ocorrencia('correcao', { ...doParto, motivo: 'contagem errada', animais: animais(1, 0) }))).toBe(
      'Correcao do 2o parto do casal AB que mudou 1 M, 0 F: contagem errada.',
    )
  })
})

describe('o texto visto da caixa', () => {
  it('a entrega conta so os que sairam dela, e a baixa nao repete a caixa', () => {
    const entrega = ocorrencia('entrega', { idPedido: 4, animais: [...animais(2, 0, 2), ...animais(0, 1, 3)] })

    expect(descreverOcorrencia(entrega, 3)).toBe('0 M, 1 F entregues ao pedido #4.')
    expect(descreverOcorrencia(ocorrencia('baixa', { motivo: 'morte', animais: animais(1, 0) }), 2)).toBe('Baixa de 1 M, 0 F: morte.')
  })
})
