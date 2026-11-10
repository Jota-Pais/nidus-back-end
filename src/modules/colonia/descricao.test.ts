import { describe, expect, it } from 'vitest'
import { descreverOcorrencia } from './descricao.ts'
import type { OcorrenciaDescrita } from './descricao.ts'

// O texto de cada ocorrencia: sem ponto de vista na tela Historico, visto da caixa na ficha (o
// eventos.test.ts confere a ficha inteira). A quantidade concorda com o numero, e o sexo sem
// animal nao aparece

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
  anulacoes: [],
  animais: [],
  ...campos,
})

const doParto = { parto: { ordem: 2, casal: { identificacao: 'AB' } } }

describe('o texto da ocorrencia, sem ponto de vista', () => {
  it('nascimento, baixa e mudanca dizem as caixas', () => {
    expect(descreverOcorrencia(ocorrencia('nascimento', { ...doParto, caixaDestino: { codigo: 'F1A' }, animais: animais(5, 4) }))).toBe(
      'Nascimento do 2º parto do casal AB: 5 machos e 4 fêmeas na caixa F1A.',
    )
    expect(descreverOcorrencia(ocorrencia('baixa', { caixaOrigem: { codigo: 'F2A' }, motivo: 'morte', animais: animais(1, 0) }))).toBe(
      'Baixa de 1 macho na caixa F2A: morte.',
    )
    expect(
      descreverOcorrencia(
        ocorrencia('mudanca', { idCaixaOrigem: 1, idCaixaDestino: 2, caixaOrigem: { codigo: 'F1A' }, caixaDestino: { codigo: 'F2A' }, animais: animais(3, 0) }),
      ),
    ).toBe('3 machos mudaram da caixa F1A para a caixa F2A.')
    expect(
      descreverOcorrencia(
        ocorrencia('mudanca', { idCaixaOrigem: 1, idCaixaDestino: 2, caixaOrigem: { codigo: 'F1A' }, caixaDestino: { codigo: 'F2A' }, animais: animais(0, 1) }),
      ),
    ).toBe('1 fêmea mudou da caixa F1A para a caixa F2A.')
  })

  it('as baixas do parto dizem de que parto, e a anulada diz que foi anulada', () => {
    expect(descreverOcorrencia(ocorrencia('baixa', { ...doParto, motivo: 'eutanasia de selecao', animais: animais(1, 1) }))).toBe(
      'Eutanásia de seleção do 2º parto do casal AB: 1 macho e 1 fêmea.',
    )
    expect(
      descreverOcorrencia(
        ocorrencia('baixa', { ...doParto, motivo: 'nao chegou ao desmame', animais: animais(0, 1), anulacoes: [{ id: 9 }] }),
      ),
    ).toBe('1 fêmea do 2º parto do casal AB não chegou ao desmame. (anulada)')
  })

  it('a reserva, a reserva desfeita e a entrega dizem o pedido; a desfeita, tambem o motivo', () => {
    expect(descreverOcorrencia(ocorrencia('reserva', { idPedido: 4, animais: animais(2, 1) }))).toBe(
      'Reserva para o pedido #4: 2 machos e 1 fêmea.',
    )
    expect(descreverOcorrencia(ocorrencia('reserva_desfeita', { idPedido: 4, motivo: 'Pedido recusado: sem verba', animais: animais(2, 1) }))).toBe(
      'Reserva do pedido #4 desfeita: 2 machos e 1 fêmea voltaram a ficar livres (Pedido recusado: sem verba).',
    )
    expect(descreverOcorrencia(ocorrencia('reserva_desfeita', { idPedido: 4, animais: [] }))).toBe(
      'Reserva do pedido #4 desfeita: nenhum animal voltou a ficar livre.',
    )
    expect(descreverOcorrencia(ocorrencia('entrega', { idPedido: 4, animais: [...animais(2, 0, 2), ...animais(0, 1, 3)] }))).toBe(
      '2 machos e 1 fêmea entregues ao pedido #4.',
    )
  })

  it('a anulacao diz para onde os animais voltaram, e a correcao, o motivo', () => {
    expect(
      descreverOcorrencia(ocorrencia('anulacao', { caixaOrigem: { codigo: 'F2A' }, motivo: 'engano', animais: animais(1, 0) })),
    ).toBe('Baixa anulada: 1 macho voltou a viver na caixa F2A. Motivo: engano')
    expect(
      descreverOcorrencia(
        ocorrencia('anulacao', {
          idCaixaOrigem: 1,
          idCaixaDestino: 3,
          caixaOrigem: { codigo: 'F1A' },
          caixaDestino: { codigo: 'E03' },
          motivo: 'engano',
          animais: animais(2, 0),
        }),
      ),
    ).toBe('Baixa da caixa F1A anulada: 2 machos voltaram para a caixa E03. Motivo: engano')
    expect(descreverOcorrencia(ocorrencia('correcao', { ...doParto, motivo: 'contagem errada', animais: animais(1, 0) }))).toBe(
      'Correção do 2º parto do casal AB que mudou 1 macho: contagem errada.',
    )
  })
})

