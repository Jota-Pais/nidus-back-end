// Estantes: lista, grade das duas faces, cadastro, edicao e remocao. As medidas sao as do formato
// da estante (formato.service.ts), e a estante troca de formato

import type { Prisma } from '@prisma/client'
import { agora } from '../../shared/relogio.ts'
import { ErroDeAplicacao, campoInvalido, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { codigoDaEspecie, face as faceDic, listaLegivel } from '../../shared/traducao.ts'
import { travarCaixasDaEstante } from '../colonia/travas.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { lerCards } from './card.ts'
import { codigoDaPosicao } from './endereco.ts'
import { foraDasMedidas } from './formato.service.ts'
import type { Medidas } from './formato.service.ts'

type Leitura = Pick<Prisma.TransactionClient, 'caixa'>

/** As medidas que a estante tem: as do formato dela */
const medidasDoFormato = { select: { faces: true, linhas: true, colunas: true } } as const

/** O nome da sala e o formato vem junto: a grade separa as estantes pela sala, e as medidas sao do formato */
const comSalaEFormato = {
  sala: { select: { nome: true } },
  formato: { select: { nome: true, faces: true, linhas: true, colunas: true } },
} as const

type LinhaDeEstante = {
  id: number
  idSala: number
  idFormato: number
  numeroVisivel: string
  sala: { nome: string }
  formato: { nome: string } & Medidas
}

function paraApi(estante: LinhaDeEstante) {
  return {
    id: estante.id,
    idSala: estante.idSala,
    sala: estante.sala.nome,
    idFormato: estante.idFormato,
    formato: estante.formato.nome,
    numeroVisivel: estante.numeroVisivel,
    faces: estante.formato.faces,
    linhas: estante.formato.linhas,
    colunas: estante.formato.colunas,
  }
}

/** Resolve '?especie=rato' no id da especie */
export async function idDaEspecie(codigo: string): Promise<number> {
  const especies = await prisma.especie.findMany({ select: { id: true, nome: true } })
  const achada = especies.find((especie) => codigoDaEspecie(especie.nome) === codigo)

  if (achada === undefined) {
    throw naoEncontrado(`Espécie ${codigo}`)
  }

  return achada.id
}

/** GET /api/estantes - todas as estantes ativas, por sala */
export async function listarEstantes() {
  const estantes = await prisma.estante.findMany({
    where: { ativa: true },
    include: comSalaEFormato,
    orderBy: [{ sala: { nome: 'asc' } }, { numeroVisivel: 'asc' }],
  })

  return { estantes: estantes.map(paraApi) }
}

/**
 * GET /api/estantes/:id/grade - as duas faces, com posicao vazia como 'caixa: null'. Cada caixa
 * vem com a coluna (a cor), a linhagem (o id, para a grade filtrar por ela, e o nome) e o card: o
 * casal, ou o sexo e os vivos da caixa de estoque (a MiniGrade filtra os destinos da mudanca pelo
 * sexo e pela linhagem). As posicoes sao as das medidas do formato
 */
export async function montarGrade(id: number) {
  const estante = await prisma.estante.findFirst({
    where: { id, ativa: true },
    select: { formato: medidasDoFormato },
  })

  if (estante === null) {
    throw naoEncontrado('Estante')
  }

  const { faces: totalDeFaces, linhas, colunas } = estante.formato
  const caixas = await lerCards(prisma, { idEstante: id, ativa: true })
  const caixaPorEndereco = new Map(caixas.map((caixa) => [`${caixa.face}:${caixa.linha}:${caixa.coluna}`, caixa]))

  const faces = Array.from({ length: totalDeFaces }, (_, indice) => {
    const numeroDaFace = indice + 1
    const posicoes = []

    for (let linha = 1; linha <= linhas; linha += 1) {
      for (let coluna = 1; coluna <= colunas; coluna += 1) {
        const caixa = caixaPorEndereco.get(`${numeroDaFace}:${linha}:${coluna}`)

        posicoes.push({
          linha,
          coluna,
          codigo: codigoDaPosicao(numeroDaFace, linha, coluna, colunas),
          caixa:
            caixa === undefined
              ? null
              : {
                  id: caixa.id,
                  fase: caixa.fase,
                  atrasado: caixa.atrasado,
                  idLinhagem: caixa.idLinhagem,
                  linhagem: caixa.linhagem,
                  casal: caixa.casal,
                  estoque: caixa.estoque,
                },
        })
      }
    }

    return { face: faceDic.paraApi(String(numeroDaFace)), posicoes }
  })

  return { faces }
}

export type NovaEstante = {
  idSala: number
  idFormato: number
  numeroVisivel: string
}

/** O que a edicao muda, ao menos um. Trocar o formato muda as medidas e o codigo das caixas */
export type AlteracaoDeEstante = {
  numeroVisivel?: string | undefined
  idSala?: number | undefined
  idFormato?: number | undefined
}

/** A sala escolhida no formulario. Removida ou inexistente e campo invalido, como o responsavel do projeto */
async function salaDoCorpo(idSala: number) {
  const sala = await prisma.sala.findFirst({ where: { id: idSala, ativa: true } })

  if (sala === null) {
    throw new ErroDeAplicacao(400, 'VALIDACAO', 'Confira os campos destacados.', {
      campos: { idSala: 'Escolha uma sala cadastrada.' },
    })
  }

  return sala
}

/** O formato escolhido no formulario. Removido ou inexistente e campo invalido, como a sala */
async function formatoDoCorpo(idFormato: number) {
  const formato = await prisma.formato.findFirst({ where: { id: idFormato, ativo: true } })

  if (formato === null) {
    throw campoInvalido('idFormato', 'Escolha um formato cadastrado.')
  }

  return formato
}

/** O numero da etiqueta e unico na sala, entre as estantes ativas */
async function conferirNumeroLivre(
  sala: { id: number; nome: string },
  numeroVisivel: string,
  idEstante?: number,
) {
  const mesmoNumero = await prisma.estante.findFirst({
    where: {
      idSala: sala.id,
      numeroVisivel,
      ativa: true,
      ...(idEstante === undefined ? {} : { id: { not: idEstante } }),
    },
  })

  if (mesmoNumero !== null) {
    throw erroDeRegra('ESTANTE_DUPLICADA', `Já existe a estante ${numeroVisivel} na sala ${sala.nome}.`)
  }
}

/**
 * As caixas ativas da estante que ficariam fora do formato novo. O banco recusaria do mesmo jeito
 * (TOPOLOGIA, no trigger da caixa); aqui a recusa diz quais sao. Le depois de travar as caixas
 * (travarCaixasDaEstante)
 */
async function conferirCaixasNoFormato(tx: Leitura, idEstante: number, formato: { nome: string } & Medidas) {
  const fora = await tx.caixa.findMany({
    where: { idEstante, ativa: true, ...foraDasMedidas(formato) },
    orderBy: [{ face: 'asc' }, { linha: 'asc' }, { coluna: 'asc' }],
    select: { codigo: true },
  })

  if (fora.length === 0) return

  const quais = listaLegivel(fora.map((caixa) => caixa.codigo))

  throw erroDeRegra(
    'CAIXAS_FORA_DO_FORMATO',
    fora.length === 1
      ? `A caixa ${quais} fica fora do formato ${formato.nome}. Mude-a de lugar antes de trocar o formato.`
      : `As caixas ${quais} ficam fora do formato ${formato.nome}. Mude-as de lugar antes de trocar o formato.`,
  )
}

async function estanteAtiva(id: number) {
  const estante = await prisma.estante.findFirst({ where: { id, ativa: true }, include: comSalaEFormato })

  if (estante === null) {
    throw naoEncontrado('Estante')
  }

  return estante
}

/** POST /api/estantes */
export async function cadastrarEstante(dados: NovaEstante, idUsuario: number) {
  const sala = await salaDoCorpo(dados.idSala)
  const formato = await formatoDoCorpo(dados.idFormato)

  await conferirNumeroLivre(sala, dados.numeroVisivel)

  const criada = await prisma.$transaction(async (tx) => {
    const estante = await tx.estante.create({ data: dados, include: comSalaEFormato })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'estante',
      idEntidade: estante.id,
      acao: 'cadastro',
      descricao: `Estante ${dados.numeroVisivel} cadastrada na ${sala.nome}`,
      dados: { ...dados, sala: sala.nome, formato: formato.nome },
    })

    return estante
  })

  return paraApi(criada)
}

