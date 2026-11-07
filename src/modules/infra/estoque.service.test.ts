import { beforeEach, describe, expect, it, vi } from 'vitest'
import { passarParaOEstoque, virarCaixaDeEstoque } from './estoque.service.ts'

// O banco aqui e de mentira. 'parto' e o parto que passa para o estoque, com a caixa do casal;
// 'caixas' sao as caixas por id; 'ocupadas' as posicoes 'idEstante:face:linha:coluna' com caixa;
// 'partosDaCaixa' os partos que ainda podem ter animal na caixa do casal

const banco = vi.hoisted(() => ({
  parto: null as Record<string, unknown> | null,
  caixas: {} as Record<number, Record<string, unknown>>,
  ocupadas: new Set<string>(),
  partosDaCaixa: [] as Record<string, unknown>[],
  criadas: [] as Record<string, unknown>[],
  lotes: [] as Record<string, unknown>[],
  caixasAlteradas: [] as Record<string, unknown>[],
  historicos: [] as Record<string, unknown>[],
}))

vi.mock('../../shared/prisma.ts', () => {
  // as leituras valem dentro e fora da transacao
  const leitura = {
    parto: {
      findUnique: async () => banco.parto,
      findMany: async () => banco.partosDaCaixa,
    },
    caixa: {
      findUnique: async ({ where }: { where: { id: number } }) => banco.caixas[where.id] ?? null,
      findFirst: async ({ where }: { where: { idEstante: number; face: number; linha: number; coluna: number } }) =>
        banco.ocupadas.has(`${where.idEstante}:${where.face}:${where.linha}:${where.coluna}`) ? { id: 99 } : null,
    },
    estante: {
      findFirst: async () => ({ id: 2, faces: 2, linhas: 5, colunas: 5, numeroVisivel: 'E-02' }),
    },
  }

  return {
    prisma: {
      ...leitura,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          ...leitura,
          caixa: {
            ...leitura.caixa,
            create: async ({ data }: { data: Record<string, unknown> }) => {
              banco.criadas.push(data)
              return { id: 50, codigo: data.codigo }
            },
            update: async ({ data }: { data: Record<string, unknown> }) => {
              banco.caixasAlteradas.push(data)
            },
          },
          lote: {
            upsert: async (consulta: Record<string, unknown>) => {
              banco.lotes.push(consulta)
            },
          },
          historico: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
              banco.historicos.push(data)
            },
          },
        }),
    },
  }
})

/** O 1o parto do casal AB, Wistar (linhagem 1), na caixa F1A (id 3), com 4 M e 3 F desmamados */
const partoDesmamado = (parcial: Record<string, unknown> = {}) => ({
  id: 10,
  ordem: 1,
  nascidoM: 4,
  nascidoF: 3,
  eutanasiadoM: 0,
  eutanasiadoF: 0,
  desmamadoM: 4,
  desmamadoF: 3,
  compromissos: [],
  lotes: [],
  casal: {
    identificacao: 'AB',
    idLinhagem: 1,
    idCaixa: 3,
    caixa: { codigo: 'F1A', idEspecie: 1, tipo: 'C' },
  },
  ...parcial,
})

/** Uma caixa de estoque ativa: sexo, especie e a linhagem dos animais que ja estao nela */
const caixaDeEstoque = (sexo: 'M' | 'F', idLinhagem = 1, idEspecie = 1) => ({
  id: 20,
  codigo: 'F2A',
  tipo: 'E',
  sexo,
  ativa: true,
  idEspecie,
  lotes: [{ parto: { casal: { idLinhagem } } }],
})

const posicao = (linha: number, coluna: number) => ({
  posicao: { idEstante: 2, face: 'frontal' as const, linha, coluna },
})

const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })
const noCampo = (campo: string, mensagem: string) =>
  expect.objectContaining({
    status: 400,
    extras: { campos: { [campo]: expect.stringContaining(mensagem) } },
  })

