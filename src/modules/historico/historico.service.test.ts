import { beforeEach, describe, expect, it, vi } from 'vitest'
import { entidadeDaOcorrencia, linhasQueForamParaATrilha, listarHistorico, ondeNaTrilha } from './historico.service.ts'

// A tela Historico le auditoria.historico e a trilha de ocorrencias juntos. O banco aqui so devolve
// o que cada teste deixa e guarda a consulta

const historicoFindMany = vi.hoisted(() => vi.fn())
const ocorrenciaFindMany = vi.hoisted(() => vi.fn())
const queryRaw = vi.hoisted(() => vi.fn())

vi.mock('../../shared/prisma.ts', () => ({
  prisma: { historico: { findMany: historicoFindMany }, ocorrencia: { findMany: ocorrenciaFindMany }, $queryRaw: queryRaw },
}))

const registro = (id: number, dtHora: string, campos: Record<string, unknown> = {}) => ({
  id,
  dtHora: new Date(dtHora),
  entidade: 'pedido',
  idEntidade: 4,
  acao: 'recusa',
  descricao: 'Pedido #4 recusado',
  dados: null,
  usuario: { nome: 'Ana' },
  ...campos,
})

const animais = (m: number, f: number, idCaixa = 2) => [
  ...Array.from({ length: m }, () => ({ animal: { sexo: 'M', idCaixa } })),
  ...Array.from({ length: f }, () => ({ animal: { sexo: 'F', idCaixa } })),
]

const ocorrencia = (id: number, tipo: string, dtRegistro: string, campos: Record<string, unknown> = {}) => ({
  id,
  tipo,
  dtFato: new Date('2026-11-05T00:00:00.000Z'),
  dtRegistro: new Date(dtRegistro),
  idParto: null,
  idCaixaOrigem: null,
  idCaixaDestino: null,
  idPedido: null,
  motivo: null,
  usuario: { nome: 'Caio' },
  parto: null,
  caixaOrigem: null,
  caixaDestino: null,
  anulacoes: [],
  animais: [],
  ...campos,
})

beforeEach(() => {
  historicoFindMany.mockReset()
  historicoFindMany.mockResolvedValue([])
  ocorrenciaFindMany.mockReset()
  ocorrenciaFindMany.mockResolvedValue([])
  queryRaw.mockReset()
  queryRaw.mockResolvedValue([{ id: 16 }, { id: 24 }])
})

describe('filtro do historico', () => {
  it('filtra no banco por tipo, numero e texto, antes do limite, sem os fatos que foram para a trilha', async () => {
    await listarHistorico({ entidade: 'caixa', idEntidade: 7, busca: 'Ana', limite: 300 })

    expect(historicoFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entidade: 'caixa',
          idEntidade: 7,
          id: { notIn: [16, 24] },
          OR: [
            { descricao: { contains: 'Ana', mode: 'insensitive' } },
            { usuario: { nome: { contains: 'Ana', mode: 'insensitive' } } },
          ],
        },
        take: 300,
      }),
    )
  })

  it('a busca por "Sistema" traz tambem o que foi feito sem usuario', async () => {
    await listarHistorico({ busca: 'sist', limite: 300 })

    expect(historicoFindMany.mock.calls[0]?.[0].where.OR).toContainEqual({ idUsuario: null })
  })

  it('sem linha antiga que foi para a trilha, nao filtra id nenhum', async () => {
    queryRaw.mockResolvedValue([])

    await listarHistorico({ limite: 300 })

    expect(historicoFindMany.mock.calls[0]?.[0].where).not.toHaveProperty('id')
  })

  it('a linha antiga sai do historico pelos dados dela: so o fato que a conversao virou ocorrencia', async () => {
    expect(await linhasQueForamParaATrilha()).toEqual([16, 24])

    const sql = (queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ')
    // o nascimento e a entrega viraram ocorrencia sempre
    expect(sql).toContain(`h."entidade" = 'parto' AND h."acao" = 'nascimento'`)
    expect(sql).toContain(`h."entidade" = 'pedido' AND h."acao" = 'entrega'`)
    // a selecao, so com a baixa da selecao no parto
    expect(sql).toContain(
      `h."acao" = 'selecao' AND EXISTS ( SELECT 1 FROM "colonia"."ocorrencia" o WHERE o."tipo" = 'baixa' AND o."id_parto" = h."id_entidade"`,
    )
    // a passagem para o estoque tem o parto nos dados; o virar estoque antigo, nao
    expect(sql).toContain(`h."acao" = 'estoque' AND h."dados" -> 'idParto' IS NOT NULL`)
    // a reserva, so com a ocorrencia de reserva do pedido
    expect(sql).toContain(
      `h."acao" = 'alocacao' AND EXISTS ( SELECT 1 FROM "colonia"."ocorrencia" o WHERE o."tipo" = 'reserva' AND o."id_pedido" = h."id_entidade"`,
    )
  })
})

