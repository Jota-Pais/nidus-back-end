import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { criarSessao, sessaoValida } from '../login/sessao.ts'
import { alterarUsuario, criarUsuario, definirSenhaDoUsuario } from './usuarios.service.ts'

const banco = vi.hoisted(() => ({
  existente: null as Record<string, unknown> | null,
  usuario: null as Record<string, unknown> | null,
  criado: null as Record<string, unknown> | null,
  atualizado: null as Record<string, unknown> | null,
  historico: null as Record<string, unknown> | null,
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    usuario: {
      findFirst: async () => banco.existente,
      findUnique: async () => banco.usuario,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        usuario: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            banco.criado = data
            return { id: 9, ativo: true, ...data }
          },
          update: async ({ data }: { data: Record<string, unknown> }) => {
            banco.atualizado = data
            return { ...banco.usuario, ...data }
          },
        },
        historico: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            banco.historico = data
          },
        },
      }),
  },
}))

const gestor: UsuarioDaSessao = { id: 1, nome: 'Gestora', email: 'gestor@ufsc.br', perfil: 'gestor' }
const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

beforeEach(() => {
  banco.existente = null
  banco.usuario = {
    id: 5,
    nome: 'Ana',
    email: 'ana@ufsc.br',
    perfil: 'P',
    ativo: true,
    hashSenha: null,
  }
  banco.criado = null
  banco.atualizado = null
  banco.historico = null
})

describe('cadastro de conta', () => {
  it('grava o e-mail em minusculas e a senha so como hash', async () => {
    const conta = await criarUsuario(
      { nome: 'Bia', email: ' Bia@UFSC.br ', perfil: 'tecnico', senha: 'senha-segura' },
      gestor,
    )

    expect(conta).toMatchObject({ email: 'bia@ufsc.br', perfil: 'tecnico', temSenha: true })
    expect(banco.criado?.hashSenha).not.toBe('senha-segura')
    expect(JSON.stringify(banco.historico)).not.toContain('senha-segura')
  })

  it('e-mail ja usado e recusado', async () => {
    banco.existente = { id: 3 }

    await expect(
      criarUsuario({ nome: 'Bia', email: 'bia@ufsc.br', perfil: 'tecnico', senha: 'senha-segura' }, gestor),
    ).rejects.toEqual(recusa(409, 'EMAIL_EM_USO'))
  })
})

describe('alteracao de conta', () => {
  it('o gestor nao muda o proprio perfil nem se desativa', async () => {
    banco.usuario = { ...banco.usuario, id: 1, perfil: 'G' }

    await expect(alterarUsuario(1, { perfil: 'tecnico' }, gestor)).rejects.toEqual(
      recusa(409, 'ALTERACAO_PROPRIA'),
    )
    await expect(alterarUsuario(1, { ativo: false }, gestor)).rejects.toEqual(
      recusa(409, 'ALTERACAO_PROPRIA'),
    )
  })

  it('mudar o perfil derruba as sessoes abertas da pessoa', async () => {
    const sessao = criarSessao({ id: 5, nome: 'Ana', email: 'ana@ufsc.br', perfil: 'pesquisador' })

    await alterarUsuario(5, { perfil: 'tecnico' }, gestor)

    expect(banco.atualizado).toMatchObject({ perfil: 'T' })
    expect(sessaoValida(sessao)).toBeUndefined()
  })

  it('so trocar o nome mantem a sessao', async () => {
    const sessao = criarSessao({ id: 5, nome: 'Ana', email: 'ana@ufsc.br', perfil: 'pesquisador' })

    await alterarUsuario(5, { nome: 'Ana Souza' }, gestor)

    expect(sessaoValida(sessao)).toBeDefined()
  })

  it('conta inexistente e 404', async () => {
    banco.usuario = null

    await expect(alterarUsuario(5, { nome: 'x' }, gestor)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })
})

describe('senha definida pelo gestor', () => {
  it('troca o hash, derruba a sessao e nao guarda a senha no historico', async () => {
    const sessao = criarSessao({ id: 5, nome: 'Ana', email: 'ana@ufsc.br', perfil: 'pesquisador' })

    await definirSenhaDoUsuario(5, 'nova-senha-123', gestor)

    expect(banco.atualizado?.hashSenha).toBeTypeOf('string')
    expect(banco.atualizado?.hashSenha).not.toBe('nova-senha-123')
    expect(JSON.stringify(banco.historico)).not.toContain('nova-senha-123')
    expect(sessaoValida(sessao)).toBeUndefined()
  })
})
