import { describe, expect, it } from 'vitest'
import {
  codigoDaEspecie,
  cronograma,
  dataISO,
  estadoCaixa,
  exigirCodigo,
  face,
  hojeISO,
  paraData,
  perfil,
} from './traducao.ts'

// Cada dicionario e uma tabela de equivalencia. O que pode dar
// errado aqui e silencioso e caro: um termo diferente do que o front espera
// nao quebra build nenhum dos dois lados - so aparece como tela vazia
const dicionarios = [
  { nome: 'estadoCaixa', dic: estadoCaixa, codigos: ['R', 'P', 'T', 'E', 'X'] },
  { nome: 'perfil', dic: perfil, codigos: ['P', 'T', 'G'] },
  { nome: 'face', dic: face, codigos: ['1', '2'] },
  { nome: 'cronograma', dic: cronograma, codigos: ['U', 'S', 'Q', 'M'] },
]

describe('traducao do char(1)', () => {
  it.each(dicionarios)('$nome traduz e volta sem perder nada', ({ dic, codigos }) => {
    for (const codigo of codigos) {
      expect(dic.paraBanco(dic.paraApi(codigo))).toBe(codigo)
    }

    expect(dic.termos).toHaveLength(codigos.length)
  })

  it('usa exatamente os termos que o front espera', () => {
    // Renomear qualquer um destes quebra o front sem quebrar build. Estao escritos a mao
    // de proposito: e a copia que o teste compara. As colunas seguem a ordem do kanban
    expect(estadoCaixa.termos).toEqual(['livres', 'pre_reserva', 'estoque', 'reserva', 'enviado'])
    expect(perfil.termos).toEqual(['pesquisador', 'tecnico', 'gestor'])
    expect(face.termos).toEqual(['frontal', 'traseira'])
    // os quatro que a rota aceita e o formulario Solicitar animais oferece
    expect(cronograma.termos).toEqual(['unica', 'semanal', 'quinzenal', 'mensal'])
  })

  it('trata codigo fora do dominio como bug, nao como entrada invalida', () => {
    // O CHECK de dominio da migration das invariantes nao deveria deixar entrar. Se
    // entrou, quero stack no log do servidor - nao 404 disfarcado.
    expect(() => estadoCaixa.paraApi('Z')).toThrow(/fora do dominio/)
  })

  it('devolve undefined para termo de API desconhecido', () => {
    expect(estadoCaixa.paraBanco('em_ferias')).toBeUndefined()
  })

  it('exigirCodigo vira 404 no envelope de erro da API', () => {
    expect(exigirCodigo(estadoCaixa, 'livres', 'Estado')).toBe('R')
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
    // longe: [0-9] dentro da classe apagaria o numero da linhagem.
    expect(codigoDaEspecie('Ratao-do-banhado')).toBe('ratao-do-banhado')
    expect(codigoDaEspecie('C57BL/6J')).toBe('c57bl-6j')
  })
})

describe('data de calendario', () => {
  it('formata como aaaa-mm-dd, nunca timestamp', () => {
    expect(dataISO(new Date('2026-05-25T00:00:00.000Z'))).toBe('2026-05-25')
  })

  it('le a coluna @db.Date em UTC, sem deslocar um dia no fuso do servidor', () => {
    // O erro classico: toLocaleDateString em servidor a oeste de Greenwich devolveria
    // 24/05 para esta data
    expect(dataISO(new Date(Date.UTC(2026, 4, 25)))).toBe('2026-05-25')
    expect(hojeISO(new Date('2026-09-10T23:30:00.000Z'))).toBe('2026-09-10')
  })

  it('grava aaaa-mm-dd como meia-noite UTC, e a volta da a mesma data', () => {
    expect(paraData('2026-05-25').toISOString()).toBe('2026-05-25T00:00:00.000Z')
    expect(dataISO(paraData('2026-05-25'))).toBe('2026-05-25')
  })
})
