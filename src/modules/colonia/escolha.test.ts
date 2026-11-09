import { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  escolherAnimais,
  exigirDepoisDaChegada,
  idadeDoGrupo,
  pedidoDosReservados,
  pedidosTocados,
  travarReservados,
} from './escolha.ts'
import type { Escolhido } from './escolha.ts'

// O banco aqui so devolve, em ordem, as linhas de cada consulta, e guarda o SQL de cada uma

const consultas: Prisma.Sql[] = []
let respostas: unknown[][] = []

const tx = {
  $queryRaw: vi.fn(async (partes: TemplateStringsArray, ...valores: unknown[]) => {
    consultas.push(Prisma.sql(partes, ...valores))
    return respostas.shift() ?? []
  }),
}

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const animal = (id: number, idPedido: number | null = null): Escolhido => ({
  id,
  idCaixa: 3,
  idPedido,
  dtMovimento: null,
  dtNascimento: d('2026-10-01'),
})

const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

beforeEach(() => {
  consultas.length = 0
  respostas = []
  tx.$queryRaw.mockClear()
})

describe('escolha dentro do grupo', () => {
  it('com livres que bastam, trava so os livres, pela ordem de id, pulando os travados', async () => {
    respostas = [[animal(1), animal(2)]]

    const escolhidos = await escolherAnimais(tx as never, { idCaixa: 3, sexo: 'M', dtNascimento: '2026-10-01' }, 2)

    expect(escolhidos.map((a) => a.id)).toEqual([1, 2])
    expect(consultas).toHaveLength(1)

    const [sql] = consultas
    expect(sql?.text).toContain('"id_pedido" IS NULL')
    expect(sql?.text).toContain('ORDER BY a."id"')
    expect(sql?.text).toContain('FOR UPDATE OF a SKIP LOCKED')
    expect(sql?.text).toContain('"dt_parto_real" = $')
    expect(sql?.values).toEqual(expect.arrayContaining(['M', 3, '2026-10-01', 2]))
  })

  it('quando os livres nao bastam, os que faltam saem do unico pedido com reservados no grupo', async () => {
    respostas = [[animal(1)], [{ idPedido: 7 }], [animal(5, 7)]]

    const escolhidos = await escolherAnimais(tx as never, { idCaixa: 3, sexo: 'F' }, 2)

    expect(escolhidos.map((a) => a.id)).toEqual([1, 5])
    expect(consultas[2]?.text).toContain('"id_pedido" = $')
    // falta 1: o LIMIT da segunda trava e so o que falta
    expect(consultas[2]?.values).toEqual(expect.arrayContaining([7, 1]))
  })

  it('com reservados de mais de um pedido e nenhum indicado, pede qual no campo do formulario', async () => {
    respostas = [[], [{ idPedido: 7 }, { idPedido: 9 }]]

    await expect(
      escolherAnimais(tx as never, { idCaixa: 3, sexo: 'M' }, 1, { campoDoPedido: 'itens.0.idPedido' }),
    ).rejects.toEqual(
      expect.objectContaining({
        status: 409,
        codigo: 'PEDIDO_NAO_INDICADO',
        extras: { campos: { 'itens.0.idPedido': 'Escolha um dos pedidos: #7, #9.' } },
      }),
    )
  })

  it('com o pedido indicado, os reservados saem dele', async () => {
    respostas = [[], [{ idPedido: 7 }, { idPedido: 9 }], [animal(8, 9)]]

    const escolhidos = await escolherAnimais(tx as never, { idCaixa: 3, sexo: 'M' }, 1, { idPedido: 9 })

    expect(escolhidos).toEqual([animal(8, 9)])
  })

  it('o pedido indicado completa os livres: e o remedio que a recusa PEDIDO_NAO_INDICADO pede', async () => {
    respostas = [[animal(1), animal(2), animal(3)], [{ idPedido: 7 }, { idPedido: 9 }], [animal(8, 9), animal(10, 9)]]

    const escolhidos = await escolherAnimais(tx as never, { idCaixa: 3, sexo: 'M' }, 5, { idPedido: 9 })

    expect(escolhidos.map((a) => a.id)).toEqual([1, 2, 3, 8, 10])
    // os que faltam saem do pedido indicado: LIMIT 2
    expect(consultas[2]?.values).toEqual(expect.arrayContaining([9, 2]))
  })

  it('sem animais que bastem, recusa com SEM_ANIMAIS', async () => {
    respostas = [[animal(1)], []]

    await expect(escolherAnimais(tx as never, { idParto: 4, sexo: 'M' }, 3)).rejects.toEqual(
      expect.objectContaining({ codigo: 'SEM_ANIMAIS', message: expect.stringContaining('so ha 1') }),
    )
  })

  it('so livres: nem olha os reservados', async () => {
    respostas = [[]]

    await expect(escolherAnimais(tx as never, { idParto: 4, sexo: 'F' }, 1, { soLivres: true })).rejects.toEqual(
      recusa(409, 'SEM_ANIMAIS'),
    )
    expect(consultas).toHaveLength(1)
  })

  it('os ja escolhidos na mesma transacao ficam de fora (o FOR UPDATE nao os esconde de quem travou)', async () => {
    respostas = [[animal(3)]]

    await escolherAnimais(tx as never, { idParto: 4, sexo: 'F' }, 1, { excluir: [1, 2] })

    expect(consultas[0]?.text).toContain('"id" NOT IN')
    expect(consultas[0]?.values).toEqual(expect.arrayContaining([1, 2]))
  })

  it('quantidade zero nao consulta nada', async () => {
    expect(await escolherAnimais(tx as never, { idParto: 4, sexo: 'F' }, 0)).toEqual([])
    expect(consultas).toHaveLength(0)
  })

  it('so do pedido: pega so os reservados dele, sem passar pelos livres', async () => {
    respostas = [[animal(8, 9), animal(10, 9)]]

    const escolhidos = await escolherAnimais(tx as never, { idCaixa: 3, sexo: 'M' }, 2, {
      idPedido: 9,
      soDoPedido: true,
    })

    expect(escolhidos.map((a) => a.id)).toEqual([8, 10])
    expect(consultas).toHaveLength(1)
    expect(consultas[0]?.text).toContain('"id_pedido" = $')
    expect(consultas[0]?.text).not.toContain('"id_pedido" IS NULL')
  })

  it('com o pedido indicado sem reservado no grupo, a recusa diz isso no campo do pedido, e nao a falta generica', async () => {
    respostas = [[animal(1)], [{ idPedido: 7 }]]

    await expect(
      escolherAnimais(tx as never, { idCaixa: 3, sexo: 'M', dtNascimento: '2026-10-01' }, 2, {
        idPedido: 9,
        campoDoPedido: 'itens.0.idPedido',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        codigo: 'SEM_ANIMAIS',
        message: 'Os livres nao bastam, e o pedido #9 nao tem machos reservados nesta caixa e idade.',
        extras: { campos: { 'itens.0.idPedido': expect.stringContaining('os que ha sao dos pedidos #7') } },
      }),
    )
  })

  it('a falta generica conta no numero certo', async () => {
    respostas = [[animal(1)], []]

    await expect(escolherAnimais(tx as never, { idCaixa: 3, sexo: 'F' }, 2)).rejects.toEqual(
      expect.objectContaining({
        codigo: 'SEM_ANIMAIS',
        message: 'Pediu 2 femeas, mas so ha 1 nesta caixa e idade para esta operacao.',
      }),
    )

    respostas = [[], []]
    await expect(escolherAnimais(tx as never, { idParto: 4, sexo: 'M' }, 1)).rejects.toEqual(
      expect.objectContaining({ message: 'Nao ha machos vivos deste parto para esta operacao.' }),
    )
  })

  it('so do pedido sem dizer o pedido e erro no campo, e nao volta para os livres', async () => {
    await expect(
      escolherAnimais(tx as never, { idCaixa: 3, sexo: 'M' }, 2, { soDoPedido: true, campoDoPedido: 'machos.idPedido' }),
    ).rejects.toEqual(
      expect.objectContaining({ status: 400, extras: { campos: { 'machos.idPedido': expect.stringContaining('pedido') } } }),
    )
    expect(consultas).toHaveLength(0)
  })

  it('so do pedido, sem reservados que bastem: SEM_ANIMAIS dizendo o pedido, mesmo com livres no grupo', async () => {
    respostas = [[animal(8, 9)]]

    await expect(
      escolherAnimais(tx as never, { idCaixa: 3, sexo: 'M' }, 2, { idPedido: 9, soDoPedido: true }),
    ).rejects.toEqual(
      expect.objectContaining({ codigo: 'SEM_ANIMAIS', message: expect.stringContaining('machos do pedido #9') }),
    )
  })
})

