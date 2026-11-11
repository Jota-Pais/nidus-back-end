import { describe, expect, it, vi } from 'vitest'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import { FAIXAS_DE_IDADE_DOS_LIVRES, lerVisaoGeral, montarVisaoGeral } from './visaoGeral.service.ts'
import type { EspecieDoCatalogo, GrupoDeVivos } from './visaoGeral.service.ts'

// A visao geral e so contagem: aqui o que entra em cada numero e em cada faixa de idade, com os
// grupos de vivos montados a mao, e a leitura com o banco de mentira

const hoje = '2026-11-10'
const nascidoHa = (dias: number) => somarDias(hoje, -dias)

const rato: EspecieDoCatalogo = {
  nome: 'Rato',
  linhagens: [
    { id: 1, nome: 'Wistar', ativa: true },
    { id: 2, nome: 'Kyoto', ativa: true },
  ],
}

const grupo = (campos: Partial<GrupoDeVivos>): GrupoDeVivos => ({
  idLinhagem: 1,
  sexo: 'M',
  reservado: false,
  dtNascimento: nascidoHa(40),
  desmamado: true,
  qtd: 1,
  ...campos,
})

const wistar = (grupos: GrupoDeVivos[], casais = new Map<number, number>()) =>
  montarVisaoGeral([rato], casais, grupos, hoje).especies[0]?.linhagens.find((l) => l.idLinhagem === 1)

const faixas = (grupos: GrupoDeVivos[]) =>
  wistar(grupos)?.livresPorIdade.map(({ de, ate, m, f }) => [de, ate, m, f])

describe('a visao geral', () => {
  it('as quatro faixas sempre, nesta ordem, mesmo sem animal', () => {
    expect(faixas([])).toEqual([
      [0, 21, 0, 0],
      [22, 35, 0, 0],
      [36, 60, 0, 0],
      [61, null, 0, 0],
    ])
    expect(FAIXAS_DE_IDADE_DOS_LIVRES).toHaveLength(4)
  })

  it('os limites das faixas ficam dentro: 21 e 22, 35 e 36, 60 e 61', () => {
    const idades = [21, 22, 35, 36, 60, 61]
    expect(faixas(idades.map((idade) => grupo({ dtNascimento: nascidoHa(idade) })))).toEqual([
      [0, 21, 1, 0],
      [22, 35, 2, 0],
      [36, 60, 2, 0],
      [61, null, 1, 0],
    ])
  })

  it('o nascido hoje esta na primeira faixa, e a data no futuro, digitada errado, tambem', () => {
    expect(faixas([grupo({ dtNascimento: hoje, sexo: 'F' }), grupo({ dtNascimento: somarDias(hoje, 3) })])?.[0]).toEqual([
      0, 21, 1, 1,
    ])
  })

  it('os vivos sao os que mamam e os desmamados; cada vivo esta reservado ou livre', () => {
    const linhagem = wistar([
      grupo({ sexo: 'M', qtd: 3, desmamado: false, dtNascimento: nascidoHa(10) }),
      grupo({ sexo: 'F', qtd: 2, desmamado: false, dtNascimento: nascidoHa(10), reservado: true }),
      grupo({ sexo: 'M', qtd: 4 }),
      grupo({ sexo: 'F', qtd: 5, reservado: true }),
    ])

    expect(linhagem).toMatchObject({
      vivos: { m: 7, f: 7 },
      mamando: { m: 3, f: 2 },
      reservados: { m: 0, f: 7 },
      livres: { m: 7, f: 0 },
    })
    // so os livres entram nas faixas, os que mamam inclusive
    expect(linhagem?.livresPorIdade.map(({ m, f }) => [m, f])).toEqual([
      [3, 0],
      [0, 0],
      [4, 0],
      [0, 0],
    ])
  })

  it('o grupo de outra linhagem nao entra', () => {
    expect(wistar([grupo({ idLinhagem: 2, qtd: 9 })])?.vivos).toEqual({ m: 0, f: 0 })
  })

  it('casais conta os ativos da linhagem', () => {
    expect(wistar([], new Map([[1, 2], [2, 1]]))?.casais).toBe(2)
  })

  it('linhagens por nome; a ativa sem nada aparece zerada, a inativa so com vivo ou casal ativo', () => {
    const especie: EspecieDoCatalogo = {
      nome: 'Camundongo',
      linhagens: [
        { id: 10, nome: 'Swiss', ativa: true },
        { id: 11, nome: 'C57BL/6', ativa: false },
        { id: 12, nome: 'BALB/c', ativa: false },
        { id: 13, nome: 'A/J', ativa: false },
      ],
    }

    const visao = montarVisaoGeral(
      [especie],
      new Map([[13, 1]]),
      [grupo({ idLinhagem: 11, qtd: 2 })],
      hoje,
    )

    expect(visao.especies[0]?.codigo).toBe('camundongo')
    expect(visao.especies[0]?.nome).toBe('Camundongo')
    expect(visao.especies[0]?.linhagens.map((l) => [l.linhagem, l.casais, l.vivos.m])).toEqual([
      ['A/J', 1, 0],
      ['C57BL/6', 0, 2],
      ['Swiss', 0, 0],
    ])
  })

  it('o grupo sem data de nascimento conta nos vivos e nos livres, mas fica fora das faixas', () => {
    const linhagem = wistar([grupo({ dtNascimento: null, qtd: 2 })])

    expect(linhagem?.livres).toEqual({ m: 2, f: 0 })
    expect(linhagem?.livresPorIdade.every((faixa) => faixa.m === 0 && faixa.f === 0)).toBe(true)
  })
})

