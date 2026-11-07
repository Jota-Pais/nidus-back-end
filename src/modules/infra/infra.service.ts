// Estantes: lista, grade das duas faces, cadastro, edicao e remocao

import { ErroDeAplicacao, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { codigoDaEspecie, estadoCaixa, face as faceDic } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { casalNoCard, selecaoDoCasalNoCard } from './casalNoCard.ts'
import { codigoDaPosicao } from './endereco.ts'

type LinhaDeEstante = {
  id: number
  idSala: number
  sala: { nome: string }
  fabricante: string
  modelo: string
  numeroVisivel: string
  faces: number
  linhas: number
  colunas: number
}

/** O nome da sala vem junto: a grade separa as estantes por ele */
const comASala = { sala: { select: { nome: true } } } as const

function paraApi(estante: LinhaDeEstante) {
  return {
    id: estante.id,
    idSala: estante.idSala,
    sala: estante.sala.nome,
    fabricante: estante.fabricante,
    modelo: estante.modelo,
    numeroVisivel: estante.numeroVisivel,
    faces: estante.faces,
    linhas: estante.linhas,
    colunas: estante.colunas,
  }
}

/** Resolve '?especie=rato' no id da especie */
export async function idDaEspecie(codigo: string): Promise<number> {
  const especies = await prisma.especie.findMany({ select: { id: true, nome: true } })
  const achada = especies.find((especie) => codigoDaEspecie(especie.nome) === codigo)

  if (achada === undefined) {
    throw naoEncontrado(`Especie ${codigo}`)
  }

  return achada.id
}

/** GET /api/estantes - todas as estantes ativas, por sala */
export async function listarEstantes() {
  const estantes = await prisma.estante.findMany({
    where: { ativa: true },
    include: comASala,
    orderBy: [{ sala: { nome: 'asc' } }, { numeroVisivel: 'asc' }],
  })

  return { estantes: estantes.map(paraApi) }
}

/** GET /api/estantes/:id/grade - as duas faces, com posicao vazia como 'caixa: null' */
export async function montarGrade(id: number) {
  const [estante, caixas] = await Promise.all([
    prisma.estante.findFirst({ where: { id, ativa: true } }),
    prisma.caixa.findMany({
      where: { idEstante: id, ativa: true },
      select: {
        id: true,
        face: true,
        linha: true,
        coluna: true,
        estado: true,
        casais: selecaoDoCasalNoCard,
      },
    }),
  ])

  if (estante === null) {
    throw naoEncontrado('Estante')
  }

  const caixaPorEndereco = new Map(
    caixas.map((caixa) => [`${caixa.face}:${caixa.linha}:${caixa.coluna}`, caixa]),
  )

  const faces = Array.from({ length: estante.faces }, (_, indice) => {
    const numeroDaFace = indice + 1
    const posicoes = []

    for (let linha = 1; linha <= estante.linhas; linha += 1) {
      for (let coluna = 1; coluna <= estante.colunas; coluna += 1) {
        const caixa = caixaPorEndereco.get(`${numeroDaFace}:${linha}:${coluna}`)
        const casal = caixa?.casais[0]

        posicoes.push({
          linha,
          coluna,
          codigo: codigoDaPosicao(numeroDaFace, linha, coluna, estante.colunas),
          caixa:
            caixa === undefined
              ? null
              : {
                  id: caixa.id,
                  estado: estadoCaixa.paraApi(caixa.estado),
                  linhagem: casal?.linhagem.nome ?? null,
                  casal: casalNoCard(caixa.casais, caixa.estado),
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
  fabricante: string
  modelo: string
  numeroVisivel: string
  faces: number
  linhas: number
  colunas: number
}

/** O que a edicao muda. O modelo e a topologia ficam: para trocar, remove e cadastra de novo */
export type AlteracaoDeEstante = {
  numeroVisivel?: string | undefined
  idSala?: number | undefined
}

/** capacidade e derivada da topologia e nunca vem do cliente - o CHECK do banco cobra o mesmo */
export function capacidadeDerivada(faces: number, linhas: number, colunas: number): number {
  return faces * linhas * colunas
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
    throw erroDeRegra('ESTANTE_DUPLICADA', `Ja existe a estante ${numeroVisivel} na sala ${sala.nome}.`)
  }
}

async function estanteAtiva(id: number) {
  const estante = await prisma.estante.findFirst({ where: { id, ativa: true }, include: comASala })

  if (estante === null) {
    throw naoEncontrado('Estante')
  }

  return estante
}

/** POST /api/estantes */
export async function cadastrarEstante(dados: NovaEstante, idUsuario: number) {
  const sala = await salaDoCorpo(dados.idSala)

  await conferirNumeroLivre(sala, dados.numeroVisivel)

  const criada = await prisma.$transaction(async (tx) => {
    const estante = await tx.estante.create({
      data: {
        ...dados,
        capacidade: capacidadeDerivada(dados.faces, dados.linhas, dados.colunas),
      },
      include: comASala,
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'estante',
      idEntidade: estante.id,
      acao: 'cadastro',
      descricao: `Estante ${dados.numeroVisivel} cadastrada na ${sala.nome}`,
      dados: { ...dados, sala: sala.nome },
    })

    return estante
  })

  return paraApi(criada)
}

/** PATCH /api/estantes/:id - o numero da etiqueta e a sala */
export async function alterarEstante(id: number, dados: AlteracaoDeEstante, idUsuario: number) {
  const estante = await estanteAtiva(id)

  const sala =
    dados.idSala === undefined || dados.idSala === estante.idSala
      ? { id: estante.idSala, nome: estante.sala.nome }
      : await salaDoCorpo(dados.idSala)
  const numeroVisivel = dados.numeroVisivel ?? estante.numeroVisivel

  await conferirNumeroLivre(sala, numeroVisivel, id)

  const salva = await prisma.$transaction(async (tx) => {
    const atualizada = await tx.estante.update({
      where: { id },
      data: { numeroVisivel, idSala: sala.id, dtManutencao: new Date() },
      include: comASala,
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'estante',
      idEntidade: id,
      acao: 'alteracao',
      descricao: `Estante ${numeroVisivel} alterada na ${sala.nome}`,
      dados: {
        antes: { numeroVisivel: estante.numeroVisivel, idSala: estante.idSala, sala: estante.sala.nome },
        depois: { numeroVisivel, idSala: sala.id, sala: sala.nome },
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
      `A estante ${estante.numeroVisivel} ainda tem ${caixas} ${caixas === 1 ? 'caixa' : 'caixas'}. So da para remover a estante vazia: mude as caixas para outra estante antes.`,
    )
  }

  await prisma.$transaction(async (tx) => {
    await tx.estante.update({ where: { id }, data: { ativa: false, dtManutencao: new Date() } })

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
