import { beforeEach, describe, expect, it, vi } from 'vitest'
import { alterarFormato, cadastrarFormato, listarFormatos, removerFormato } from './formato.service.ts'

// Cadastro, edicao e remocao de formato, com o banco de mentira: o que cada regra consulta e grava,
// e o texto de cada recusa, que vai pronto para a tela

type Linha = Record<string, unknown>

const banco = vi.hoisted(() => ({
  /** o formato ativo pelo id */
  formato: null as Linha | null,
  /** outro formato ativo com o mesmo nome */
  mesmoNome: null as Linha | null,
  nomeConsultado: null as Linha | null,
  /** as estantes ativas que usam o formato */
  estantes: [] as Linha[],
  estantesConsultadas: null as Linha | null,
  /** as caixas que a mudanca de medidas acha fora */
  fora: [] as Linha[],
  foraConsultadas: null as Linha | null,
  /** o que a transacao fez, em ordem */
  passos: [] as string[],
  travas: [] as { sql: string; valores: unknown[] }[],
  gravado: null as Linha | null,
  historico: [] as Linha[],
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    formato: {
      // a mesma consulta serve a "formato ativo pelo id" e a "nome ja usado"
      findFirst: async ({ where }: { where: Linha }) => {
        if ('nome' in where) {
          banco.nomeConsultado = where
          return banco.mesmoNome
        }
        return banco.formato
      },
      findMany: async () => [
        {
          id: 1,
          nome: 'ALESCO Modelo 1',
          faces: 2,
          linhas: 8,
          colunas: 8,
          estantes: [
            { id: 4, numeroVisivel: 'E-01', sala: { nome: 'Sala 1' } },
            { id: 6, numeroVisivel: 'E-06', sala: { nome: 'Sala 2' } },
          ],
        },
        { id: 7, nome: 'Uma face', faces: 1, linhas: 3, colunas: 9, estantes: [] },
      ],
    },
    estante: {
      findMany: async ({ where }: { where: Linha }) => {
        banco.estantesConsultadas = where
        return banco.estantes
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $queryRaw: async (partes: TemplateStringsArray, ...valores: unknown[]) => {
          banco.passos.push('trava')
          banco.travas.push({ sql: partes.join('?').replace(/\s+/g, ' ').trim(), valores })
          return []
        },
        caixa: {
          findMany: async ({ where }: { where: Linha }) => {
            banco.passos.push('confere')
            banco.foraConsultadas = where
            return banco.fora
          },
        },
        formato: {
          create: async ({ data }: { data: Linha }) => {
            banco.passos.push('grava')
            banco.gravado = data
            return { id: 5, ativo: true, ...data, estantes: [] }
          },
          update: async ({ data }: { data: Linha }) => {
            banco.passos.push('grava')
            banco.gravado = data
            return { ...banco.formato, ...data, estantes: [] }
          },
        },
        historico: {
          create: async ({ data }: { data: Linha }) => {
            banco.historico.push(data)
            return {}
          },
        },
      }),
  },
}))

const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

/** A caixa que a conferencia acha fora, na estante dela */
const caixaFora = (codigo: string, idEstante: number, numeroVisivel: string, sala: string) => ({
  codigo,
  idEstante,
  estante: { numeroVisivel, sala: { nome: sala } },
})

const SEM_LETRA = 'Faces x colunas não pode passar de 26 - o endereço ficaria sem letra.'

beforeEach(() => {
  banco.formato = { id: 1, nome: 'ALESCO Modelo 1', faces: 2, linhas: 8, colunas: 8, ativo: true }
  banco.mesmoNome = null
  banco.nomeConsultado = null
  banco.estantes = []
  banco.estantesConsultadas = null
  banco.fora = []
  banco.foraConsultadas = null
  banco.passos = []
  banco.travas = []
  banco.gravado = null
  banco.historico = []
})

describe('lista de formatos', () => {
  it('cada formato com a capacidade das medidas e as estantes ativas que o usam, com a sala', async () => {
    await expect(listarFormatos()).resolves.toEqual({
      formatos: [
        {
          id: 1,
          nome: 'ALESCO Modelo 1',
          faces: 2,
          linhas: 8,
          colunas: 8,
          capacidade: 128,
          estantes: [
            { id: 4, numeroVisivel: 'E-01', sala: 'Sala 1' },
            { id: 6, numeroVisivel: 'E-06', sala: 'Sala 2' },
          ],
        },
        { id: 7, nome: 'Uma face', faces: 1, linhas: 3, colunas: 9, capacidade: 27, estantes: [] },
      ],
    })
  })
})

