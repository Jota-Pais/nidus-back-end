// Formatos de estante: as medidas (faces, linhas e colunas) de um modelo de estante, e a estante
// aponta para o seu. Lista, cadastro, edicao e remocao. Mudar as medidas muda todas as estantes do
// formato: o banco reescreve o codigo das caixas ativas (a traseira continua as letras da frontal) e
// recusa a que ficaria fora, e a edicao recusa antes, dizendo quais. Remover e 'ativo = false', so
// sem estante ativa: a estante removida continua apontando para ele

import type { Prisma } from '@prisma/client'
import { agora } from '../../shared/relogio.ts'
import { campoInvalido, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { listaLegivel } from '../../shared/traducao.ts'
import { travarCaixasDoFormato } from '../colonia/travas.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { COLUNAS_SEM_LETRA, LETRAS_DISPONIVEIS, letrasNecessarias } from './endereco.ts'

/** As medidas de um formato: faces (1 ou 2), linhas e colunas */
export type Medidas = { faces: number; linhas: number; colunas: number }

export type NovoFormato = Medidas & { nome: string }

/** O que a edicao muda, ao menos um. O que nao vem fica como esta */
export type AlteracaoDeFormato = {
  nome?: string | undefined
  faces?: number | undefined
  linhas?: number | undefined
  colunas?: number | undefined
}

type Leitura = Pick<Prisma.TransactionClient, 'caixa'>

/** As estantes ativas que usam o formato, por sala e numero, com o nome da sala */
const comAsEstantes = {
  estantes: {
    where: { ativa: true },
    orderBy: [{ sala: { nome: 'asc' } }, { numeroVisivel: 'asc' }],
    select: { id: true, numeroVisivel: true, sala: { select: { nome: true } } },
  },
} satisfies Prisma.FormatoInclude

type FormatoLido = Prisma.FormatoGetPayload<{ include: typeof comAsEstantes }>

function paraApi(formato: FormatoLido) {
  return {
    id: formato.id,
    nome: formato.nome,
    faces: formato.faces,
    linhas: formato.linhas,
    colunas: formato.colunas,
    // sai das medidas, nunca e gravada
    capacidade: formato.faces * formato.linhas * formato.colunas,
    estantes: formato.estantes.map((estante) => ({
      id: estante.id,
      numeroVisivel: estante.numeroVisivel,
      sala: estante.sala.nome,
    })),
  }
}

/** As caixas que nao cabem nas medidas: face, linha ou coluna alem delas. Quem chama diz de onde */
export function foraDasMedidas(medidas: Medidas): Prisma.CaixaWhereInput {
  return {
    OR: [{ face: { gt: medidas.faces } }, { linha: { gt: medidas.linhas } }, { coluna: { gt: medidas.colunas } }],
  }
}

/** Faces x colunas cabe nas letras do endereco. A recusa vai no campo das colunas, como no Zod do cadastro */
function conferirLetras(medidas: Medidas): void {
  if (letrasNecessarias(medidas.faces, medidas.colunas) > LETRAS_DISPONIVEIS) {
    throw campoInvalido('colunas', COLUNAS_SEM_LETRA)
  }
}

/** GET /api/formatos - os formatos ativos, por nome, cada um com as estantes ativas que o usam */
export async function listarFormatos() {
  const formatos = await prisma.formato.findMany({
    where: { ativo: true },
    orderBy: { nome: 'asc' },
    include: comAsEstantes,
  })

  return { formatos: formatos.map(paraApi) }
}

async function formatoAtivo(id: number) {
  const formato = await prisma.formato.findFirst({ where: { id, ativo: true } })

  if (formato === null) {
    throw naoEncontrado('Formato')
  }

  return formato
}

/** O nome e unico entre os formatos ativos, sem diferenciar maiuscula, como o da sala */
async function conferirNomeLivre(nome: string, idFormato?: number) {
  const mesmoNome = await prisma.formato.findFirst({
    where: {
      ativo: true,
      nome: { equals: nome, mode: 'insensitive' },
      ...(idFormato === undefined ? {} : { id: { not: idFormato } }),
    },
  })

  if (mesmoNome !== null) {
    throw erroDeRegra('FORMATO_DUPLICADO', `Já existe um formato com o nome ${nome}.`)
  }
}

/**
 * As caixas ativas das estantes ativas do formato que ficariam fora das medidas novas, por estante.
 * O banco recusaria do mesmo jeito (TOPOLOGIA, no trigger da caixa); aqui a recusa diz quais sao.
 * Le depois de travar as caixas (travarCaixasDoFormato)
 */
async function conferirCaixasNasMedidas(tx: Leitura, idFormato: number, medidas: Medidas) {
  const fora = await tx.caixa.findMany({
    where: { ativa: true, estante: { idFormato, ativa: true }, ...foraDasMedidas(medidas) },
    orderBy: [
      { estante: { sala: { nome: 'asc' } } },
      { estante: { numeroVisivel: 'asc' } },
      { idEstante: 'asc' },
      { face: 'asc' },
      { linha: 'asc' },
      { coluna: 'asc' },
    ],
    select: { codigo: true, idEstante: true, estante: { select: { numeroVisivel: true, sala: { select: { nome: true } } } } },
  })

  if (fora.length === 0) return

  // 'E-01 (Sala 1): F8A e T8C', uma estante de cada vez, na ordem lida
  const porEstante = new Map<number, { estante: string; codigos: string[] }>()

  for (const caixa of fora) {
    const grupo = porEstante.get(caixa.idEstante) ?? {
      estante: `${caixa.estante.numeroVisivel} (${caixa.estante.sala.nome})`,
      codigos: [],
    }
    grupo.codigos.push(caixa.codigo)
    porEstante.set(caixa.idEstante, grupo)
  }

  const quais = [...porEstante.values()].map((grupo) => `${grupo.estante}: ${listaLegivel(grupo.codigos)}`).join('; ')

  throw erroDeRegra(
    'CAIXAS_FORA_DO_FORMATO',
    fora.length === 1
      ? `Esta caixa fica fora das medidas novas: ${quais}. Mude-a de lugar antes de mudar o formato.`
      : `Estas caixas ficam fora das medidas novas: ${quais}. Mude-as de lugar antes de mudar o formato.`,
  )
}

/** POST /api/formatos */
export async function cadastrarFormato(dados: NovoFormato, idUsuario: number) {
  await conferirNomeLivre(dados.nome)

  const criado = await prisma.$transaction(async (tx) => {
    const formato = await tx.formato.create({ data: dados, include: comAsEstantes })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'formato',
      idEntidade: formato.id,
      acao: 'cadastro',
      descricao: `Formato ${dados.nome} cadastrado`,
      dados: { ...dados },
    })

    return formato
  })

  return paraApi(criado)
}