describe('o texto visto da caixa', () => {
  it('a entrega conta so os que sairam dela, e a baixa nao repete a caixa', () => {
    const entrega = ocorrencia('entrega', { idPedido: 4, animais: [...animais(2, 0, 2), ...animais(0, 1, 3)] })

    expect(descreverOcorrencia(entrega, 3)).toBe('1 fêmea entregue ao pedido #4.')
    expect(descreverOcorrencia(ocorrencia('baixa', { motivo: 'morte', animais: animais(1, 0) }), 2)).toBe('Baixa de 1 macho: morte.')
  })

  it('a mudanca diz se os animais sairam ou chegaram', () => {
    const mudanca = ocorrencia('mudanca', {
      idCaixaOrigem: 1,
      idCaixaDestino: 2,
      caixaOrigem: { codigo: 'F1A' },
      caixaDestino: { codigo: 'F2A' },
      animais: animais(1, 0),
    })

    expect(descreverOcorrencia(mudanca, 1)).toBe('1 macho mudou para a caixa F2A.')
    expect(descreverOcorrencia(mudanca, 2)).toBe('1 macho chegou da caixa F1A.')
  })

  it('cada anulacao de uma baixa com machos e femeas diz para onde voltou cada sexo, vista de cada caixa', () => {
    const comum = { idCaixaOrigem: 1, caixaOrigem: { codigo: 'F1A' }, motivo: 'engano' }
    const machos = ocorrencia('anulacao', { ...comum, idCaixaDestino: 3, caixaDestino: { codigo: 'E03' }, animais: animais(2, 0, 3) })
    const femeas = ocorrencia('anulacao', { ...comum, idCaixaDestino: 4, caixaDestino: { codigo: 'E04' }, animais: animais(0, 1, 4) })

    // na ficha da caixa da baixa
    expect(descreverOcorrencia(machos, 1)).toBe('Baixa anulada: 2 machos voltaram para a caixa E03. Motivo: engano')
    expect(descreverOcorrencia(femeas, 1)).toBe('Baixa anulada: 1 fêmea voltou para a caixa E04. Motivo: engano')
    // na ficha da caixa para onde voltaram
    expect(descreverOcorrencia(femeas, 4)).toBe('Baixa da caixa F1A anulada: 1 fêmea voltou para esta caixa. Motivo: engano')
  })

  it('a anulacao na propria caixa da baixa nao repete a caixa', () => {
    const anulacao = ocorrencia('anulacao', { idCaixaOrigem: 2, caixaOrigem: { codigo: 'F2A' }, motivo: 'engano', animais: animais(1, 2) })

    expect(descreverOcorrencia(anulacao, 2)).toBe('Baixa anulada: 1 macho e 2 fêmeas voltaram a viver. Motivo: engano')
  })
})
