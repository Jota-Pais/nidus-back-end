import { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { escolherAnimais, exigirDepoisDaChegada, pedidoDosReservados, pedidosTocados } from './escolha.ts'
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
})

describe('de qual pedido saem os reservados', () => {
  it('o indicado, se tem reservados no grupo; senao nenhum', () => {
    expect(pedidoDosReservados([7, 9], 9)).toBe(9)
    expect(pedidoDosReservados([7], 9)).toBeNull()
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
