import { describe, expect, it, vi } from 'vitest'
import { buscarAtendimento } from '../motor/motor.service.ts'
import { montarQuadro } from './caixa.service.ts'

// O banco aqui e de mentira: guarda a consulta que o kanban e a busca fizeram em caixa e
// devolve lista vazia. O que se testa e o filtro da consulta, sem abrir conexao

type ConsultaDeCaixa = { where: Record<string, unknown> }

const consultas = vi.hoisted(() => ({ caixa: [] as ConsultaDeCaixa[] }))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    especie: { findMany: async () => [{ id: 1, nome: 'Rato' }] },
    caixa: {
      findMany: async (consulta: ConsultaDeCaixa) => {
        consultas.caixa.push(consulta)
        return []
      },
    },
  },
}))

// A grade deixa formar casal em qualquer caixa da estante, inclusive nas marcadas como
// maternidade (M) ou recria (C). Se o kanban ou a busca filtrarem pela finalidade da caixa,
// esse casal some das duas telas e continua so na grade
describe('casal em caixa de maternidade ou recria', () => {
  it('aparece no kanban: a consulta nao filtra a finalidade da caixa', async () => {
    await montarQuadro('rato')

    const filtro = consultas.caixa.at(-1)?.where

    expect(filtro).toMatchObject({ idEspecie: 1, ativa: true, casais: { some: {} } })
    expect(filtro).not.toHaveProperty('finalidade')
  })

  it('aparece na busca de atendimento: a consulta nao filtra a finalidade da caixa', async () => {
    await buscarAtendimento(
      { especie: 'rato', machos: 2, femeas: 2, qualquer: 0, idadeMin: 28, idadeMax: 28 },
      new Date('2026-10-29T12:00:00.000Z'),
    )

    const filtro = consultas.caixa.at(-1)?.where

    expect(filtro).toMatchObject({ idEspecie: 1, ativa: true, casais: { some: { ativo: true } } })
    expect(filtro).not.toHaveProperty('finalidade')
  })
})
