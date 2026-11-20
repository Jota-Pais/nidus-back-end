import type { RequestHandler } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { criarApp } from '../../app.ts'
import type { Perfil } from '../../shared/traducao.ts'
import { filtroDasLiberadas } from './caixa.routes.ts'

// GET /api/caixas/liberadas: o perfil, a validacao da consulta e a rota antes de /:id. O servico e de mentira

const mocks = vi.hoisted(() => ({
  listarLiberadas: vi.fn(async (_filtro: unknown) => ({ caixas: [], temMais: false })),
  montarFicha: vi.fn(async (_id: number) => ({})),
}))

vi.mock('./liberadas.service.ts', () => ({ listarLiberadas: mocks.listarLiberadas }))
vi.mock('./ficha.service.ts', () => ({ montarFicha: mocks.montarFicha }))

const como = (perfil: Perfil): RequestHandler => (req, _res, next) => {
  req.usuario = { id: 1, nome: 'Teste', email: 'teste@ufsc.br', perfil }
  next()
}

const app = (perfil: Perfil) => criarApp({ autenticacao: como(perfil) })

describe('GET /api/caixas/liberadas', () => {
  beforeEach(() => {
    mocks.listarLiberadas.mockClear()
    mocks.montarFicha.mockClear()
  })

  it('pesquisador nao lista', async () => {
    const r = await request(app('pesquisador')).get('/api/caixas/liberadas').query({ idEspecie: 1 })

    expect(r.status).toBe(403)
    expect(mocks.listarLiberadas).not.toHaveBeenCalled()
  })

  it.each(['tecnico', 'gestor'] as const)('%s lista, e nao cai em /:id', async (perfil) => {
    const r = await request(app(perfil)).get('/api/caixas/liberadas').query({ idEspecie: 1 })

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ caixas: [], temMais: false })
    expect(mocks.listarLiberadas).toHaveBeenCalledWith({ idEspecie: 1, limite: 50 })
    expect(mocks.montarFicha).not.toHaveBeenCalled()
  })

  it('repassa os filtros ja coagidos', async () => {
    await request(app('tecnico'))
      .get('/api/caixas/liberadas')
      .query({ idEspecie: '2', idLinhagem: '3', busca: '  ab ', de: '2026-01-01', ate: '2026-02-01', limite: '10' })

    expect(mocks.listarLiberadas).toHaveBeenCalledWith({
      idEspecie: 2,
      idLinhagem: 3,
      busca: 'ab',
      de: '2026-01-01',
      ate: '2026-02-01',
      limite: 10,
    })
  })

  it.each([
    ['sem idEspecie', {}],
    ['idEspecie abc', { idEspecie: 'abc' }],
    ['limite 0', { idEspecie: 1, limite: 0 }],
    ['limite 201', { idEspecie: 1, limite: 201 }],
    ['data invalida', { idEspecie: 1, de: '2026-13-40' }],
    ['de depois de ate', { idEspecie: 1, de: '2026-03-01', ate: '2026-02-01' }],
    ['busca vazia', { idEspecie: 1, busca: '' }],
    ['busca so de espacos', { idEspecie: 1, busca: '   ' }],
    ['busca com 41 letras', { idEspecie: 1, busca: 'a'.repeat(41) }],
  ])('%s e VALIDACAO', async (_nome, consulta) => {
    const r = await request(app('tecnico')).get('/api/caixas/liberadas').query(consulta)

    expect(r.status).toBe(400)
    expect(r.body.erro.codigo).toBe('VALIDACAO')
    expect(mocks.listarLiberadas).not.toHaveBeenCalled()
  })
})

describe('filtroDasLiberadas', () => {
  it('o limite padrao e 50', () => {
    expect(filtroDasLiberadas.parse({ idEspecie: '1' })).toEqual({ idEspecie: 1, limite: 50 })
  })

  it('de igual a ate vale, e o limite 200 tambem', () => {
    expect(filtroDasLiberadas.parse({ idEspecie: 1, de: '2026-01-01', ate: '2026-01-01', limite: '200' }).limite).toBe(200)
  })
})
