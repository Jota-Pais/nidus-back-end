// Estantes: lista, grade das duas faces e cadastro

import { erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { codigoDaEspecie, estadoCaixa, face as faceDic } from '../../shared/traducao.ts'
import { casalNoCard, selecaoDoCasalNoCard } from './casalNoCard.ts'
import { codigoDaPosicao } from './endereco.ts'

type LinhaDeEstante = {
  id: number
  sala: string
  fabricante: string
  modelo: string
  numeroVisivel: string
  faces: number
  linhas: number
  colunas: number
}

function paraApi(estante: LinhaDeEstante) {
  return {
    id: estante.id,
    sala: estante.sala,
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
    orderBy: [{ sala: 'asc' }, { numeroVisivel: 'asc' }],
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
                  casal: casalNoCard(casal),
                },
        })
      }
    }

    return { face: faceDic.paraApi(String(numeroDaFace)), posicoes }
  })

  return { faces }
}

export type NovaEstante = {
  sala: string
  fabricante: string
  modelo: string
  numeroVisivel: string
  faces: number
  linhas: number
  colunas: number
}

/** capacidade e derivada da topologia e nunca vem do cliente - o CHECK do banco cobra o mesmo */
export function capacidadeDerivada(faces: number, linhas: number, colunas: number): number {
  return faces * linhas * colunas
}

/** POST /api/estantes */
export async function cadastrarEstante(dados: NovaEstante) {
  const mesmoNumero = await prisma.estante.findFirst({
    where: { sala: dados.sala, numeroVisivel: dados.numeroVisivel, ativa: true },
  })

  if (mesmoNumero !== null) {
    throw erroDeRegra(
      'ESTANTE_DUPLICADA',
      `Ja existe a estante ${dados.numeroVisivel} na sala ${dados.sala}.`,
    )
  }

  const criada = await prisma.estante.create({
    data: {
      ...dados,
      capacidade: capacidadeDerivada(dados.faces, dados.linhas, dados.colunas),
    },
  })

  return paraApi(criada)
}