/**
 * PATCH /api/formatos/:id - o nome e as medidas. O que nao vem fica como esta, e faces x colunas
 * confere a combinacao. Mudar as medidas reescreve o codigo das caixas ativas de todas as estantes do
 * formato (o banco faz, pelo trigger do formato); a caixa que ficaria fora e recusada antes
 */
export async function alterarFormato(id: number, dados: AlteracaoDeFormato, idUsuario: number) {
  const formato = await formatoAtivo(id)
  const nome = dados.nome ?? formato.nome
  const medidas: Medidas = {
    faces: dados.faces ?? formato.faces,
    linhas: dados.linhas ?? formato.linhas,
    colunas: dados.colunas ?? formato.colunas,
  }

  conferirLetras(medidas)

  if (dados.nome !== undefined) {
    await conferirNomeLivre(nome, id)
  }

  const mudaAsMedidas =
    medidas.faces !== formato.faces || medidas.linhas !== formato.linhas || medidas.colunas !== formato.colunas

  const salvo = await prisma.$transaction(async (tx) => {
    if (mudaAsMedidas) {
      await travarCaixasDoFormato(tx, id)
      await conferirCaixasNasMedidas(tx, id, medidas)
    }

    const atualizado = await tx.formato.update({
      where: { id },
      data: { nome, ...medidas, dtManutencao: agora() },
      include: comAsEstantes,
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'formato',
      idEntidade: id,
      acao: 'alteracao',
      descricao: `Formato ${nome} alterado`,
      dados: {
        antes: { nome: formato.nome, faces: formato.faces, linhas: formato.linhas, colunas: formato.colunas },
        depois: { nome, ...medidas },
      },
    })

    return atualizado
  })

  return paraApi(salvo)
}

/** DELETE /api/formatos/:id - so o formato sem estante ativa */
export async function removerFormato(id: number, idUsuario: number) {
  const formato = await formatoAtivo(id)
  const estantes = await prisma.estante.findMany({
    where: { idFormato: id, ativa: true },
    orderBy: [{ sala: { nome: 'asc' } }, { numeroVisivel: 'asc' }],
    select: { numeroVisivel: true, sala: { select: { nome: true } } },
  })

  if (estantes.length > 0) {
    const quais = listaLegivel(estantes.map((estante) => `${estante.numeroVisivel} (${estante.sala.nome})`))

    throw erroDeRegra(
      'FORMATO_EM_USO',
      estantes.length === 1
        ? `O formato ${formato.nome} é usado pela estante ${quais}. Troque o formato dela antes de remover.`
        : `O formato ${formato.nome} é usado pelas estantes ${quais}. Troque o formato delas antes de remover.`,
    )
  }

  await prisma.$transaction(async (tx) => {
    await tx.formato.update({ where: { id }, data: { ativo: false, dtManutencao: agora() } })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'formato',
      idEntidade: id,
      acao: 'remocao',
      descricao: `Formato ${formato.nome} removido`,
      dados: { nome: formato.nome, faces: formato.faces, linhas: formato.linhas, colunas: formato.colunas },
    })
  })
}