beforeEach(() => {
  banco.parto = partoDesmamado()
  // a caixa do casal: casal ativo, para nao liberar no fim
  banco.caixas = {
    3: { id: 3, codigo: 'F1A', ativa: true, tipo: 'C', estado: 'R', idEspecie: 1, lotes: [], casais: [{ ativo: true }] },
  }
  banco.ocupadas = new Set()
  banco.partosDaCaixa = []
  banco.criadas = []
  banco.lotes = []
  banco.caixasAlteradas = []
  banco.historicos = []
})

describe('passar desmamados para o estoque', () => {
  it('numa posicao vazia nasce a caixa de estoque, com o sexo e a especie', async () => {
    const resposta = await passarParaOEstoque(10, { machos: { qtd: 4, destino: posicao(1, 2) } }, 1)

    expect(banco.criadas).toEqual([
      expect.objectContaining({ idEstante: 2, face: 1, linha: 1, coluna: 2, codigo: 'F1B', idEspecie: 1, tipo: 'E', sexo: 'M', estado: 'E' }),
    ])
    expect(banco.lotes).toEqual([
      expect.objectContaining({
        where: { idCaixa_idParto: { idCaixa: 50, idParto: 10 } },
        create: { idCaixa: 50, idParto: 10, qtd: 4 },
      }),
    ])
    expect(resposta).toEqual({ caixas: [{ idCaixa: 50, codigo: 'F1B', sexo: 'M', qtd: 4 }] })
    expect(banco.historicos).toContainEqual(expect.objectContaining({ entidade: 'caixa', acao: 'estoque' }))
  })

  it('numa caixa de estoque do mesmo sexo e linhagem os animais se juntam aos que ja estao la', async () => {
    banco.caixas[20] = caixaDeEstoque('F')

    await passarParaOEstoque(10, { femeas: { qtd: 2, destino: { idCaixa: 20 } } }, 1)

    expect(banco.criadas).toEqual([])
    expect(banco.lotes).toEqual([
      expect.objectContaining({
        create: { idCaixa: 20, idParto: 10, qtd: 2 },
        update: expect.objectContaining({ qtd: { increment: 2 } }),
      }),
    ])
  })

  it('machos e femeas no mesmo pedido, cada um para uma caixa', async () => {
    banco.caixas[20] = caixaDeEstoque('F')

    await passarParaOEstoque(
      10,
      { machos: { qtd: 4, destino: posicao(1, 2) }, femeas: { qtd: 3, destino: { idCaixa: 20 } } },
      1,
    )

    expect(banco.criadas).toHaveLength(1)
    expect(banco.lotes).toHaveLength(2)
  })

  it('so depois do desmame', async () => {
    banco.parto = partoDesmamado({ desmamadoM: null, desmamadoF: null })

    await expect(passarParaOEstoque(10, { machos: { qtd: 1, destino: posicao(1, 2) } }, 1)).rejects.toEqual(
      recusa(409, 'SEQUENCIA_INVALIDA'),
    )
  })

  it('nao passa mais do que ainda esta na caixa do casal', async () => {
    banco.parto = partoDesmamado({ lotes: [{ id: 1, idCaixa: 20, qtd: 3, caixa: { sexo: 'M' } }] })

    await expect(passarParaOEstoque(10, { machos: { qtd: 2, destino: posicao(1, 2) } }, 1)).rejects.toEqual(
      noCampo('qtdM', 'So ha 1 machos'),
    )
    expect(banco.criadas).toEqual([])
  })

  it('caixa de estoque do outro sexo, de outra linhagem ou de outra especie nao recebe', async () => {
    banco.caixas[20] = caixaDeEstoque('F')
    await expect(passarParaOEstoque(10, { machos: { qtd: 1, destino: { idCaixa: 20 } } }, 1)).rejects.toEqual(
      noCampo('destinoM', 'outro sexo'),
    )

    banco.caixas[20] = caixaDeEstoque('M', 2)
    await expect(passarParaOEstoque(10, { machos: { qtd: 1, destino: { idCaixa: 20 } } }, 1)).rejects.toEqual(
      noCampo('destinoM', 'outra linhagem'),
    )

    banco.caixas[20] = caixaDeEstoque('M', 1, 2)
    await expect(passarParaOEstoque(10, { machos: { qtd: 1, destino: { idCaixa: 20 } } }, 1)).rejects.toEqual(
      noCampo('destinoM', 'outra especie'),
    )
    expect(banco.lotes).toEqual([])
  })

  it('caixa de casal nao e destino de estoque', async () => {
    await expect(passarParaOEstoque(10, { machos: { qtd: 1, destino: { idCaixa: 3 } } }, 1)).rejects.toEqual(
      noCampo('destinoM', 'nao e de estoque'),
    )
  })

  it('posicao ocupada e recusada, e machos e femeas nao vao para a mesma posicao', async () => {
    banco.ocupadas.add('2:1:1:2')
    await expect(passarParaOEstoque(10, { machos: { qtd: 1, destino: posicao(1, 2) } }, 1)).rejects.toEqual(
      noCampo('destinoM', 'ja tem uma caixa'),
    )

    await expect(
      passarParaOEstoque(10, { machos: { qtd: 1, destino: posicao(1, 3) }, femeas: { qtd: 1, destino: posicao(1, 3) } }, 1),
    ).rejects.toEqual(noCampo('destinoF', 'caixas diferentes'))
    expect(banco.criadas).toEqual([])
  })
})