describe('cadastro de formato', () => {
  const novo = { nome: 'ALESCO Modelo 3', faces: 2, linhas: 6, colunas: 6 }

  it('grava o nome e as medidas, devolve o formato sem estante e vai para o historico', async () => {
    await expect(cadastrarFormato(novo, 1)).resolves.toEqual({ id: 5, ...novo, capacidade: 72, estantes: [] })
    expect(banco.gravado).toEqual(novo)
    expect(banco.historico).toEqual([
      expect.objectContaining({
        idUsuario: 1,
        entidade: 'formato',
        idEntidade: 5,
        acao: 'cadastro',
        descricao: 'Formato ALESCO Modelo 3 cadastrado',
        dados: novo,
      }),
    ])
  })

  it('nome repetido entre os ativos e recusado, sem diferenciar maiuscula, com o nome digitado', async () => {
    banco.mesmoNome = { id: 1 }

    await expect(cadastrarFormato({ ...novo, nome: 'alesco modelo 1' }, 1)).rejects.toEqual(recusa(409, 'FORMATO_DUPLICADO'))
    await expect(cadastrarFormato({ ...novo, nome: 'alesco modelo 1' }, 1)).rejects.toThrow(
      'Já existe um formato com o nome alesco modelo 1.',
    )
    expect(banco.nomeConsultado).toEqual({ ativo: true, nome: { equals: 'alesco modelo 1', mode: 'insensitive' } })
    expect(banco.gravado).toBeNull()
  })
})