describe('a idade do grupo', () => {
  const comIdades = (...datas: string[]) => ({
    parto: { findMany: async () => datas.map((data) => ({ dtPartoReal: d(data) })) },
  })

  it('a indicada vale sem consultar', async () => {
    expect(await idadeDoGrupo({} as never, 3, 'M', '2026-10-01', 'dtNascimento')).toBe('2026-10-01')
  })

  it('sem indicar, a unica idade do sexo na caixa; sem vivo, nenhuma', async () => {
    expect(await idadeDoGrupo(comIdades('2026-09-01') as never, 3, 'M', undefined, 'dtNascimento')).toBe('2026-09-01')
    expect(await idadeDoGrupo(comIdades() as never, 3, 'M', undefined, 'dtNascimento')).toBeUndefined()
  })

  it('com mais de uma idade, pede a data no campo do formulario', async () => {
    await expect(
      idadeDoGrupo(comIdades('2026-09-01', '2026-10-01') as never, 3, 'F', undefined, 'femeas.dtNascimento'),
    ).rejects.toEqual(
      expect.objectContaining({
        status: 400,
        extras: {
          campos: {
            'femeas.dtNascimento':
              'A caixa tem femeas de mais de uma idade: diga a data de nascimento (01/09/2026, 01/10/2026).',
          },
        },
      }),
    )
  })
})