describe('a trilha no historico', () => {
  it('cada ocorrencia e da entidade de quem ela trata', () => {
    const base = { idPedido: null, idParto: 5, idCaixaOrigem: 2, idCaixaDestino: 3 }

    expect(entidadeDaOcorrencia({ ...base, tipo: 'reserva', idPedido: 9 })).toEqual({ entidade: 'pedido', idEntidade: 9 })
    expect(entidadeDaOcorrencia({ ...base, tipo: 'nascimento' })).toEqual({ entidade: 'parto', idEntidade: 5 })
    expect(entidadeDaOcorrencia({ ...base, tipo: 'baixa' })).toEqual({ entidade: 'caixa', idEntidade: 2 })
    expect(entidadeDaOcorrencia({ ...base, tipo: 'mudanca' })).toEqual({ entidade: 'caixa', idEntidade: 2 })
  })

  it('o filtro do historico vira o filtro da trilha; conta, projeto e o resto nao tem fato de animal', () => {
    expect(ondeNaTrilha({})).toEqual({})
    expect(ondeNaTrilha({ entidade: 'pedido', idEntidade: 4 })).toEqual({ idPedido: 4 })
    expect(ondeNaTrilha({ entidade: 'parto' })).toEqual({ idParto: { not: null } })
    expect(ondeNaTrilha({ entidade: 'caixa', idEntidade: 2 })).toEqual({ OR: [{ idCaixaOrigem: 2 }, { idCaixaDestino: 2 }] })
    expect(ondeNaTrilha({ idEntidade: 7 })).toEqual({
      OR: [{ idPedido: 7 }, { idParto: 7 }, { idCaixaOrigem: 7 }, { idCaixaDestino: 7 }],
    })
    expect(ondeNaTrilha({ entidade: 'usuario', idEntidade: 7 })).toBeNull()
  })

  it('junta os dois pela data do registro, do mais novo para o mais velho, ate o limite', async () => {
    historicoFindMany.mockResolvedValue([
      registro(10, '2026-11-06T12:00:00.000Z'),
      registro(9, '2026-11-04T12:00:00.000Z', { acao: 'aprovacao', descricao: 'Pedido #4 aprovado' }),
    ])
    ocorrenciaFindMany.mockResolvedValue([
      ocorrencia(3, 'reserva', '2026-11-05T12:00:00.000Z', { idPedido: 4, animais: animais(2, 1) }),
    ])

    const { historico } = await listarHistorico({ limite: 2 })

    expect(historico.map((linha) => [linha.fonte, linha.id, linha.entidade, linha.idEntidade, linha.acao, linha.descricao])).toEqual([
      ['historico', 10, 'pedido', 4, 'recusa', 'Pedido #4 recusado'],
      ['trilha', 3, 'pedido', 4, 'reserva', 'Em 2026-11-05: Reserva para o pedido #4: 2 machos e 1 femea.'],
    ])
    expect(ocorrenciaFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: {}, take: 2 }))
  })

  it('o filtro de uma entidade sem fato de animal nao le a trilha', async () => {
    await listarHistorico({ entidade: 'usuario', limite: 300 })

    expect(ocorrenciaFindMany).not.toHaveBeenCalled()
  })

  it('a busca por texto acha a ocorrencia pelo texto montado ou por quem registrou', async () => {
    ocorrenciaFindMany.mockResolvedValue([
      ocorrencia(3, 'mudanca', '2026-11-05T12:00:00.000Z', {
        idCaixaOrigem: 2,
        idCaixaDestino: 6,
        caixaOrigem: { codigo: 'F2A' },
        caixaDestino: { codigo: 'F2C' },
        animais: animais(3, 0),
      }),
      ocorrencia(2, 'baixa', '2026-11-04T12:00:00.000Z', { idCaixaOrigem: 2, caixaOrigem: { codigo: 'F2A' }, motivo: 'morte' }),
    ])

    const { historico } = await listarHistorico({ busca: 'f2c', limite: 300 })

    expect(historico.map((linha) => linha.descricao)).toEqual(['Em 2026-11-05: 3 machos mudaram da caixa F2A para a caixa F2C.'])
    expect((await listarHistorico({ busca: 'caio', limite: 300 })).historico).toHaveLength(2)
  })

  it('a busca por texto le a trilha em paginas, ate achar o limite', async () => {
    const pagina = (inicio: number) =>
      Array.from({ length: 200 }, (_, i) =>
        ocorrencia(inicio - i, 'baixa', '2026-11-04T12:00:00.000Z', { caixaOrigem: { codigo: 'F2A' }, motivo: i === 199 ? 'achou' : 'morte' }),
      )
    ocorrenciaFindMany.mockResolvedValueOnce(pagina(400)).mockResolvedValueOnce(pagina(200))

    const { historico } = await listarHistorico({ busca: 'achou', limite: 5 })

    expect(historico.map((linha) => linha.id)).toEqual([201, 1])
    expect(ocorrenciaFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: { id: 201 }, skip: 1 }))
  })
})

describe('quem fez', () => {
  it('mostra "Sistema" quando o registro ou a ocorrencia nao tem usuario', async () => {
    historicoFindMany.mockResolvedValue([registro(1, '2026-11-06T12:00:00.000Z', { usuario: null })])
    ocorrenciaFindMany.mockResolvedValue([ocorrencia(1, 'entrega', '2026-11-05T12:00:00.000Z', { usuario: null, idPedido: 4 })])

    const { historico } = await listarHistorico({ limite: 300 })

    expect(historico.map((r) => r.usuario)).toEqual(['Sistema', 'Sistema'])
  })
})
