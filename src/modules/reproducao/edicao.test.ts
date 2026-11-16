import { beforeEach, describe, expect, it, vi } from 'vitest'
import { editarCasal, planejarEdicao } from './edicao.service.ts'
import type { LinhagemDosAnimais, PartoDoCasal, RetratoDoCasal } from './edicao.service.ts'

// A edicao do casal pela ficha: o plano (o que muda e o que recusa) contra o casal lido, e a
// gravacao com o Prisma de mentira. A FK composta parto -> casal com o CTE e o unique da ordem
// renumerada uma linha por vez sao do Postgres, conferidos fora desta suite

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const parto = (id: number, ordem: number, campos: Partial<PartoDoCasal> = {}): PartoDoCasal => ({
  id,
  ordem,
  dtAcasalamento: d('2026-09-01'),
  dtPartoReal: null,
  dtSemNinhada: null,
  ...campos,
})

/** O casal AB Wistar (rato), formado em 01/09 com o 1o parto acasalado no mesmo dia */
function retrato(campos: Partial<RetratoDoCasal> = {}, casal: Partial<RetratoDoCasal['casal']> = {}): RetratoDoCasal {
  return {
    casal: {
      identificacao: 'AB',
      grupoMacho: 'A',
      grupoFemea: 'B',
      idLinhagem: 3,
      linhagem: 'Wistar',
      dtFormacao: d('2026-09-01'),
      dtEncerramento: null,
      motivoEncerramento: null,
      ativo: true,
      idEspecie: 1,
      ...casal,
    },
    partos: [parto(10, 1)],
    anteriores: [],
    ...campos,
  }
}

/** A linhagem SHR (rato) e os animais do casal: 'animais' e 'caixasDeEstoque' por cenario */
const shr = (campos: Partial<LinhagemDosAnimais> = {}): LinhagemDosAnimais => ({
  nova: { id: 5, nome: 'SHR', idEspecie: 1 },
  animais: [],
  caixasDeEstoque: [],
  pedidos: [],
  ...campos,
})

const vivoEm = (idCaixa: number, idPedido: number | null = null) => ({ idCaixa, situacao: 'vivo', idPedido })
const noCampo = (campo: string, trecho: string) =>
  expect.objectContaining({ status: 400, extras: { campos: { [campo]: expect.stringContaining(trecho) } } })

describe('os grupos', () => {
  it('so as letras: a identificacao acompanha e nada mais muda', () => {
    const plano = planejarEdicao(retrato(), { grupoFemea: 'A' })

    expect(plano).toMatchObject({
      grupoMacho: 'A',
      grupoFemea: 'A',
      identificacao: 'AA',
      dtFormacao: '2026-09-01',
      idLinhagem: null,
      caixas: [],
      acasalamento: null,
      ordens: [],
      descricao: 'Casal AB editado: grupos AB → AA',
      antes: { grupoMacho: 'A', grupoFemea: 'B' },
      depois: { grupoMacho: 'A', grupoFemea: 'A' },
    })
  })

  it('qualquer par de A-E vale, tambem no casal encerrado', () => {
    const encerrado = retrato({}, { ativo: false, dtEncerramento: d('2026-10-20'), motivoEncerramento: 'idade' })

    expect(planejarEdicao(encerrado, { grupoMacho: 'E', grupoFemea: 'C' })?.identificacao).toBe('EC')
  })

  it('sem nada diferente do que esta gravado, nao ha o que gravar', () => {
    expect(planejarEdicao(retrato(), { grupoMacho: 'A', grupoFemea: 'B', dtFormacao: '2026-09-01', partoInicial: 1 })).toBeNull()
    expect(planejarEdicao(retrato(), { idLinhagem: 3 })).toBeNull()
  })
})

