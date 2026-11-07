import { describe, expect, it } from 'vitest'
import { liberarCaixaVazia } from './liberacaoDaCaixa.ts'

/** Um parto so com machos: nascidos, desmamados (null: mamando), entregues e os que foram para o estoque */
const parto = (nascido: number, desmamado: number | null, entregue = 0, noEstoque = 0) => ({
  id: 10,
  ordem: 1,
  dtPartoReal: new Date('2026-09-24'),
  casal: { identificacao: 'AB', idLinhagem: 1 },
  nascidoM: nascido,
  nascidoF: 0,
  eutanasiadoM: 0,
  eutanasiadoF: 0,
  desmamadoM: desmamado,
  desmamadoF: desmamado === null ? null : 0,
  compromissos:
    entregue === 0
      ? []
      : [{ id: 1, qtdM: entregue, qtdF: 0, remessa: { idSolicitacao: 1, dtRealizada: new Date() as Date | null } }],
  lotes: noEstoque === 0 ? [] : [{ id: 1, idCaixa: 9, qtd: noEstoque, caixa: { sexo: 'M' } }],
})

function banco(casais: { ativo: boolean }[], partos: ReturnType<typeof parto>[], tipo = 'C') {
  const gravado = { caixa: null as Record<string, unknown> | null, historico: 0 }
  const tx = {
    caixa: {
      findUnique: async () => ({ id: 3, codigo: 'F1A', ativa: true, tipo, casais }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        gravado.caixa = data
      },
    },
    parto: { findMany: async () => partos },
    historico: {
      create: async () => {
        gravado.historico += 1
      },
    },
  }
  return { tx: tx as never, gravado }
}

describe('liberar a caixa do casal', () => {
  it('casal encerrado e nenhum animal na caixa: a posicao fica vazia', async () => {
    const { tx, gravado } = banco([{ ativo: false }], [parto(3, 3, 3)])

    expect(await liberarCaixaVazia(tx, 3, 1)).toBe(true)
    expect(gravado.caixa).toEqual({ ativa: false, estado: 'R' })
    expect(gravado.historico).toBe(1)
  })

  it('casal encerrado com filhote ainda mamando: a caixa espera', async () => {
    const { tx, gravado } = banco([{ ativo: false }], [parto(3, null)])

    expect(await liberarCaixaVazia(tx, 3, 1)).toBe(false)
    expect(gravado.caixa).toBeNull()
  })

  it('desmamado que nao foi para o estoque prende a caixa: nao fica animal sem caixa', async () => {
    const { tx, gravado } = banco([{ ativo: false }], [parto(3, 3)])

    expect(await liberarCaixaVazia(tx, 3, 1)).toBe(false)
    expect(gravado.caixa).toBeNull()
  })

  it('depois que os desmamados vao para o estoque, a caixa libera', async () => {
    const { tx, gravado } = banco([{ ativo: false }], [parto(3, 3, 0, 3)])

    expect(await liberarCaixaVazia(tx, 3, 1)).toBe(true)
    expect(gravado.caixa).toEqual({ ativa: false, estado: 'R' })
  })

  it('com casal ativo ela continua, mesmo vazia', async () => {
    const { tx, gravado } = banco([{ ativo: true }], [])

    expect(await liberarCaixaVazia(tx, 3, 1)).toBe(false)
    expect(gravado.caixa).toBeNull()
  })

  it('caixa de estoque nao e liberada por aqui: ela vai para Enviado quando a entrega a esvazia', async () => {
    const { tx, gravado } = banco([{ ativo: false }], [], 'E')

    expect(await liberarCaixaVazia(tx, 3, 1)).toBe(false)
    expect(gravado.caixa).toBeNull()
  })
})