/**
 * PATCH /api/estantes/:id - o numero da etiqueta, a sala e o formato. Trocar o formato reescreve o
 * codigo das caixas ativas (o banco faz, pelo trigger da estante); a caixa que ficaria fora e
 * recusada antes
 */
export async function alterarEstante(id: number, dados: AlteracaoDeEstante, idUsuario: number) {
  const estante = await estanteAtiva(id)

  const sala =
    dados.idSala === undefined || dados.idSala === estante.idSala
      ? { id: estante.idSala, nome: estante.sala.nome }
      : await salaDoCorpo(dados.idSala)
  const formato =
    dados.idFormato === undefined || dados.idFormato === estante.idFormato
      ? { id: estante.idFormato, ...estante.formato }
      : await formatoDoCorpo(dados.idFormato)
  const numeroVisivel = dados.numeroVisivel ?? estante.numeroVisivel

  await conferirNumeroLivre(sala, numeroVisivel, id)

  const trocaDeFormato = formato.id !== estante.idFormato

  const salva = await prisma.$transaction(async (tx) => {
    if (trocaDeFormato) {
      await travarCaixasDaEstante(tx, id)
      await conferirCaixasNoFormato(tx, id, formato)
    }

    const atualizada = await tx.estante.update({
      where: { id },
      data: { numeroVisivel, idSala: sala.id, idFormato: formato.id, dtManutencao: agora() },
      include: comSalaEFormato,
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'estante',
      idEntidade: id,
      acao: 'alteracao',
      descricao: `Estante ${numeroVisivel} alterada na ${sala.nome}`,
      dados: {
        antes: {
          numeroVisivel: estante.numeroVisivel,
          idSala: estante.idSala,
          sala: estante.sala.nome,
          idFormato: estante.idFormato,
          formato: estante.formato.nome,
        },
        depois: { numeroVisivel, idSala: sala.id, sala: sala.nome, idFormato: formato.id, formato: formato.nome },
      },
    })

    return atualizada
  })

  return paraApi(salva)
}

/**
 * DELETE /api/estantes/:id - so a estante vazia. Ocupada e a posicao com caixa ativa, a mesma
 * regra com que a grade mostra a posicao ocupada
 */
export async function removerEstante(id: number, idUsuario: number) {
  const estante = await estanteAtiva(id)
  const caixas = await prisma.caixa.count({ where: { idEstante: id, ativa: true } })

  if (caixas > 0) {
    throw erroDeRegra(
      'ESTANTE_OCUPADA',
      `A estante ${estante.numeroVisivel} ainda tem ${caixas} ${caixas === 1 ? 'caixa' : 'caixas'}. Só dá para remover a estante vazia: mude as caixas para outra estante antes.`,
    )
  }

  await prisma.$transaction(async (tx) => {
    await tx.estante.update({ where: { id }, data: { ativa: false, dtManutencao: agora() } })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'estante',
      idEntidade: id,
      acao: 'remocao',
      descricao: `Estante ${estante.numeroVisivel} removida da ${estante.sala.nome}`,
      dados: { numeroVisivel: estante.numeroVisivel, idSala: estante.idSala, sala: estante.sala.nome },
    })
  })
}
