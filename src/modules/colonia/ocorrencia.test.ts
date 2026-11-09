import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lancarOcorrencia } from './ocorrencia.ts'

// A transacao de mentira guarda cada UPDATE, INSERT e a ocorrencia criada. 'faltam' simula
// animais que nao estavam no estado esperado

const banco = vi.hoisted(() => ({
  updates: [] as { where: Record<string, unknown>; data: Record<string, unknown> }[],
  criados: [] as Record<string, unknown>[],
  ocorrencia: null as Record<string, unknown> | null,
  faltam: 0,
}))

const tx = {
  animal: {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      banco.updates.push({ where, data })
      const { in: ids } = where.id as { in: number[] }
      return { count: ids.length - banco.faltam }
    },
    createManyAndReturn: async ({ data }: { data: Record<string, unknown>[] }) => {
      const inicio = banco.criados.length
      banco.criados.push(...data)
      return data.map((_, indice) => ({ id: 100 + inicio + indice }))
    },
  },
  ocorrencia: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      banco.ocorrencia = data
      return { id: 50 }
    },
  },
}

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

/** os ids que a ocorrencia ligou */
const ligados = () =>
  (banco.ocorrencia?.animais as { createMany: { data: { idAnimal: number }[] } }).createMany.data.map(
    (ligacao) => ligacao.idAnimal,
  )

beforeEach(() => {
  banco.updates = []
  banco.criados = []
  banco.ocorrencia = null
  banco.faltam = 0
})

