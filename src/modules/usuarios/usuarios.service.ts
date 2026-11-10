import { erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { prisma } from '../../shared/prisma.ts'
import { exigirCodigo, perfil as dicPerfil } from '../../shared/traducao.ts'
import type { Perfil } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { pedirCodigo } from '../login/acesso.service.ts'
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

const ROTULO_DO_PERFIL: Record<Perfil, string> = { tecnico: 'Técnico', gestor: 'Gestor', pesquisador: 'Pesquisador' }

export type NovoUsuario = {
  nome: string
  email: string
  perfil: Perfil
}

export async function criarUsuario(dados: NovoUsuario, gestor: UsuarioDaSessao) {
  const email = dados.email.trim().toLowerCase()
  const existente = await prisma.usuario.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
  })

  if (existente !== null) {
    throw erroDeRegra('EMAIL_EM_USO', `Já existe uma conta com o e-mail ${email}.`)
  }

  const criado = await prisma.$transaction(async (tx) => {
    const usuario = await tx.usuario.create({
      data: {
        nome: dados.nome,
        email,
        perfil: exigirCodigo(dicPerfil, dados.perfil, 'Perfil'),
      },
    })

    await registrarHistorico(tx, {
      idUsuario: gestor.id,
      entidade: 'usuario',
      idEntidade: usuario.id,
      acao: 'cadastro',
      descricao: `Conta de ${dados.nome} (${email}) criada como ${ROTULO_DO_PERFIL[dados.perfil]}`,
      dados: { nome: dados.nome, email, perfil: dados.perfil },
    })

    return usuario
  })

  // A conta nasce sem senha: a pessoa define a dela pelo primeiro acesso, com o codigo que chega
  // por e-mail. Se o envio falhar (limite de pedidos, servico fora), a conta fica e o gestor
  // manda de novo pela redefinicao
  const codigoEnviado = await pedirCodigo(email).then(
    () => true,
    (erro: unknown) => {
      console.error(`[usuarios] o codigo para ${email} nao foi enviado:`, erro)
      return false
    },
  )

  return { ...paraApi(criado), codigoEnviado }
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
    throw naoEncontrado('Conta')
  }

  const perfilAntes = dicPerfil.paraApi(usuario.perfil)
  const mudaPerfil = dados.perfil !== undefined && dados.perfil !== perfilAntes
  const mudaAtivo = dados.ativo !== undefined && dados.ativo !== usuario.ativo

  if (id === gestor.id && (mudaPerfil || dados.ativo === false)) {
    throw erroDeRegra(
      'ALTERACAO_PROPRIA',
      'Você não pode mudar o próprio perfil nem desativar a própria conta.',
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

/**
 * O gestor nao define a senha de ninguem: so faz o codigo do "esqueci a senha" chegar ao e-mail
 * da pessoa. A senha atual e as sessoes ficam como estao ate ela definir a nova. O codigo nao
 * volta na resposta
 */
export async function enviarRedefinicaoDeSenha(id: number, gestor: UsuarioDaSessao) {
  const usuario = await prisma.usuario.findUnique({ where: { id } })

  if (usuario === null) {
    throw naoEncontrado('Conta')
  }

  // A conta inativa nao recebe codigo: pedirCodigo responderia igual, mas o e-mail nao sairia
  if (!usuario.ativo) {
    throw erroDeRegra('CONTA_INATIVA', 'A conta está desativada. Reative-a antes de enviar o código.')
  }

  const { validadeEmMinutos } = await pedirCodigo(usuario.email)

  await registrarHistorico(prisma, {
    idUsuario: gestor.id,
    entidade: 'usuario',
    idEntidade: id,
    acao: 'redefinicao_senha',
    descricao: `Código para redefinir a senha de ${usuario.nome} enviado por e-mail`,
  })

  return { email: usuario.email, validadeEmMinutos }
}
