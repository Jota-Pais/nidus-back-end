import { describe, expect, it } from 'vitest'
import { liberarCaixaVazia } from './liberacaoDaCaixa.ts'

const parto = (nascido: number, desmamado: number | null, entregue = 0) => ({
  nascidoM: nascido,
  nascidoF: 0,
  eutanasiadoM: 0,
  eutanasiadoF: 0,
  desmamadoM: desmamado,
  desmamadoF: desmamado === null ? null : 0,
  compromissos:
    entregue === 0
      ? []
      : [{ qtdM: entregue, qtdF: 0, remessa: { idSolicitacao: 1, dtRealizada: new Date() } }],
})

function banco(casais: { ativo: boolean; partos: ReturnType<typeof parto>[] }[]) {
  const gravado = { caixa: null as Record<string, unknown> | null, historico: 0 }
  const tx = {
    caixa: {
      findUnique: async () => ({ id: 3, codigo: 'F1A', ativa: true, casais }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        gravado.caixa = data
      },
    },
    historico: {
      create: async () => {
        gravado.historico += 1
      },
    },
  }
  return { tx: tx as never, gravado }
}

describe('liberar a caixa no fim do ciclo', () => {
  it('casal encerrado e nenhum animal na caixa: a caixa sai do kanban e a posicao fica vazia', async () => {
    const { tx, gravado } = banco([{ ativo: false, partos: [parto(3, 3, 3)] }])

    expect(await liberarCaixaVazia(tx, 3, 1)).toBe(true)
    expect(gravado.caixa).toEqual({ ativa: false, estado: 'R' })
    expect(gravado.historico).toBe(1)
  })

  it('com filhote ainda na caixa ela continua', async () => {
    const { tx, gravado } = banco([{ ativo: false, partos: [parto(3, null)] }])

    expect(await liberarCaixaVazia(tx, 3, 1)).toBe(false)
    expect(gravado.caixa).toBeNull()
  })

  it('com casal ativo ela continua, mesmo vazia', async () => {
    const { tx, gravado } = banco([{ ativo: true, partos: [] }])

    expect(await liberarCaixaVazia(tx, 3, 1)).toBe(false)
    expect(gravado.caixa).toBeNull()
  })
})