describe('lancarOcorrencia: a unica porta de escrita nos animais', () => {
  it('nascimento cria um vivo por filhote na caixa do casal e liga todos a ocorrencia', async () => {
    const lancado = await lancarOcorrencia(tx as never, {
      tipo: 'nascimento',
      dtFato: '2026-10-01',
      idUsuario: 4,
      idParto: 9,
      idCaixa: 3,
      nascidos: { m: 2, f: 1 },
    })

    expect(banco.criados).toEqual([
      { idParto: 9, sexo: 'M', idCaixa: 3, dtMovimento: null },
      { idParto: 9, sexo: 'M', idCaixa: 3, dtMovimento: null },
      { idParto: 9, sexo: 'F', idCaixa: 3, dtMovimento: null },
    ])
    expect(lancado).toEqual({ idOcorrencia: 50, ids: [100, 101, 102] })
    expect(banco.ocorrencia).toMatchObject({
      tipo: 'nascimento',
      dtFato: d('2026-10-01'),
      idUsuario: 4,
      idParto: 9,
      idCaixaDestino: 3,
    })
    expect(ligados()).toEqual([100, 101, 102])
  })

  it('baixa: so vivo da caixa vira morto, com a data de saida', async () => {
    await lancarOcorrencia(tx as never, {
      tipo: 'baixa',
      dtFato: '2026-11-02',
      idUsuario: 4,
      idCaixa: 6,
      motivo: 'morte',
      ids: [1, 2],
    })

    expect(banco.updates).toEqual([
      {
        where: { situacao: 'vivo', idCaixa: 6, id: { in: [1, 2] } },
        data: { situacao: 'morto', dtSaida: d('2026-11-02'), dtManutencao: expect.any(Date) },
      },
    ])
    expect(banco.ocorrencia).toMatchObject({ tipo: 'baixa', idCaixaOrigem: 6, idParto: null, motivo: 'morte' })
    expect(ligados()).toEqual([1, 2])
  })

  it('se algum animal nao estava como esperado, nada fica: SEM_ANIMAIS e nenhuma ocorrencia', async () => {
    banco.faltam = 1

    await expect(
      lancarOcorrencia(tx as never, { tipo: 'baixa', dtFato: '2026-11-02', idUsuario: 4, idCaixa: 6, ids: [1, 2] }),
    ).rejects.toEqual(expect.objectContaining({ status: 409, codigo: 'SEM_ANIMAIS' }))
    expect(banco.ocorrencia).toBeNull()
  })

  it('mudanca leva o vivo para a caixa nova e marca a chegada; a reserva vai junto', async () => {
    await lancarOcorrencia(tx as never, {
      tipo: 'mudanca',
      dtFato: '2026-10-23',
      idUsuario: 4,
      idCaixaOrigem: 3,
      idCaixaDestino: 6,
      ids: [1],
    })

    expect(banco.updates[0]).toEqual({
      where: { situacao: 'vivo', idCaixa: 3, id: { in: [1] } },
      data: { idCaixa: 6, dtMovimento: d('2026-10-23'), dtManutencao: expect.any(Date) },
    })
    expect(banco.ocorrencia).toMatchObject({ tipo: 'mudanca', idCaixaOrigem: 3, idCaixaDestino: 6 })
  })

  it('reserva, reserva desfeita e entrega mexem so no pedido e na situacao', async () => {
    await lancarOcorrencia(tx as never, { tipo: 'reserva', dtFato: '2026-11-01', idUsuario: 4, idPedido: 7, ids: [1] })
    await lancarOcorrencia(tx as never, {
      tipo: 'reserva_desfeita',
      dtFato: '2026-11-02',
      idUsuario: 4,
      idPedido: 7,
      ids: [1],
    })
    await lancarOcorrencia(tx as never, { tipo: 'entrega', dtFato: '2026-11-03', idUsuario: 4, idPedido: 7, ids: [2] })

    expect(banco.updates.map(({ where, data }) => ({ where, data: { ...data, dtManutencao: undefined } }))).toEqual([
      { where: { situacao: 'vivo', idPedido: null, id: { in: [1] } }, data: { idPedido: 7 } },
      { where: { situacao: 'vivo', idPedido: 7, id: { in: [1] } }, data: { idPedido: null } },
      {
        where: { situacao: 'vivo', idPedido: 7, id: { in: [2] } },
        data: { situacao: 'entregue', dtSaida: d('2026-11-03') },
      },
    ])
    expect(banco.ocorrencia).toMatchObject({ tipo: 'entrega', idPedido: 7 })
  })

  it('correcao: troca de sexo de vivo livre, anulacao, animais a mais e saida nova, numa ocorrencia so', async () => {
    const lancado = await lancarOcorrencia(tx as never, {
      tipo: 'correcao',
      dtFato: '2026-10-01',
      idUsuario: 4,
      idParto: 9,
      motivo: 'contagem errada',
      trocaDeSexo: { ids: [1], para: 'M' },
      anulados: [2],
      novos: { idCaixa: 6, m: 1, f: 0, chegam: false },
      novaSaida: { ids: [3], dtSaida: '2026-10-24' },
    })

    expect(banco.updates.map(({ where, data }) => ({ where, data: { ...data, dtManutencao: undefined } }))).toEqual([
      { where: { situacao: 'vivo', idPedido: null, idParto: 9, id: { in: [1] } }, data: { sexo: 'M' } },
      { where: { situacao: 'vivo', idParto: 9, id: { in: [2] } }, data: { situacao: 'anulado' } },
      { where: { situacao: 'morto', idParto: 9, id: { in: [3] } }, data: { dtSaida: d('2026-10-24') } },
    ])
    // os a mais estao onde nasceram: sem chegada
    expect(banco.criados).toEqual([{ idParto: 9, sexo: 'M', idCaixa: 6, dtMovimento: null }])
    expect(lancado.ids).toEqual([1, 2, 3, 100])
    expect(banco.ocorrencia).toMatchObject({ tipo: 'correcao', motivo: 'contagem errada', idCaixaDestino: 6 })
  })

  it('correcao: os a mais que chegam numa caixa de estoque chegam na data do fato', async () => {
    await lancarOcorrencia(tx as never, {
      tipo: 'correcao',
      dtFato: '2026-10-23',
      idUsuario: 4,
      idParto: 9,
      motivo: 'contagem errada',
      novos: { idCaixa: 6, m: 0, f: 1, chegam: true },
    })

    expect(banco.criados).toEqual([{ idParto: 9, sexo: 'F', idCaixa: 6, dtMovimento: d('2026-10-23') }])
    expect(banco.ocorrencia).toMatchObject({ tipo: 'correcao', dtFato: d('2026-10-23'), idCaixaDestino: 6 })
  })

  it('anulacao: o morto volta a viver; os soltos perdem a reserva; na caixa liberada, muda de caixa', async () => {
    await lancarOcorrencia(tx as never, {
      tipo: 'anulacao',
      dtFato: '2026-11-08',
      idUsuario: 4,
      idAnulada: 30,
      motivo: 'baixa por engano',
      idCaixaOrigem: 6,
      idCaixaDestino: 7,
      ids: [1, 2],
      soltos: [2],
    })

    const volta = { situacao: 'vivo', dtSaida: null, idCaixa: 7, dtMovimento: d('2026-11-08') }

    expect(banco.updates.map(({ where, data }) => ({ where, data: { ...data, dtManutencao: undefined } }))).toEqual([
      { where: { situacao: 'morto', idCaixa: 6, id: { in: [1] } }, data: volta },
      { where: { situacao: 'morto', idCaixa: 6, id: { in: [2] } }, data: { ...volta, idPedido: null } },
    ])
    expect(banco.ocorrencia).toMatchObject({
      tipo: 'anulacao',
      idAnulada: 30,
      idCaixaOrigem: 6,
      idCaixaDestino: 7,
      motivo: 'baixa por engano',
    })
  })

  it('anulacao na propria caixa nao mexe na caixa nem na chegada', async () => {
    await lancarOcorrencia(tx as never, {
      tipo: 'anulacao',
      dtFato: '2026-11-08',
      idUsuario: 4,
      idAnulada: 30,
      motivo: 'engano',
      idCaixaOrigem: 6,
      ids: [1],
      soltos: [],
    })

    expect(banco.updates[0]?.data).toEqual({ situacao: 'vivo', dtSaida: null, dtManutencao: expect.any(Date) })
  })
})