describe('a linhagem', () => {
  it('leva junto a caixa de estoque so com animais do casal e a liberada que so teve animais dele', () => {
    const linhagem = shr({
      animais: [vivoEm(1), vivoEm(6), vivoEm(6), { idCaixa: 8, situacao: 'morto', idPedido: null }],
      caixasDeEstoque: [
        { id: 6, codigo: 'F2C', outros: { vivos: 0, total: 2 } },
        { id: 8, codigo: 'F3A', outros: { vivos: 0, total: 0 } },
      ],
    })

    expect(planejarEdicao(retrato({ linhagem }), { idLinhagem: 5 })).toMatchObject({
      idLinhagem: 5,
      caixas: [6, 8],
      descricao: 'Casal AB editado: linhagem Wistar → SHR',
      antes: { idLinhagem: 3 },
      depois: { idLinhagem: 5 },
    })
  })

  it('a caixa de estoque com so mortos do casal e animais de outros fica como esta', () => {
    const linhagem = shr({
      animais: [{ idCaixa: 6, situacao: 'morto', idPedido: null }],
      caixasDeEstoque: [{ id: 6, codigo: 'F2C', outros: { vivos: 3, total: 3 } }],
    })

    expect(planejarEdicao(retrato({ linhagem }), { idLinhagem: 5 })?.caixas).toEqual([])
  })

  it('recusa a caixa de estoque com animais do casal junto com vivos de outra ninhada', () => {
    const linhagem = shr({
      animais: [vivoEm(6), vivoEm(7)],
      caixasDeEstoque: [
        { id: 6, codigo: 'F2C', outros: { vivos: 2, total: 2 } },
        { id: 7, codigo: 'F3C', outros: { vivos: 0, total: 0 } },
      ],
    })

    expect(() => planejarEdicao(retrato({ linhagem }), { idLinhagem: 5 })).toThrow(
      noCampo('idLinhagem', 'A caixa de estoque F2C tem animais deste casal junto com animais de outra ninhada'),
    )
  })

  it('recusa animal reservado para pedido de outra linhagem, e o pedido que ja recebeu', () => {
    const reservado = shr({ animais: [vivoEm(6, 12), vivoEm(6, 12)], pedidos: [{ id: 12, idLinhagem: 3, linhagem: 'Wistar' }] })
    const entregue = shr({
      animais: [{ idCaixa: 6, situacao: 'entregue', idPedido: 12 }],
      pedidos: [{ id: 12, idLinhagem: 3, linhagem: 'Wistar' }],
    })

    expect(() => planejarEdicao(retrato({ linhagem: reservado }), { idLinhagem: 5 })).toThrow(
      noCampo('idLinhagem', '2 animais deste casal estão reservados para o pedido #12, de Wistar. Desfaça a reserva'),
    )
    expect(() => planejarEdicao(retrato({ linhagem: entregue }), { idLinhagem: 5 })).toThrow(
      noCampo('idLinhagem', 'O pedido #12, de Wistar, já tem animais deste casal'),
    )
  })

  it('o pedido da mesma linhagem nova nao recusa', () => {
    const linhagem = shr({ animais: [vivoEm(1, 12)], pedidos: [{ id: 12, idLinhagem: 5, linhagem: 'SHR' }] })

    expect(planejarEdicao(retrato({ linhagem }), { idLinhagem: 5 })?.idLinhagem).toBe(5)
  })

  it('recusa linhagem de outra especie ou que nao existe', () => {
    const camundongo = shr({ nova: { id: 5, nome: 'Swiss', idEspecie: 2 } })

    expect(() => planejarEdicao(retrato({ linhagem: camundongo }), { idLinhagem: 5 })).toThrow(
      noCampo('idLinhagem', 'não é da espécie da caixa'),
    )
    expect(() => planejarEdicao(retrato({ linhagem: shr({ nova: null }) }), { idLinhagem: 5 })).toThrow(
      noCampo('idLinhagem', 'não encontrada'),
    )
  })
})

