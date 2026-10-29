// Casais e o registro dos partos: nascimento, eutanasia de selecao e desmame

import { codigoDaPosicao } from '../infra/endereco.ts'
import {
  calcularDisponibilidade,
  expectativaNaData,
  parametroNaData,
} from './disponibilidade.ts'
import type { ParametroVigente } from './disponibilidade.ts'
import { calcularCicloInicial, calcularProximoCiclo } from './cadeiaTemporal.ts'
import { ErroDeAplicacao, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, paraData } from '../../shared/traducao.ts'

export type ParametroCompleto = ParametroVigente & {
  gestacaoDias: number
  aleitamentoDias: number
  intervaloCicloDias: number
  maxPartoCasal: number
}

/**
 * Todas as versoes do parametro de uma especie - o historico inteiro, nao so o
 * vigente hoje.
 */
export async function parametrosDaEspecie(idEspecie: number): Promise<ParametroCompleto[]> {
  const parametros = await prisma.parametroBiologico.findMany({ where: { idEspecie } })

  // parametroNaData compara vigencia como string ISO; o Prisma devolve
  // '@db.Date' como Date, entao a traducao entra aqui, uma vez so e nao em cada chamador
  return parametros.map((parametro) => ({
    ...parametro,
    dtVigenciaInicio: dataISO(parametro.dtVigenciaInicio),
    dtVigenciaFim: parametro.dtVigenciaFim === null ? null : dataISO(parametro.dtVigenciaFim),
  }))
}

/**
 * Valida o par genetico ANTES do insert, para dar a mensagem rica
 * ("com macho do grupo A, so e valido o grupo B").
 */
async function validarParGenetico(grupoMacho: string, grupoFemea: string): Promise<void> {
  const par = await prisma.grupoGeneticoPar.findFirst({
    where: { grupoMacho, grupoFemea, ativo: true },
  })

  if (par !== null) {
    return
  }

  const validos = await prisma.grupoGeneticoPar.findMany({
    where: { grupoMacho, ativo: true },
    select: { grupoFemea: true },
  })

  const femeas = validos.map((v) => v.grupoFemea).join(', ')

  throw erroDeRegra(
    'PAR_GENETICO_INVALIDO',
    `O par ${grupoMacho}${grupoFemea} nao esta na rotacao permitida.`,
    {
      campos: {
        grupoFemea:
          femeas.length > 0
            ? `Com macho do grupo ${grupoMacho}, so e valido o grupo ${femeas}.`
            : `O grupo ${grupoMacho} nao tem par valido cadastrado.`,
      },
    },
  )
}

/**
 * O objeto casal da ficha, reaproveitado pelo cadastro, pelo
 * encerramento e pela ficha da posicao (infra/ficha.service.ts).
 */
export async function casalFicha(idCasal: number) {
  const casal = await prisma.casal.findUnique({
    where: { id: idCasal },
    include: { linhagem: { select: { nome: true } } },
  })

  if (casal === null) {
    throw naoEncontrado('Casal')
  }

  return {
    id: casal.id,
    identificacao: casal.identificacao.trim(),
    grupoMacho: casal.grupoMacho,
    grupoFemea: casal.grupoFemea,
    linhagem: casal.linhagem.nome,
    dtFormacao: dataISO(casal.dtFormacao),
    ativo: casal.ativo,
    dtEncerramento: casal.dtEncerramento === null ? null : dataISO(casal.dtEncerramento),
  }
}

/**
 * O objeto ciclo da ficha, com a disponibilidade liquida.
 * Reaproveitado pelos tres eventos e pela ficha da posicao
 */
