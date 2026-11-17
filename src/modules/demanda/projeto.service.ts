// Os projetos aprovados na CEUA e as linhagens do catalogo, que so o gestor cadastra

import { agora as instanteAtual } from '../../shared/relogio.ts'
import { campoInvalido, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, hojeISO, paraData } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'

/** Como se cruzam as famílias A-E da linhagem: só serve para o aviso no casal */
type Cruzamento = 'rodizio' | 'mesma_letra'

const NOME_DO_CRUZAMENTO: Record<string, string> = { rodizio: 'em rodízio', mesma_letra: 'na mesma letra' }

export const SITUACAO_DO_PROJETO = { V: 'vigente', N: 'vencido', S: 'suspenso' } as const

export type SituacaoDoProjeto = (typeof SITUACAO_DO_PROJETO)[keyof typeof SITUACAO_DO_PROJETO]

const codigoDaSituacao = (situacao: SituacaoDoProjeto) =>
  (Object.keys(SITUACAO_DO_PROJETO) as (keyof typeof SITUACAO_DO_PROJETO)[]).find(
    (codigo) => SITUACAO_DO_PROJETO[codigo] === situacao,
  ) ?? 'V'

export type DadosDoProjeto = {
  numero: string
  titulo: string
  idUsuarioResponsavel: number
  dtVigenciaInicio: string
  dtVigenciaFim: string
  cotaAutorizada: number
  situacao: SituacaoDoProjeto
}

/** GET /api/projetos - o pesquisador so ve os proprios; tecnico e gestor veem todos */
export async function listarProjetos(usuario: UsuarioDaSessao, agora: Date = instanteAtual()) {
  const hoje = hojeISO(agora)
  const projetos = await prisma.projeto.findMany({
    where: usuario.perfil === 'pesquisador' ? { idUsuarioResponsavel: usuario.id } : {},
    orderBy: { numero: 'asc' },
    include: { usuarioResponsavel: { select: { nome: true } } },
  })

  return {
    projetos: projetos.map((projeto) => ({
      id: projeto.id,
      numero: projeto.numero,
      vigente: projeto.situacao === 'V' && dataISO(projeto.dtVigenciaFim) >= hoje,
      titulo: projeto.titulo,
      idUsuarioResponsavel: projeto.idUsuarioResponsavel,
      responsavel: projeto.usuarioResponsavel.nome,
      dtVigenciaInicio: dataISO(projeto.dtVigenciaInicio),
      dtVigenciaFim: dataISO(projeto.dtVigenciaFim),
      cotaAutorizada: projeto.cotaAutorizada,
      situacao: SITUACAO_DO_PROJETO[projeto.situacao as keyof typeof SITUACAO_DO_PROJETO],
    })),
  }
}

async function conferir(dados: DadosDoProjeto, idProjeto?: number) {
  if (dados.dtVigenciaFim < dados.dtVigenciaInicio) {
    throw campoInvalido('dtVigenciaFim', 'O fim da vigência não pode ser antes do início.')
  }

  const responsavel = await prisma.usuario.findUnique({ where: { id: dados.idUsuarioResponsavel } })

  if (responsavel === null || !responsavel.ativo) {
    throw campoInvalido('idUsuarioResponsavel', 'Escolha um responsável com conta ativa.')
  }

  const mesmoNumero = await prisma.projeto.findUnique({ where: { numero: dados.numero } })

  if (mesmoNumero !== null && mesmoNumero.id !== idProjeto) {
    throw erroDeRegra('PROJETO_DUPLICADO', `Já existe o projeto ${dados.numero}.`)
  }
}

function paraBanco(dados: DadosDoProjeto) {
  return {
    numero: dados.numero,
    titulo: dados.titulo,
    idUsuarioResponsavel: dados.idUsuarioResponsavel,
    dtVigenciaInicio: paraData(dados.dtVigenciaInicio),
    dtVigenciaFim: paraData(dados.dtVigenciaFim),
    cotaAutorizada: dados.cotaAutorizada,
    situacao: codigoDaSituacao(dados.situacao),
  }
}

export async function criarProjeto(dados: DadosDoProjeto, gestor: UsuarioDaSessao) {
  await conferir(dados)

  const criado = await prisma.$transaction(async (tx) => {
    const projeto = await tx.projeto.create({ data: paraBanco(dados) })

    await registrarHistorico(tx, {
      idUsuario: gestor.id,
      entidade: 'projeto',
      idEntidade: projeto.id,
      acao: 'cadastro',
      descricao: `Projeto ${dados.numero} cadastrado`,
      dados: { ...dados },
    })

    return projeto
  })

  return { id: criado.id }
}