describe('a data de formacao', () => {
  it('leva o acasalamento do 1o parto quando ele era o da formacao', () => {
    const plano = planejarEdicao(retrato(), { dtFormacao: '2026-09-03' })

    expect(plano).toMatchObject({
      dtFormacao: '2026-09-03',
      acasalamento: { idParto: 10, antes: '2026-09-01', depois: '2026-09-03' },
      descricao: 'Casal AB editado: formação 01/09/2026 → 03/09/2026 (com o acasalamento do 1º parto)',
    })
  })

  it('o acasalamento corrigido a mao fica, e limita a formacao', () => {
    const corrigido = retrato({ partos: [parto(10, 1, { dtAcasalamento: d('2026-09-05') })] })

    expect(planejarEdicao(corrigido, { dtFormacao: '2026-09-04' })?.acasalamento).toBeNull()
    expect(() => planejarEdicao(corrigido, { dtFormacao: '2026-09-06' })).toThrow(
      noCampo('dtFormacao', 'Não pode ser depois do acasalamento do 1º parto (05/09/2026)'),
    )
  })

  it('a que acompanha nao passa do parto, e nenhuma passa do encerramento', () => {
    const nascido = retrato({ partos: [parto(10, 1, { dtPartoReal: d('2026-09-24') })] })
    const encerrado = retrato({}, { ativo: false, dtEncerramento: d('2026-09-10'), motivoEncerramento: 'idade' })

    expect(() => planejarEdicao(nascido, { dtFormacao: '2026-09-25' })).toThrow(
      noCampo('dtFormacao', 'Não pode ser depois do 1º parto (24/09/2026)'),
    )
    expect(() => planejarEdicao(encerrado, { dtFormacao: '2026-09-11' })).toThrow(
      noCampo('dtFormacao', 'Não pode ser depois do encerramento do casal (10/09/2026)'),
    )
  })

  it('nao comeca antes do encerramento do casal que estava antes na caixa', () => {
    const depoisDeOutro = retrato({ anteriores: [{ identificacao: 'CD', dtEncerramento: d('2026-08-30') }] })

    expect(() => planejarEdicao(depoisDeOutro, { dtFormacao: '2026-08-29' })).toThrow(
      noCampo('dtFormacao', 'do encerramento do casal CD, que estava antes nesta caixa'),
    )
  })
})

describe('o parto em que entrou no Nidus', () => {
  const tresPartos = () =>
    retrato({
      partos: [
        parto(10, 1, { dtPartoReal: d('2026-09-24') }),
        parto(11, 2, { dtAcasalamento: d('2026-09-30'), dtPartoReal: d('2026-10-23') }),
        parto(12, 3, { dtAcasalamento: d('2026-10-29') }),
      ],
    })

  it('renumera todos pelo mesmo deslocamento, do ultimo para o primeiro quando sobe', () => {
    expect(planejarEdicao(tresPartos(), { partoInicial: 2 })).toMatchObject({
      ordens: [
        { idParto: 12, de: 3, para: 4 },
        { idParto: 11, de: 2, para: 3 },
        { idParto: 10, de: 1, para: 2 },
      ],
      descricao: 'Casal AB editado: entrou no 1º parto → 2º',
      antes: { partoInicial: 1 },
      depois: { partoInicial: 2 },
    })
  })

  it('do primeiro para o ultimo quando desce', () => {
    const noTerceiro = retrato({ partos: [parto(10, 3, { dtPartoReal: d('2026-09-24') }), parto(11, 4)] })

    expect(planejarEdicao(noTerceiro, { partoInicial: 1 })?.ordens).toEqual([
      { idParto: 10, de: 3, para: 1 },
      { idParto: 11, de: 4, para: 2 },
    ])
  })

  it('recusa passar do 5o', () => {
    expect(() => planejarEdicao(tresPartos(), { partoInicial: 4 })).toThrow(
      noCampo('partoInicial', 'o último seria o 6º, e o casal tem no máximo 5 partos'),
    )
  })

  it('recusa o casal ativo com parto nascido no 5o: ele teria encerrado', () => {
    // o ativo tem sempre o acasalamento seguinte aberto, e o limite do 5o recusa antes; sem ele, e esta
    const ativo = retrato({ partos: [parto(10, 1, { dtPartoReal: d('2026-09-24') })] })

    expect(() => planejarEdicao(ativo, { partoInicial: 5 })).toThrow(
      noCampo('partoInicial', 'seria o 5º, e o casal teria encerrado nele'),
    )
  })

  it('recusa descer o casal encerrado sozinho no 5o, e aceita o encerrado a mao', () => {
    const partos = [parto(10, 4, { dtPartoReal: d('2026-09-24') }), parto(11, 5, { dtPartoReal: d('2026-10-23') })]
    const peloLimite = retrato({ partos }, { ativo: false, dtEncerramento: d('2026-10-23'), motivoEncerramento: 'Limite de 5 partos atingido' })
    const aMao = retrato({ partos }, { ativo: false, dtEncerramento: d('2026-10-23'), motivoEncerramento: 'idade' })

    expect(() => planejarEdicao(peloLimite, { partoInicial: 3 })).toThrow(
      noCampo('partoInicial', 'encerrado automaticamente'),
    )
    expect(planejarEdicao(aMao, { partoInicial: 3 })?.ordens).toHaveLength(2)
  })
})