export async function cicloFicha(idParto: number) {
  const parto = await prisma.parto.findUnique({
    where: { id: idParto },
    include: {
      casal: { select: { idLinhagem: true, linhagem: { select: { idEspecie: true } } } },
      // So os ativos entram na soma - o cancelado fica na tabela, mas
      // ele nao pesa mais no comprometido (mesma regra do trigger do banco)
      compromissos: { where: { dtCancelamento: null }, select: { qtdM: true, qtdF: true } },
    },
  })

  if (parto === null) {
    throw naoEncontrado('Parto')
  }

  const parametros = await parametrosDaEspecie(parto.casal.linhagem.idEspecie)
  const expectativa = expectativaNaData(parametros, {
    idLinhagem: parto.casal.idLinhagem,
    em: dataISO(parto.dtAcasalamento),
  })

  const comprometido = parto.compromissos.reduce(
    (soma, c) => ({ m: soma.m + c.qtdM, f: soma.f + c.qtdF }),
    { m: 0, f: 0 },
  )

  const disponibilidade = calcularDisponibilidade(
    {
      nascidoM: parto.nascidoM,
      nascidoF: parto.nascidoF,
      eutanasiadoM: parto.eutanasiadoM,
      eutanasiadoF: parto.eutanasiadoF,
      desmamadoM: parto.desmamadoM,
      desmamadoF: parto.desmamadoF,
    },
    { expectativa, comprometido },
  )

  return {
    id: parto.id,
    ordem: parto.ordem,
    dtAcasalamento: dataISO(parto.dtAcasalamento),
    dtPartoPrevisto: dataISO(parto.dtPartoPrevisto),
    dtPartoReal: parto.dtPartoReal === null ? null : dataISO(parto.dtPartoReal),
    nascidoM: parto.nascidoM,
    nascidoF: parto.nascidoF,
    dtSelecao: parto.dtSelecao === null ? null : dataISO(parto.dtSelecao),
    eutanasiadoM: parto.eutanasiadoM,
    eutanasiadoF: parto.eutanasiadoF,
    dtDesmamePrevisto: dataISO(parto.dtDesmamePrevisto),
    dtDesmameReal: parto.dtDesmameReal === null ? null : dataISO(parto.dtDesmameReal),
    desmamadoM: parto.desmamadoM,
    desmamadoF: parto.desmamadoF,
    disponivel: disponibilidade.disponivel,
    comprometido: disponibilidade.comprometido,
  }
}

export type PosicaoVazia = {
  idEstante: number
  face: 'frontal' | 'traseira'
  linha: number
  coluna: number
}

export type NovoCasal = {
  idCaixa?: number | undefined
  posicao?: PosicaoVazia | undefined
  idLinhagem: number
  grupoMacho: string
  grupoFemea: string
  dtFormacao: string
}

/** A estante e a caixa que ocupa a posicao (null se vazia). Recusa posicao fora da estante */
async function caixaNaPosicao(posicao: PosicaoVazia) {
  const estante = await prisma.estante.findUnique({ where: { id: posicao.idEstante } })

  if (estante === null) {
    throw naoEncontrado('Estante')
  }

  const face = posicao.face === 'frontal' ? 1 : 2

  if (face > estante.faces || posicao.linha > estante.linhas || posicao.coluna > estante.colunas) {
    throw new ErroDeAplicacao(400, 'VALIDACAO', 'Esta posicao nao existe na estante.')
  }

  const caixa = await prisma.caixa.findFirst({
    where: { idEstante: estante.id, face, linha: posicao.linha, coluna: posicao.coluna, ativa: true },
  })

  return { estante, face, caixa }
}

/**
 * POST /api/casais - forma o casal e ja cria o 1o parto, com as datas previstas. Numa posicao
 * vazia a caixa nasce na mesma transacao, com a especie da linhagem escolhida
 */