describe('os livres por idade em dias', () => {
  const dias = (grupos: GrupoDeVivos[]) => wistar(grupos)?.livresPorIdadeDias

  it('agrupa por idade, soma os sexos de partos diferentes do mesmo dia e ordena', () => {
    expect(
      dias([
        grupo({ dtNascimento: nascidoHa(40), sexo: 'M', qtd: 2 }),
        grupo({ dtNascimento: nascidoHa(10), sexo: 'F', qtd: 3 }),
        grupo({ dtNascimento: nascidoHa(40), sexo: 'F', qtd: 1 }),
        grupo({ dtNascimento: nascidoHa(40), sexo: 'M', qtd: 4 }),
      ]),
    ).toEqual([
      { idade: 10, m: 0, f: 3 },
      { idade: 40, m: 6, f: 1 },
    ])
  })

  it('reservados, sem data e idade negativa', () => {
    expect(
      dias([
        grupo({ reservado: true, qtd: 5 }),
        grupo({ dtNascimento: null, qtd: 2 }),
        grupo({ dtNascimento: nascidoHa(-3), qtd: 1 }),
        grupo({ dtNascimento: nascidoHa(0), sexo: 'F', qtd: 1 }),
      ]),
    ).toEqual([{ idade: 0, m: 1, f: 1 }])
  })

  it('sem livres, lista vazia; sem itens zerados', () => {
    expect(dias([])).toEqual([])
    expect(dias([grupo({ qtd: 0 })])).toEqual([])
  })
})

// ------------------------------------------------------------ a leitura

const banco = vi.hoisted(() => ({
  ondeDosAnimais: null as unknown,
  ondeDosCasais: null as unknown,
  partosLidos: 0,
}))

vi.mock('../../shared/prisma.ts', () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
  return {
    prisma: {
      especie: {
        findMany: async () => [
          { nome: 'Rato', linhagens: [{ id: 1, nome: 'Wistar', ativa: true }] },
          { nome: 'Camundongo', linhagens: [{ id: 2, nome: 'Swiss', ativa: true }] },
        ],
      },
      casal: {
        groupBy: async ({ where }: { where: unknown }) => {
          banco.ondeDosCasais = where
          return [{ idLinhagem: 1, _count: { _all: 2 } }]
        },
      },
      animal: {
        groupBy: async ({ where }: { where: unknown }) => {
          banco.ondeDosAnimais = where
          return [
            { idParto: 7, sexo: 'M', idPedido: null, _count: { _all: 3 } },
            { idParto: 7, sexo: 'F', idPedido: 4, _count: { _all: 2 } },
            { idParto: 8, sexo: 'F', idPedido: null, _count: { _all: 6 } },
          ]
        },
      },
      parto: {
        findMany: async () => {
          banco.partosLidos += 1
          return [
            { id: 7, dtPartoReal: d('2026-10-01'), dtDesmameReal: d('2026-10-23'), casal: { idLinhagem: 1 } },
            { id: 8, dtPartoReal: d('2026-11-01'), dtDesmameReal: null, casal: { idLinhagem: 2 } },
          ]
        },
      },
    },
  }
})

describe('a leitura da visao geral', () => {
  it('le so os vivos e os casais ativos, e cada parto vai para a linhagem do casal', async () => {
    const visao = await lerVisaoGeral(hoje)

    expect(banco.ondeDosAnimais).toEqual({ situacao: 'vivo' })
    expect(banco.ondeDosCasais).toEqual({ ativo: true })
    expect(banco.partosLidos).toBe(1)
    expect(visao.especies.map((e) => e.codigo)).toEqual(['rato', 'camundongo'])

    expect(visao.especies[0]?.linhagens[0]).toMatchObject({
      linhagem: 'Wistar',
      casais: 2,
      vivos: { m: 3, f: 2 },
      mamando: { m: 0, f: 0 },
      reservados: { m: 0, f: 2 },
      livres: { m: 3, f: 0 },
    })
    // nascidos em 01/10: 40 dias em 10/11
    expect(visao.especies[0]?.linhagens[0]?.livresPorIdade[2]).toEqual({ de: 36, ate: 60, m: 3, f: 0 })

    expect(visao.especies[1]?.linhagens[0]).toMatchObject({
      linhagem: 'Swiss',
      casais: 0,
      vivos: { m: 0, f: 6 },
      mamando: { m: 0, f: 6 },
      livres: { m: 0, f: 6 },
    })
  })
})
