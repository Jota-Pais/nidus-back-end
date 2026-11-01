import { erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { prisma } from '../../shared/prisma.ts'
import { exigirCodigo, perfil as dicPerfil } from '../../shared/traducao.ts'
import type { Perfil } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { hashSenha } from '../login/senha.ts'
import { revogarSessoesDoUsuario } from '../login/sessao.ts'

function paraApi(usuario: {
  id: number
  nome: string
  email: string
  perfil: string
  ativo: boolean
  hashSenha: string | null
}) {
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    perfil: dicPerfil.paraApi(usuario.perfil),
    ativo: usuario.ativo,
    temSenha: usuario.hashSenha !== null,
  }
}

export async function listarUsuarios() {
  const usuarios = await prisma.usuario.findMany({ orderBy: { nome: 'asc' } })

  return { usuarios: usuarios.map(paraApi) }
}

export type NovoUsuario = {
  nome: string
  email: string
  perfil: Perfil
  senha: string
}

export async function criarUsuario(dados: NovoUsuario, gestor: UsuarioDaSessao) {
  const email = dados.email.trim().toLowerCase()
  const existente = await prisma.usuario.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
  })

  if (existente !== null) {
    throw erroDeRegra('EMAIL_EM_USO', `Ja existe uma conta com o e-mail ${email}.`)
  }

  const hash = await hashSenha(dados.senha)

  const criado = await prisma.$transaction(async (tx) => {
    const usuario = await tx.usuario.create({
      data: {
        nome: dados.nome,
        email,
        perfil: exigirCodigo(dicPerfil, dados.perfil, 'Perfil'),
        hashSenha: hash,
      },
    })

    await registrarHistorico(tx, {
      idUsuario: gestor.id,
      entidade: 'usuario',
      idEntidade: usuario.id,
      acao: 'cadastro',
      descricao: `Conta de ${dados.nome} (${email}) criada como ${dados.perfil}`,
      dados: { nome: dados.nome, email, perfil: dados.perfil },
    })

    return usuario
  })

  return paraApi(criado)
}

export type AlteracaoDeUsuario = {
  nome?: string | undefined
  perfil?: Perfil | undefined
  ativo?: boolean | undefined
}

export async function alterarUsuario(
  id: number,
  dados: AlteracaoDeUsuario,
  gestor: UsuarioDaSessao,
) {
  const usuario = await prisma.usuario.findUnique({ where: { id } })

  if (usuario === null) {
    throw naoEncontrado('Usuario')
  }

  const perfilAntes = dicPerfil.paraApi(usuario.perfil)
  const mudaPerfil = dados.perfil !== undefined && dados.perfil !== perfilAntes
  const mudaAtivo = dados.ativo !== undefined && dados.ativo !== usuario.ativo

  if (id === gestor.id && (mudaPerfil || dados.ativo === false)) {
    throw erroDeRegra(
      'ALTERACAO_PROPRIA',
      'Voce nao pode mudar o proprio perfil nem desativar a propria conta.',
    )
  }

  const atualizado = await prisma.$transaction(async (tx) => {
    const salvo = await tx.usuario.update({
      where: { id },
      data: {
        ...(dados.nome === undefined ? {} : { nome: dados.nome }),
        ...(dados.perfil === undefined
          ? {}
          : { perfil: exigirCodigo(dicPerfil, dados.perfil, 'Perfil') }),
        ...(dados.ativo === undefined ? {} : { ativo: dados.ativo }),
      },
    })

    await registrarHistorico(tx, {
      idUsuario: gestor.id,
      entidade: 'usuario',
      idEntidade: id,
      acao: 'alteracao',
      descricao: `Conta de ${salvo.nome} alterada`,
      dados: {
        antes: { nome: usuario.nome, perfil: perfilAntes, ativo: usuario.ativo },
        depois: { nome: salvo.nome, perfil: dicPerfil.paraApi(salvo.perfil), ativo: salvo.ativo },
      },
    })

    return salvo
  })

  if (mudaPerfil || mudaAtivo) {
    revogarSessoesDoUsuario(id)
  }

  return paraApi(atualizado)
}

export async function definirSenhaDoUsuario(id: number, senha: string, gestor: UsuarioDaSessao) {
  const usuario = await prisma.usuario.findUnique({ where: { id } })

  if (usuario === null) {
    throw naoEncontrado('Usuario')
  }

  const hash = await hashSenha(senha)

  await prisma.$transaction(async (tx) => {
    await tx.usuario.update({ where: { id }, data: { hashSenha: hash } })

    await registrarHistorico(tx, {
      idUsuario: gestor.id,
      entidade: 'usuario',
      idEntidade: id,
      acao: 'nova_senha',
      descricao: `Senha de ${usuario.nome} redefinida pelo gestor`,
    })
  })

  if (id !== gestor.id) {
    revogarSessoesDoUsuario(id)
  }

  return { id, temSenha: true }
}