export async function formarCasal(dados: NovoCasal) {
  const linhagem = await prisma.linhagem.findUnique({ where: { id: dados.idLinhagem } })

  if (linhagem === null) {
    throw naoEncontrado('Linhagem')
  }

  const naPosicao = dados.posicao === undefined ? null : await caixaNaPosicao(dados.posicao)
  const caixaExistente =
    dados.idCaixa === undefined
      ? (naPosicao?.caixa ?? null)
      : await prisma.caixa.findUnique({ where: { id: dados.idCaixa } })

  if (dados.idCaixa !== undefined && caixaExistente === null) {
    throw naoEncontrado('Caixa')
  }

  if (caixaExistente !== null && linhagem.idEspecie !== caixaExistente.idEspecie) {
    throw new ErroDeAplicacao(400, 'VALIDACAO', 'Confira os campos destacados.', {
      campos: { idLinhagem: 'Esta linhagem nao pertence a especie da caixa.' },
    })
  }

  await validarParGenetico(dados.grupoMacho, dados.grupoFemea)

  const parametros = await parametrosDaEspecie(linhagem.idEspecie)
  const parametro = parametroNaData(parametros, {
    idLinhagem: linhagem.id,
    em: dados.dtFormacao,
  })

  if (parametro === undefined) {
    throw new Error(
      `Sem parametro_biologico vigente em ${dados.dtFormacao} para a especie ${linhagem.idEspecie}.`,
    )
  }

  const parto1 = calcularCicloInicial(dados.dtFormacao, parametro)

  // um casal ativo por caixa fica por conta do indice parcial do banco. Se disparar,
  // 'erros-do-banco.ts' traduz
  const casal = await prisma.$transaction(async (tx) => {
    let idCaixa = caixaExistente?.id

    if (idCaixa === undefined && naPosicao !== null && dados.posicao !== undefined) {
      const criada = await tx.caixa.create({
        data: {
          idEstante: naPosicao.estante.id,
          face: naPosicao.face,
          linha: dados.posicao.linha,
          coluna: dados.posicao.coluna,
          codigo: codigoDaPosicao(
            naPosicao.face,
            dados.posicao.linha,
            dados.posicao.coluna,
            naPosicao.estante.colunas,
          ),
          idEspecie: linhagem.idEspecie,
        },
      })
      idCaixa = criada.id
    }

    if (idCaixa === undefined) {
      throw naoEncontrado('Caixa')
    }

    const criado = await tx.casal.create({
      data: {
        idCaixa,
        idLinhagem: dados.idLinhagem,
        grupoMacho: dados.grupoMacho,
        grupoFemea: dados.grupoFemea,
        identificacao: `${dados.grupoMacho}${dados.grupoFemea}`,
        dtFormacao: paraData(dados.dtFormacao),
      },
    })

    await tx.parto.create({
      data: {
        idCasal: criado.id,
        ordem: 1,
        dtAcasalamento: paraData(parto1.dtAcasalamento),
        dtPartoPrevisto: paraData(parto1.dtPartoPrevisto),
        dtDesmamePrevisto: paraData(parto1.dtDesmamePrevisto),
        grauCerteza: 'J',
      },
    })

    return criado
  })

  return { idCaixa: casal.idCaixa, casal: await casalFicha(casal.id) }
}

export type Nascimento = {
  dtPartoReal: string
  nascidoM: number
  nascidoF: number
}

/** POST /api/partos/:id/nascimento */
export async function registrarNascimento(idParto: number, dados: Nascimento, idUsuario: number) {
  const parto = await prisma.parto.findUnique({
    where: { id: idParto },
    include: { casal: { select: { id: true, idLinhagem: true, linhagem: true } } },
  })

  if (parto === null) {
    throw naoEncontrado('Parto')
  }

  if (parto.dtPartoReal !== null) {
    throw erroDeRegra(
      'SEQUENCIA_INVALIDA',
      'Este parto ja tem data real registrada. Correcao de registro ainda nao esta disponivel.',
    )
  }

  const parametros = await parametrosDaEspecie(parto.casal.linhagem.idEspecie)
  const parametro = parametroNaData(parametros, {
    idLinhagem: parto.casal.idLinhagem,
    em: dados.dtPartoReal,
  })

  if (parametro === undefined) {
    throw new Error(`Sem parametro_biologico vigente em ${dados.dtPartoReal}.`)
  }

  await prisma.$transaction(async (tx) => {
    await tx.parto.update({
      where: { id: idParto },
      data: {
        dtPartoReal: paraData(dados.dtPartoReal),
        nascidoM: dados.nascidoM,
        nascidoF: dados.nascidoF,
        // a oferta passa de projetada para prevista
        grauCerteza: 'P',
        idUsuarioParto: idUsuario,
        dtRegistroParto: new Date(),
      },
    })

    if (parto.ordem >= parametro.maxPartoCasal) {
      // No ultimo parto confirmado o casal encerra sozinho.
      await tx.casal.update({
        where: { id: parto.idCasal },
        data: {
          ativo: false,
          dtEncerramento: paraData(dados.dtPartoReal),
          motivoEncerramento: `Limite de ${parametro.maxPartoCasal} partos atingido`,
        },
      })
      return
    }

    const proximo = calcularProximoCiclo(dados.dtPartoReal, parametro)

    // CHECK parto_ordem_ciclo (1..5) e a rede de seguranca desta linha: se
    // 'parametro.maxPartoCasal' algum dia divergir de 5 no banco, o Postgres recusa antes
    // de gravar ordem invalida.
    await tx.parto.create({
      data: {
        idCasal: parto.idCasal,
        ordem: parto.ordem + 1,
        dtAcasalamento: paraData(proximo.dtAcasalamento),
        dtPartoPrevisto: paraData(proximo.dtPartoPrevisto),
        dtDesmamePrevisto: paraData(proximo.dtDesmamePrevisto),
        grauCerteza: 'J',
      },
    })
  })

  return cicloFicha(idParto)
}

