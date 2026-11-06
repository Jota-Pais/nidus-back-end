import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { criarSessao, sessaoValida } from '../login/sessao.ts'
import { pedirCodigo } from '../login/acesso.service.ts'
import { alterarUsuario, criarUsuario, enviarRedefinicaoDeSenha } from './usuarios.service.ts'

const banco = vi.hoisted(() => ({
  existente: null as Record<string, unknown> | null,
  usuario: null as Record<string, unknown> | null,
  criado: null as Record<string, unknown> | null,
  atualizado: null as Record<string, unknown> | null,
  historico: null as Record<string, unknown> | null,
}))

vi.mock('../login/acesso.service.ts', () => ({
  pedirCodigo: vi.fn(async () => ({ validadeEmMinutos: 15 })),
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    usuario: {
      findFirst: async () => banco.existente,
      findUnique: async () => banco.usuario,
    },
    historico: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        banco.historico = data
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        usuario: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            banco.criado = data
            return { id: 9, ativo: true, hashSenha: null, ...data }
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
  vi.mocked(pedirCodigo).mockClear()
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
  it('grava o e-mail em minusculas, sem senha, e manda o codigo para a pessoa definir a dela', async () => {
    const conta = await criarUsuario({ nome: 'Bia', email: ' Bia@Exemplo.com ', perfil: 'tecnico' }, gestor)

    expect(conta).toMatchObject({
      email: 'bia@exemplo.com',
      perfil: 'tecnico',
      temSenha: false,
      codigoEnviado: true,
    })
    expect(banco.criado).not.toHaveProperty('hashSenha')
    expect(pedirCodigo).toHaveBeenCalledWith('bia@exemplo.com')
  })

  it('se o envio do codigo falhar, a conta fica criada e a resposta avisa', async () => {
    vi.mocked(pedirCodigo).mockRejectedValueOnce(new Error('servico fora'))
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined)

    const conta = await criarUsuario({ nome: 'Bia', email: 'bia@exemplo.com', perfil: 'tecnico' }, gestor)

    expect(conta).toMatchObject({ id: 9, codigoEnviado: false })
  })

  it('e-mail ja usado e recusado, sem enviar codigo', async () => {
    banco.existente = { id: 3 }

    await expect(
      criarUsuario({ nome: 'Bia', email: 'bia@exemplo.com', perfil: 'tecnico' }, gestor),
    ).rejects.toEqual(recusa(409, 'EMAIL_EM_USO'))
    expect(pedirCodigo).not.toHaveBeenCalled()
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

describe('redefinicao de senha pelo gestor', () => {
  it('manda o codigo para o e-mail da pessoa, registra no historico e nao mexe na senha nem na sessao', async () => {
    const sessao = criarSessao({ id: 5, nome: 'Ana', email: 'ana@ufsc.br', perfil: 'pesquisador' })

    const resposta = await enviarRedefinicaoDeSenha(5, gestor)

    expect(pedirCodigo).toHaveBeenCalledWith('ana@ufsc.br')
    expect(resposta).toEqual({ email: 'ana@ufsc.br', validadeEmMinutos: 15 })
    expect(banco.atualizado).toBeNull()
    expect(banco.historico).toMatchObject({ entidade: 'usuario', idEntidade: 5, acao: 'redefinicao_senha' })
    expect(sessaoValida(sessao)).toBeDefined()
  })

  it('conta inexistente e 404 e conta desativada e 409, sem enviar codigo', async () => {
    banco.usuario = null
    await expect(enviarRedefinicaoDeSenha(5, gestor)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))

    banco.usuario = { id: 5, nome: 'Ana', email: 'ana@ufsc.br', perfil: 'P', ativo: false, hashSenha: null }
    await expect(enviarRedefinicaoDeSenha(5, gestor)).rejects.toEqual(recusa(409, 'CONTA_INATIVA'))
    expect(pedirCodigo).not.toHaveBeenCalled()
  })
})
