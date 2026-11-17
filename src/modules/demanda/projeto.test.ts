import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { alterarLinhagem, criarLinhagem, criarProjeto } from './projeto.service.ts'
import type { DadosDoProjeto } from './projeto.service.ts'

const banco = vi.hoisted(() => ({
  responsavel: null as Record<string, unknown> | null,
  mesmoNumero: null as Record<string, unknown> | null,
  especie: null as Record<string, unknown> | null,
  linhagem: null as Record<string, unknown> | null,
  mesmoNome: null as Record<string, unknown> | null,
  criado: null as Record<string, unknown> | null,
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    usuario: { findUnique: async () => banco.responsavel },
    projeto: { findUnique: async () => banco.mesmoNumero },
    especie: { findUnique: async () => banco.especie },
    linhagem: {
      findUnique: async () => banco.linhagem,
      findFirst: async () => banco.mesmoNome,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        projeto: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            banco.criado = data
            return { id: 4 }
          },
        },
        linhagem: {
          create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 8, ativa: true, ...data }),
          update: async ({ data }: { data: Record<string, unknown> }) => ({ ...banco.linhagem, ...data }),
        },
        historico: { create: async () => ({}) },
      }),
  },
}))

const gestor: UsuarioDaSessao = { id: 1, nome: 'Gestora', email: 'gestor@ufsc.br', perfil: 'gestor' }
const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

const projeto: DadosDoProjeto = {
  numero: '23080.000123/2026-41',
  titulo: 'Estudo',
  idUsuarioResponsavel: 5,
  dtVigenciaInicio: '2026-01-01',
  dtVigenciaFim: '2027-12-31',
  cotaAutorizada: 120,
  situacao: 'vigente',
}

beforeEach(() => {
  banco.responsavel = { id: 5, ativo: true }
  banco.mesmoNumero = null
  banco.especie = { id: 1, nome: 'Rato' }
  banco.linhagem = { id: 3, idEspecie: 1, nome: 'Wistar', ativa: true, cruzamento: null }
  banco.mesmoNome = null
  banco.criado = null
})

describe('cadastro de projeto', () => {
  it('grava a situacao como codigo do banco', async () => {
    await expect(criarProjeto(projeto, gestor)).resolves.toEqual({ id: 4 })
    expect(banco.criado).toMatchObject({ situacao: 'V', cotaAutorizada: 120 })
  })

  it('vigencia que termina antes de comecar e recusada', async () => {
    await expect(
      criarProjeto({ ...projeto, dtVigenciaFim: '2025-12-31' }, gestor),
    ).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })

  it('responsavel sem conta ativa e recusado', async () => {
    banco.responsavel = { id: 5, ativo: false }

    await expect(criarProjeto(projeto, gestor)).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })

  it('numero repetido e recusado', async () => {
    banco.mesmoNumero = { id: 2 }

    await expect(criarProjeto(projeto, gestor)).rejects.toEqual(recusa(409, 'PROJETO_DUPLICADO'))
  })
})

describe('cadastro de linhagem', () => {
  it('nome repetido na mesma especie e recusado', async () => {
    banco.mesmoNome = { id: 3 }

    await expect(criarLinhagem({ idEspecie: 1, nome: 'wistar' }, gestor)).rejects.toEqual(
      recusa(409, 'LINHAGEM_DUPLICADA'),
    )
  })

  it('linhagem nova nasce ativa e, sem dizer o cruzamento, sem regra', async () => {
    await expect(criarLinhagem({ idEspecie: 1, nome: 'Lewis' }, gestor)).resolves.toEqual({
      id: 8,
      nome: 'Lewis',
      ativa: true,
      cruzamento: null,
    })
  })

  it('linhagem nova com o cruzamento escolhido', async () => {
    await expect(
      criarLinhagem({ idEspecie: 1, nome: 'Lewis', cruzamento: 'mesma_letra' }, gestor),
    ).resolves.toMatchObject({ cruzamento: 'mesma_letra' })
  })

  it('desativar a linhagem', async () => {
    await expect(alterarLinhagem(3, { ativa: false }, gestor)).resolves.toMatchObject({ ativa: false })
  })

  it('trocar só o cruzamento, ou tirar a regra', async () => {
    await expect(alterarLinhagem(3, { cruzamento: 'rodizio' }, gestor)).resolves.toMatchObject({
      nome: 'Wistar',
      ativa: true,
      cruzamento: 'rodizio',
    })
    await expect(alterarLinhagem(3, { cruzamento: null }, gestor)).resolves.toMatchObject({
      cruzamento: null,
    })
  })
})