export async function alterarProjeto(id: number, dados: DadosDoProjeto, gestor: UsuarioDaSessao) {
  const projeto = await prisma.projeto.findUnique({ where: { id } })

  if (projeto === null) {
    throw naoEncontrado('Projeto')
  }

  await conferir(dados, id)

  await prisma.$transaction(async (tx) => {
    await tx.projeto.update({ where: { id }, data: { ...paraBanco(dados), dtManutencao: instanteAtual() } })

    await registrarHistorico(tx, {
      idUsuario: gestor.id,
      entidade: 'projeto',
      idEntidade: id,
      acao: 'alteracao',
      descricao: `Projeto ${dados.numero} alterado`,
      dados: {
        antes: {
          numero: projeto.numero,
          titulo: projeto.titulo,
          idUsuarioResponsavel: projeto.idUsuarioResponsavel,
          dtVigenciaInicio: dataISO(projeto.dtVigenciaInicio),
          dtVigenciaFim: dataISO(projeto.dtVigenciaFim),
          cotaAutorizada: projeto.cotaAutorizada,
          situacao: SITUACAO_DO_PROJETO[projeto.situacao as keyof typeof SITUACAO_DO_PROJETO],
        },
        depois: { ...dados },
      },
    })
  })

  return { id }
}

export async function criarLinhagem(
  dados: { idEspecie: number; nome: string; cruzamento?: Cruzamento | null | undefined },
  gestor: UsuarioDaSessao,
) {
  const especie = await prisma.especie.findUnique({ where: { id: dados.idEspecie } })

  if (especie === null) {
    throw naoEncontrado('Espécie')
  }

  const mesmoNome = await prisma.linhagem.findFirst({
    where: { idEspecie: dados.idEspecie, nome: { equals: dados.nome, mode: 'insensitive' } },
  })

  if (mesmoNome !== null) {
    throw erroDeRegra('LINHAGEM_DUPLICADA', `Já existe a linhagem ${dados.nome} de ${especie.nome}.`)
  }

  const criada = await prisma.$transaction(async (tx) => {
    const linhagem = await tx.linhagem.create({
      data: { idEspecie: dados.idEspecie, nome: dados.nome, cruzamento: dados.cruzamento ?? null },
    })

    await registrarHistorico(tx, {
      idUsuario: gestor.id,
      entidade: 'linhagem',
      idEntidade: linhagem.id,
      acao: 'cadastro',
      descricao: `Linhagem ${dados.nome} cadastrada em ${especie.nome}`,
      dados: { ...dados },
    })

    return linhagem
  })

  return { id: criada.id, nome: criada.nome, ativa: criada.ativa, cruzamento: criada.cruzamento }
}

export async function alterarLinhagem(
  id: number,
  dados: {
    nome?: string | undefined
    ativa?: boolean | undefined
    cruzamento?: Cruzamento | null | undefined
  },
  gestor: UsuarioDaSessao,
) {
  const linhagem = await prisma.linhagem.findUnique({ where: { id } })

  if (linhagem === null) {
    throw naoEncontrado('Linhagem')
  }

  if (dados.nome !== undefined) {
    const mesmoNome = await prisma.linhagem.findFirst({
      where: {
        idEspecie: linhagem.idEspecie,
        nome: { equals: dados.nome, mode: 'insensitive' },
        id: { not: id },
      },
    })

    if (mesmoNome !== null) {
      throw erroDeRegra('LINHAGEM_DUPLICADA', `Já existe a linhagem ${dados.nome}.`)
    }
  }

  const salva = await prisma.$transaction(async (tx) => {
    const atualizada = await tx.linhagem.update({
      where: { id },
      data: {
        ...(dados.nome === undefined ? {} : { nome: dados.nome }),
        ...(dados.ativa === undefined ? {} : { ativa: dados.ativa }),
        ...(dados.cruzamento === undefined ? {} : { cruzamento: dados.cruzamento }),
      },
    })

    await registrarHistorico(tx, {
      idUsuario: gestor.id,
      entidade: 'linhagem',
      idEntidade: id,
      acao: 'alteracao',
      descricao: `Linhagem ${atualizada.nome} ${atualizada.ativa ? 'ativa' : 'inativa'}, cruzamento ${NOME_DO_CRUZAMENTO[atualizada.cruzamento ?? ''] ?? 'sem regra'}`,
      dados: {
        antes: { nome: linhagem.nome, ativa: linhagem.ativa, cruzamento: linhagem.cruzamento },
        depois: {
          nome: atualizada.nome,
          ativa: atualizada.ativa,
          cruzamento: atualizada.cruzamento,
        },
      },
    })

    return atualizada
  })

  return { id: salva.id, nome: salva.nome, ativa: salva.ativa, cruzamento: salva.cruzamento }
}