it('tudo junto vira uma descricao so, com o nome de antes', () => {
  const plano = planejarEdicao(retrato({ linhagem: shr() }), {
    grupoMacho: 'B',
    grupoFemea: 'B',
    idLinhagem: 5,
    dtFormacao: '2026-09-02',
    partoInicial: 2,
  })

  expect(plano?.descricao).toBe(
    'Casal AB editado: grupos AB → BB, linhagem Wistar → SHR, formação 01/09/2026 → 02/09/2026 (com o acasalamento do 1º parto), entrou no 1º parto → 2º',
  )
})

// ------------------------------------------------------------------ a gravacao

const chamadas = vi.hoisted(() => [] as unknown[][])

const db = vi.hoisted(() => {
  const anotar =
    (nome: string, resposta: unknown = undefined) =>
    async (...args: unknown[]) => {
      chamadas.push([nome, ...args])
      return typeof resposta === 'function' ? (resposta as (...a: unknown[]) => unknown)(...args) : resposta
    }

  const casal = {
    idCaixa: 1,
    identificacao: 'AB',
    grupoMacho: 'A',
    grupoFemea: 'B',
    idLinhagem: 3,
    dtFormacao: new Date('2026-09-01T00:00:00.000Z'),
    dtEncerramento: null,
    motivoEncerramento: null,
    ativo: true,
    linhagem: { nome: 'Wistar' },
    caixa: { idEspecie: 1 },
    partos: [{ id: 10 }, { id: 11 }],
  }
  const partos = [
    { id: 10, ordem: 1, dtAcasalamento: new Date('2026-09-01T00:00:00.000Z'), dtPartoReal: new Date('2026-09-24T00:00:00.000Z'), dtSemNinhada: null },
    { id: 11, ordem: 2, dtAcasalamento: new Date('2026-09-30T00:00:00.000Z'), dtPartoReal: null, dtSemNinhada: null },
  ]

  const tx = {
    $queryRaw: anotar('trava', []),
    $executeRaw: anotar('linhagem', 1),
    casal: {
      findUnique: anotar('le casal', casal),
      findMany: anotar('le anteriores', []),
      update: anotar('casal'),
    },
    parto: { findMany: anotar('le partos', partos), update: anotar('parto') },
    linhagem: { findUnique: anotar('le linhagem', { id: 5, nome: 'SHR', idEspecie: 1 }) },
    animal: {
      findMany: anotar('le animais', (args: { where: { idParto: { in?: number[] } } }) =>
        args.where.idParto.in === undefined ? [] : [{ idCaixa: 1, situacao: 'vivo', idPedido: null }, { idCaixa: 6, situacao: 'vivo', idPedido: null }],
      ),
    },
    caixa: { findMany: anotar('le caixas', [{ id: 6, codigo: 'F2C' }]), updateMany: anotar('caixas') },
    pedido: { findMany: anotar('le pedidos', []) },
    historico: { create: anotar('historico') },
  }

  return { ...tx, $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) }
})