describe('edicao de formato', () => {
  it('formato removido ou inexistente da 404', async () => {
    banco.formato = null

    await expect(alterarFormato(1, { nome: 'X' }, 1)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
    await expect(alterarFormato(1, { nome: 'X' }, 1)).rejects.toThrow('Formato não encontrado.')
  })

  it('faces x colunas confere a combinacao: a coluna nova com as faces de hoje', async () => {
    // 2 faces de hoje x 14 colunas novas = 28 letras
    await expect(alterarFormato(1, { colunas: 14 }, 1)).rejects.toEqual(
      expect.objectContaining({ status: 400, codigo: 'VALIDACAO', extras: { campos: { colunas: SEM_LETRA } } }),
    )
    expect(banco.passos).toEqual([])
  })

  it('faces x colunas confere a combinacao: as faces novas com as colunas de hoje', async () => {
    banco.formato = { id: 7, nome: 'Uma face', faces: 1, linhas: 3, colunas: 20, ativo: true }

    await expect(alterarFormato(7, { faces: 2 }, 1)).rejects.toEqual(
      expect.objectContaining({ status: 400, extras: { campos: { colunas: SEM_LETRA } } }),
    )
  })

  it('as duas novas valem juntas: 1 face com 14 colunas cabe', async () => {
    await expect(alterarFormato(1, { faces: 1, colunas: 14 }, 1)).resolves.toMatchObject({ faces: 1, linhas: 8, colunas: 14 })
    expect(banco.gravado).toMatchObject({ nome: 'ALESCO Modelo 1', faces: 1, linhas: 8, colunas: 14 })
  })

  it('o nome de outro formato ativo e recusado, o do proprio nao conta', async () => {
    banco.mesmoNome = { id: 3 }

    await expect(alterarFormato(1, { nome: 'TECNIPLAST Modelo 1' }, 1)).rejects.toThrow(
      'Já existe um formato com o nome TECNIPLAST Modelo 1.',
    )
    expect(banco.nomeConsultado).toMatchObject({ id: { not: 1 } })
    expect(banco.gravado).toBeNull()
  })

  it('so o nome: nao confere caixa nem trava nada, e o historico guarda o antes e o depois', async () => {
    await expect(alterarFormato(1, { nome: 'ALESCO M1' }, 1)).resolves.toMatchObject({ nome: 'ALESCO M1', colunas: 8 })

    expect(banco.passos).toEqual(['grava'])
    expect(banco.historico[0]).toMatchObject({
      entidade: 'formato',
      idEntidade: 1,
      acao: 'alteracao',
      descricao: 'Formato ALESCO M1 alterado',
      dados: {
        antes: { nome: 'ALESCO Modelo 1', faces: 2, linhas: 8, colunas: 8 },
        depois: { nome: 'ALESCO M1', faces: 2, linhas: 8, colunas: 8 },
      },
    })
  })

  it('sem o nome no corpo, o nome nao e conferido', async () => {
    await alterarFormato(1, { linhas: 9 }, 1)

    expect(banco.nomeConsultado).toBeNull()
  })

  it('mudar as medidas trava as caixas de todas as estantes do formato, confere as que ficariam fora e so depois grava', async () => {
    await alterarFormato(1, { colunas: 7 }, 1)

    expect(banco.passos).toEqual(['trava', 'confere', 'grava'])
    expect(banco.travas[0]?.sql).toContain('FOR UPDATE OF c')
    expect(banco.travas[0]?.sql).toContain('ORDER BY c."id"')
    expect(banco.travas[0]?.valores).toEqual([1])
    // as caixas ativas das estantes ativas do formato, alem das medidas novas
    expect(banco.foraConsultadas).toEqual({
      ativa: true,
      estante: { idFormato: 1, ativa: true },
      OR: [{ face: { gt: 2 } }, { linha: { gt: 8 } }, { coluna: { gt: 7 } }],
    })
    expect(banco.historico[0]).toMatchObject({
      dados: { antes: { colunas: 8 }, depois: { nome: 'ALESCO Modelo 1', faces: 2, linhas: 8, colunas: 7 } },
    })
  })

  it('caixas fora das medidas novas: recusa dizendo quais, por estante, sem gravar', async () => {
    banco.fora = [
      caixaFora('F8A', 4, 'E-01', 'Sala 1'),
      caixaFora('T8C', 4, 'E-01', 'Sala 1'),
      caixaFora('F8B', 6, 'E-06', 'Sala 2'),
    ]

    await expect(alterarFormato(1, { linhas: 7 }, 1)).rejects.toEqual(recusa(409, 'CAIXAS_FORA_DO_FORMATO'))
    await expect(alterarFormato(1, { linhas: 7 }, 1)).rejects.toThrow(
      'Estas caixas ficam fora das medidas novas: E-01 (Sala 1): F8A e T8C; E-06 (Sala 2): F8B. Mude-as de lugar antes de mudar o formato.',
    )
    expect(banco.gravado).toBeNull()
    expect(banco.historico).toEqual([])
  })

  it('tres caixas na mesma estante vem em lista, e a ordem e a da leitura', async () => {
    banco.fora = [caixaFora('F8A', 4, 'E-01', 'Sala 1'), caixaFora('F8B', 4, 'E-01', 'Sala 1'), caixaFora('T8C', 4, 'E-01', 'Sala 1')]

    await expect(alterarFormato(1, { linhas: 7 }, 1)).rejects.toThrow(
      'Estas caixas ficam fora das medidas novas: E-01 (Sala 1): F8A, F8B e T8C. Mude-as de lugar antes de mudar o formato.',
    )
  })

  it('uma caixa so vem no singular', async () => {
    banco.fora = [caixaFora('F8A', 4, 'E-01', 'Sala 1')]

    await expect(alterarFormato(1, { linhas: 7 }, 1)).rejects.toThrow(
      'Esta caixa fica fora das medidas novas: E-01 (Sala 1): F8A. Mude-a de lugar antes de mudar o formato.',
    )
  })
})

describe('remocao de formato', () => {
  it('formato usado por uma estante ativa nao sai: diz qual, no singular', async () => {
    banco.estantes = [{ numeroVisivel: 'E-01', sala: { nome: 'Sala 1' } }]

    await expect(removerFormato(1, 1)).rejects.toEqual(recusa(409, 'FORMATO_EM_USO'))
    await expect(removerFormato(1, 1)).rejects.toThrow(
      'O formato ALESCO Modelo 1 é usado pela estante E-01 (Sala 1). Troque o formato dela antes de remover.',
    )
    expect(banco.estantesConsultadas).toEqual({ idFormato: 1, ativa: true })
    expect(banco.gravado).toBeNull()
  })

  it('usado por mais de uma: a lista, no plural', async () => {
    banco.estantes = [
      { numeroVisivel: 'E-01', sala: { nome: 'Sala 1' } },
      { numeroVisivel: 'E-06', sala: { nome: 'Sala 2' } },
    ]

    await expect(removerFormato(1, 1)).rejects.toThrow(
      'O formato ALESCO Modelo 1 é usado pelas estantes E-01 (Sala 1) e E-06 (Sala 2). Troque o formato delas antes de remover.',
    )
  })

  it('formato sem estante ativa fica inativo, nao e apagado, e vai para o historico', async () => {
    await expect(removerFormato(1, 2)).resolves.toBeUndefined()

    expect(banco.gravado).toMatchObject({ ativo: false })
    expect(banco.historico[0]).toMatchObject({
      idUsuario: 2,
      entidade: 'formato',
      idEntidade: 1,
      acao: 'remocao',
      descricao: 'Formato ALESCO Modelo 1 removido',
      dados: { nome: 'ALESCO Modelo 1', faces: 2, linhas: 8, colunas: 8 },
    })
  })

  it('formato ja removido da 404', async () => {
    banco.formato = null

    await expect(removerFormato(1, 1)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })
})