describe('os reservados de um pedido', () => {
  it('trava todos os vivos do pedido, pela ordem de id, esperando quem os tem em vez de pular', async () => {
    respostas = [[{ ...animal(4, 7), sexo: 'M', idParto: 2, dtDesmameReal: null, codigo: 'F2A' }]]

    const reservados = await travarReservados(tx as never, 7)

    expect(reservados.map((a) => [a.id, a.codigo])).toEqual([[4, 'F2A']])
    const [sql] = consultas
    expect(sql?.text).toContain(`a."situacao" = 'vivo' AND a."id_pedido" = $`)
    expect(sql?.text).toContain('ORDER BY a."id"')
    expect(sql?.text).toContain('FOR UPDATE OF a')
    expect(sql?.text).not.toContain('SKIP LOCKED')
    expect(sql?.values).toEqual([7])
  })
})

describe('de qual pedido saem os reservados', () => {
  it('o indicado, se tem reservados no grupo', () => {
    expect(pedidoDosReservados([7, 9], 9)).toBe(9)
  })

  it('o indicado sem reservado no grupo e recusado no campo, dizendo de que pedidos sao os que ha', () => {
    expect(() => pedidoDosReservados([7], 9, 'machos.idPedido', 'machos reservados nesta caixa e idade')).toThrow(
      expect.objectContaining({
        status: 409,
        codigo: 'SEM_ANIMAIS',
        message: 'Os livres nao bastam, e o pedido #9 nao tem machos reservados nesta caixa e idade.',
        extras: {
          campos: { 'machos.idPedido': 'O pedido #9 nao tem machos reservados nesta caixa e idade; os que ha sao dos pedidos #7.' },
        },
      }),
    )
    expect(() => pedidoDosReservados([], 9)).toThrow(
      expect.objectContaining({ extras: { campos: { idPedido: 'O pedido #9 nao tem reservados neste grupo.' } } }),
    )
  })

  it('o unico, sem precisar indicar; nenhum quando nao ha reservado', () => {
    expect(pedidoDosReservados([7], undefined)).toBe(7)
    expect(pedidoDosReservados([], undefined)).toBeNull()
  })

  it('os pedidos tocados, sem repetir e sem os livres', () => {
    expect(pedidosTocados([{ idPedido: 7 }, { idPedido: null }, { idPedido: 7 }, { idPedido: 2 }])).toEqual([7, 2])
  })
})

describe('a data da saida contra a dos escolhidos', () => {
  const chegou = { ...animal(1), dtMovimento: d('2026-10-25') }

  it('nao pode ser antes do nascimento nem da chegada na caixa; o mesmo dia vale', () => {
    expect(() => exigirDepoisDaChegada('dtFato', '2026-10-25', [animal(2), chegou])).not.toThrow()
    expect(() => exigirDepoisDaChegada('dtFato', '2026-10-24', [chegou])).toThrow(
      expect.objectContaining({
        extras: { campos: { dtFato: 'Nao pode ser antes da chegada dos animais na caixa (25/10/2026).' } },
      }),
    )
    expect(() => exigirDepoisDaChegada('dtFato', '2026-09-30', [animal(2)])).toThrow(
      expect.objectContaining({ status: 400 }),
    )
  })
})