export type Selecao = {
  dtSelecao: string
  eutanasiadoM: number
  eutanasiadoF: number
}

/** POST /api/partos/:id/selecao */
export async function registrarSelecao(idParto: number, dados: Selecao, idUsuario: number) {
  const parto = await prisma.parto.findUnique({ where: { id: idParto } })

  if (parto === null) {
    throw naoEncontrado('Parto')
  }

  if (parto.dtPartoReal === null || parto.nascidoM === null || parto.nascidoF === null) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'Registre o parto antes da selecao.')
  }

  if (dados.eutanasiadoM > parto.nascidoM || dados.eutanasiadoF > parto.nascidoF) {
    throw new ErroDeAplicacao(400, 'VALIDACAO', 'Confira os campos destacados.', {
      campos: {
        eutanasiado: `Nao pode passar do nascido (${parto.nascidoM} M, ${parto.nascidoF} F).`,
      },
    })
  }

  await prisma.parto.update({
    where: { id: idParto },
    data: {
      dtSelecao: paraData(dados.dtSelecao),
      eutanasiadoM: dados.eutanasiadoM,
      eutanasiadoF: dados.eutanasiadoF,
      idUsuarioSelecao: idUsuario,
      dtRegistroSelecao: new Date(),
    },
  })

  return cicloFicha(idParto)
}

export type Desmame = {
  dtDesmameReal: string
  desmamadoM: number
  desmamadoF: number
  idCaixaRecria: number | null
}

/** POST /api/partos/:id/desmame. A partir daqui o estoque e confirmado */
export async function registrarDesmame(idParto: number, dados: Desmame, idUsuario: number) {
  const parto = await prisma.parto.findUnique({ where: { id: idParto } })

  if (parto === null) {
    throw naoEncontrado('Parto')
  }

  if (parto.dtPartoReal === null) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'Registre o parto antes do desmame.')
  }

  if (dados.idCaixaRecria !== null) {
    const caixaRecria = await prisma.caixa.findUnique({ where: { id: dados.idCaixaRecria } })

    if (caixaRecria === null) {
      throw naoEncontrado('Caixa de recria')
    }
  }

  await prisma.parto.update({
    where: { id: idParto },
    data: {
      dtDesmameReal: paraData(dados.dtDesmameReal),
      desmamadoM: dados.desmamadoM,
      desmamadoF: dados.desmamadoF,
      idCaixaRecria: dados.idCaixaRecria,
      grauCerteza: 'C',
      idUsuarioDesmame: idUsuario,
      dtRegistroDesmame: new Date(),
    },
  })

  return cicloFicha(idParto)
}

export type Encerramento = {
  dtEncerramento: string
  motivo: string
}

/** POST /api/casais/:id/encerramento - nada e apagado, so encerra */
export async function encerrarCasal(idCasal: number, dados: Encerramento) {
  const casal = await prisma.casal.findUnique({ where: { id: idCasal } })

  if (casal === null) {
    throw naoEncontrado('Casal')
  }

  if (!casal.ativo) {
    throw new ErroDeAplicacao(400, 'VALIDACAO', 'Confira os campos destacados.', {
      campos: { idCasal: 'Este casal ja esta encerrado.' },
    })
  }

  await prisma.casal.update({
    where: { id: idCasal },
    data: {
      ativo: false,
      dtEncerramento: paraData(dados.dtEncerramento),
      motivoEncerramento: dados.motivo,
    },
  })

  return casalFicha(idCasal)
}