vi.mock('../../shared/prisma.ts', () => ({ prisma: db }))
vi.mock('./reproducao.service.ts', () => ({
  MOTIVO_DO_LIMITE_DE_PARTOS: 'Limite de 5 partos atingido',
  casalFicha: async (id: number) => ({ id }),
}))

const gravadas = () => chamadas.filter(([nome]) => !String(nome).startsWith('le ') && nome !== 'trava')

describe('a gravacao da edicao', () => {
  beforeEach(() => {
    chamadas.length = 0
  })

  it('renumera, troca a linhagem do casal e dos partos num comando so, a caixa, o casal e o historico', async () => {
    await editarCasal(1, { idLinhagem: 5, grupoFemea: 'A', partoInicial: 2 }, 4)

    const nomes = gravadas().map(([nome]) => nome)
    expect(nomes).toEqual(['parto', 'parto', 'linhagem', 'caixas', 'casal', 'historico'])

    const [ordem1, ordem2] = gravadas().filter(([nome]) => nome === 'parto')
    expect(ordem1?.[1]).toMatchObject({ where: { id: 11 }, data: { ordem: 3 } })
    expect(ordem2?.[1]).toMatchObject({ where: { id: 10 }, data: { ordem: 2 } })

    const sql = (gravadas().find(([nome]) => nome === 'linhagem')?.[1] as string[]).join('?')
    expect(sql).toContain('UPDATE "reproducao"."casal" SET "id_linhagem"')
    expect(sql).toContain('UPDATE "reproducao"."parto" SET "id_linhagem"')

    expect(gravadas().find(([nome]) => nome === 'caixas')?.[1]).toMatchObject({ where: { id: { in: [6] } }, data: { idLinhagem: 5 } })
    expect(gravadas().find(([nome]) => nome === 'casal')?.[1]).toMatchObject({
      data: { grupoMacho: 'A', grupoFemea: 'A', identificacao: 'AA' },
    })
    expect(gravadas().find(([nome]) => nome === 'historico')?.[1]).toEqual({
      data: expect.objectContaining({
        idUsuario: 4,
        entidade: 'casal',
        idEntidade: 1,
        acao: 'edicao_casal',
        descricao: 'Casal AB editado: grupos AB → AA, linhagem Wistar → SHR, entrou no 1º parto → 2º',
        dados: {
          antes: { grupoMacho: 'A', grupoFemea: 'B', idLinhagem: 3, partoInicial: 1 },
          depois: { grupoMacho: 'A', grupoFemea: 'A', idLinhagem: 5, partoInicial: 2 },
          caixas: [6],
        },
      }),
    })
  })

  it('trava o casal, os partos, as caixas e os pedidos antes de ler os animais de outros partos', async () => {
    await editarCasal(1, { idLinhagem: 5 }, 4)

    const travas = chamadas.filter(([nome]) => nome === 'trava').map(([, sql]) => (sql as string[]).join('?'))
    expect(travas.map((sql) => sql.match(/"(\w+)"\."(\w+)"/)?.[2])).toEqual(['casal', 'parto', 'parto', 'caixa'])
  })

  it('sem mudanca nao grava nada', async () => {
    await editarCasal(1, { grupoMacho: 'A' }, 4)

    expect(gravadas()).toEqual([])
  })
})
