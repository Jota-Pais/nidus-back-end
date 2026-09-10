import { describe, expect, it } from 'vitest'
import {
  codigoDaEspecie,
  dataISO,
  estadoCaixa,
  exigirCodigo,
  face,
  finalidadeCaixa,
  grauCerteza,
  hojeISO,
  perfil,
} from './traducao.ts'

// A secao 1.1 do contrato e uma tabela de equivalencia. O que pode dar errado
// aqui e silencioso e caro: um termo diferente do que o front espera nao quebra
// build nenhum dos dois lados - so aparece como tela vazia.
const dicionarios = [
  { nome: 'estadoCaixa', dic: estadoCaixa, codigos: ['R', 'P', 'T', 'E', 'X'] },
  { nome: 'finalidadeCaixa', dic: finalidadeCaixa, codigos: ['R', 'M', 'C', 'E'] },
  { nome: 'grauCerteza', dic: grauCerteza, codigos: ['C', 'P', 'J'] },
  { nome: 'perfil', dic: perfil, codigos: ['P', 'T', 'G'] },
  { nome: 'face', dic: face, codigos: ['1', '2'] },
]

describe('traducao do char(1) - contrato secao 1.1', () => {
  it.each(dicionarios)('$nome traduz e volta sem perder nada', ({ dic, codigos }) => {
    for (const codigo of codigos) {
      expect(dic.paraBanco(dic.paraApi(codigo))).toBe(codigo)
    }

    expect(dic.termos).toHaveLength(codigos.length)
  })

  it('usa exatamente os termos de tipos.ts e estados.ts do front', () => {
    // Renomear qualquer um destes quebra o front sem quebrar build. Estao
    // escritos a mao de proposito: e a copia que o teste compara.
    expect(estadoCaixa.termos).toEqual([
      'em_reproducao',
      'parcialmente_comprometida',
      'totalmente_comprometida',
      'preparada_para_envio',
      'expedida',
    ])
    expect(finalidadeCaixa.termos).toEqual(['reproducao', 'maternidade', 'recria', 'expedicao'])
    expect(grauCerteza.termos).toEqual(['confirmado', 'previsto', 'projetado'])
    expect(perfil.termos).toEqual(['pesquisador', 'tecnico', 'gestor'])
    expect(face.termos).toEqual(['frontal', 'traseira'])
  })

  it('trata codigo fora do dominio como bug, nao como entrada invalida', () => {
    // O CHECK de dominio da migration das invariantes nao deveria deixar entrar.
    // Se entrou, quero stack no log do servidor - nao 404 disfarcado.
    expect(() => estadoCaixa.paraApi('Z')).toThrow(/fora do dominio/)
  })

  it('devolve undefined para termo de API desconhecido', () => {
    expect(estadoCaixa.paraBanco('em_ferias')).toBeUndefined()
  })

  it('exigirCodigo vira 404 no envelope do contrato', () => {
    expect(exigirCodigo(estadoCaixa, 'em_reproducao', 'Estado')).toBe('R')
    expect(() => exigirCodigo(estadoCaixa, 'em_ferias', 'Estado')).toThrowError(
      expect.objectContaining({ status: 404, codigo: 'NAO_ENCONTRADO' }),
    )
  })
})

describe('codigo da especie', () => {
  it('deriva o codigo que a rota e o filtro usam', () => {
    expect(codigoDaEspecie('Rato')).toBe('rato')
    expect(codigoDaEspecie('Camundongo')).toBe('camundongo')
  })

  it('tira acento sem comer digito', () => {
    // A faixa de diacriticos e facil de escrever errado e o estrago aparece
    // longe: `[0-9]` dentro da classe apagaria o numero da linhagem.
    expect(codigoDaEspecie('Ratao-do-banhado')).toBe('ratao-do-banhado')
    expect(codigoDaEspecie('C57BL/6J')).toBe('c57bl-6j')
  })
})

describe('data de calendario', () => {
  it('formata como aaaa-mm-dd, nunca timestamp', () => {
    expect(dataISO(new Date('2026-05-25T00:00:00.000Z'))).toBe('2026-05-25')
  })

  it('le a coluna @db.Date em UTC, sem deslocar um dia no fuso do servidor', () => {
    // O erro classico: `toLocaleDateString` em servidor a oeste de Greenwich
    // devolveria 24/05 para esta data.
    expect(dataISO(new Date(Date.UTC(2026, 4, 25)))).toBe('2026-05-25')
    expect(hojeISO(new Date('2026-09-10T23:30:00.000Z'))).toBe('2026-09-10')
  })
})