describe('a caixa do casal encerrado vira caixa de estoque', () => {
  /** o que sobrou na caixa F1A: desmamados do 5o parto do AB */
  const sobrou = (m: number, f: number, parcial: Record<string, unknown> = {}) => ({
    ...partoDesmamado({ id: 15, ordem: 5, nascidoM: m, nascidoF: f, desmamadoM: m, desmamadoF: f }),
    dtPartoReal: new Date('2026-10-01T00:00:00.000Z'),
    ...parcial,
  })

  beforeEach(() => {
    banco.caixas[3] = { id: 3, codigo: 'F1A', ativa: true, tipo: 'C', casais: [{ ativo: false }] }
  })

  it('com um sexo so, vira no lugar e guarda de qual parto vieram', async () => {
    banco.partosDaCaixa = [sobrou(0, 4)]

    await expect(virarCaixaDeEstoque(3, 1)).resolves.toEqual({ idCaixa: 3, sexo: 'F' })
    expect(banco.caixasAlteradas).toEqual([{ tipo: 'E', sexo: 'F', estado: 'E' }])
    expect(banco.lotes).toEqual([expect.objectContaining({ create: { idCaixa: 3, idParto: 15, qtd: 4 } })])
  })

  it('com machos e femeas juntos, um dos sexos vai antes para outra caixa', async () => {
    banco.partosDaCaixa = [sobrou(2, 4)]

    await expect(virarCaixaDeEstoque(3, 1)).rejects.toEqual(recusa(409, 'CAIXA_COM_ANIMAIS'))
    expect(banco.caixasAlteradas).toEqual([])
  })

  it('com filhote mamando, espera o desmame', async () => {
    banco.partosDaCaixa = [sobrou(0, 4, { desmamadoM: null, desmamadoF: null })]

    await expect(virarCaixaDeEstoque(3, 1)).rejects.toEqual(recusa(409, 'CAIXA_COM_ANIMAIS'))
  })

  it('com o casal ativo nao vira', async () => {
    banco.caixas[3] = { ...banco.caixas[3], casais: [{ ativo: true }] }
    banco.partosDaCaixa = [sobrou(0, 4)]

    await expect(virarCaixaDeEstoque(3, 1)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
  })
})
