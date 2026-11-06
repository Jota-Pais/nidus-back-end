// Casais e o registro dos partos: nascimento, eutanasia de selecao e desmame

import { registrarHistorico } from '../historico/historico.service.ts'
import { codigoDaPosicao } from '../infra/endereco.ts'
import { compromissosAtivos, disponibilidadeDoParto } from './disponibilidade.ts'
import {
  calcularCicloInicial,
  calcularDesmamePrevisto,
  calcularProximoCiclo,
} from './cadeiaTemporal.ts'
import { ErroDeAplicacao, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { MAX_PARTOS_POR_CASAL } from '../../shared/parametros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, hojeISO, paraData } from '../../shared/traducao.ts'

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
    include: { compromissos: compromissosAtivos },
  })

  if (parto === null) {
    throw naoEncontrado('Parto')
  }

  const disponibilidade = disponibilidadeDoParto(parto)
  const dtPartoPrevisto = dataISO(parto.dtPartoPrevisto)
  const dtPartoReal = parto.dtPartoReal === null ? null : dataISO(parto.dtPartoReal)

  return {
    id: parto.id,
    ordem: parto.ordem,
    dtAcasalamento: dataISO(parto.dtAcasalamento),
    dtPartoPrevisto,
    dtPartoReal,
    nascidoM: parto.nascidoM,
    nascidoF: parto.nascidoF,
    dtSelecao: parto.dtSelecao === null ? null : dataISO(parto.dtSelecao),
    eutanasiadoM: parto.eutanasiadoM,
    eutanasiadoF: parto.eutanasiadoF,
    // derivado, e nao a coluna: parto gravado antes de o desmame contar do real ainda guarda
    // o desmame contado do previsto
    dtDesmamePrevisto: calcularDesmamePrevisto(dtPartoPrevisto, dtPartoReal),
    dtDesmameReal: parto.dtDesmameReal === null ? null : dataISO(parto.dtDesmameReal),
    desmamadoM: parto.desmamadoM,
    desmamadoF: parto.desmamadoF,
    disponivel: disponibilidade.disponivel,
    comprometido: disponibilidade.comprometido,
  }
}

function campoInvalido(campo: string, mensagem: string) {
  return new ErroDeAplicacao(400, 'VALIDACAO', 'Confira os campos destacados.', {
    campos: { [campo]: mensagem },
  })
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
export async function formarCasal(dados: NovoCasal, idUsuario: number) {
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

  const parto1 = calcularCicloInicial(dados.dtFormacao)

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

    if (caixaExistente !== null && caixaExistente.estado !== 'R') {
      await tx.caixa.update({ where: { id: idCaixa }, data: { estado: 'R' } })
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
      },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'casal',
      idEntidade: criado.id,
      acao: 'formacao',
      descricao: `Casal ${criado.identificacao} formado em ${dados.dtFormacao} (${linhagem.nome})`,
      dados: { idCaixa, idLinhagem: dados.idLinhagem, dtFormacao: dados.dtFormacao },
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
export async function registrarNascimento(
  idParto: number,
  dados: Nascimento,
  idUsuario: number,
  agora: Date = new Date(),
) {
  const parto = await prisma.parto.findUnique({
    where: { id: idParto },
    include: { casal: { select: { ativo: true } } },
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

  if (!parto.casal.ativo) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'Este casal esta encerrado e nao recebe parto novo.')
  }

  const acasalamento = dataISO(parto.dtAcasalamento)

  if (dados.dtPartoReal < acasalamento) {
    throw campoInvalido('dtPartoReal', `O parto nao pode ser antes do acasalamento (${acasalamento}).`)
  }

  if (dados.dtPartoReal > hojeISO(agora)) {
    throw campoInvalido('dtPartoReal', 'O parto nao pode ser numa data futura.')
  }

  await prisma.$transaction(async (tx) => {
    await tx.parto.update({
      where: { id: idParto },
      data: {
        dtPartoReal: paraData(dados.dtPartoReal),
        dtDesmamePrevisto: paraData(
          calcularDesmamePrevisto(dataISO(parto.dtPartoPrevisto), dados.dtPartoReal),
        ),
        nascidoM: dados.nascidoM,
        nascidoF: dados.nascidoF,
        idUsuarioParto: idUsuario,
        dtRegistroParto: new Date(),
      },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: idParto,
      acao: 'nascimento',
      descricao: `${parto.ordem}o parto em ${dados.dtPartoReal}: ${dados.nascidoM} M e ${dados.nascidoF} F`,
      dados: { ...dados },
    })

    if (parto.ordem >= MAX_PARTOS_POR_CASAL) {
      // No ultimo parto confirmado o casal encerra sozinho.
      await tx.casal.update({
        where: { id: parto.idCasal },
        data: {
          ativo: false,
          dtEncerramento: paraData(dados.dtPartoReal),
          motivoEncerramento: `Limite de ${MAX_PARTOS_POR_CASAL} partos atingido`,
        },
      })
      return
    }

    const proximo = calcularProximoCiclo(dados.dtPartoReal)

    // CHECK parto_ordem_ciclo (1..5) e a rede de seguranca desta linha: se
    // MAX_PARTOS_POR_CASAL mudar sem uma migration junto, o Postgres recusa antes
    // de gravar ordem invalida.
    await tx.parto.create({
      data: {
        idCasal: parto.idCasal,
        ordem: parto.ordem + 1,
        dtAcasalamento: paraData(proximo.dtAcasalamento),
        dtPartoPrevisto: paraData(proximo.dtPartoPrevisto),
        dtDesmamePrevisto: paraData(proximo.dtDesmamePrevisto),
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

  if (parto.dtDesmameReal !== null) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'O desmame ja foi registrado: a selecao vem antes dele.')
  }

  if (parto.dtSelecao !== null) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'A selecao deste parto ja foi registrada.')
  }

  if (dados.dtSelecao < dataISO(parto.dtPartoReal)) {
    throw campoInvalido('dtSelecao', 'A selecao nao pode ser antes do parto.')
  }

  if (dados.eutanasiadoM > parto.nascidoM || dados.eutanasiadoF > parto.nascidoF) {
    throw new ErroDeAplicacao(400, 'VALIDACAO', 'Confira os campos destacados.', {
      campos: {
        eutanasiado: `Nao pode passar do nascido (${parto.nascidoM} M, ${parto.nascidoF} F).`,
      },
    })
  }

  await prisma.$transaction(async (tx) => {
    await tx.parto.update({
      where: { id: idParto },
      data: {
        dtSelecao: paraData(dados.dtSelecao),
        eutanasiadoM: dados.eutanasiadoM,
        eutanasiadoF: dados.eutanasiadoF,
        idUsuarioSelecao: idUsuario,
        dtRegistroSelecao: new Date(),
      },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: idParto,
      acao: 'selecao',
      descricao: `Selecao do ${parto.ordem}o parto em ${dados.dtSelecao}: ${dados.eutanasiadoM} M e ${dados.eutanasiadoF} F`,
      dados: { ...dados },
    })
  })

  return cicloFicha(idParto)
}

export type Desmame = {
  dtDesmameReal: string
  desmamadoM: number
  desmamadoF: number
}

/** POST /api/partos/:id/desmame. A partir daqui o estoque e confirmado */
export async function registrarDesmame(idParto: number, dados: Desmame, idUsuario: number) {
  const parto = await prisma.parto.findUnique({ where: { id: idParto } })

  if (parto === null) {
    throw naoEncontrado('Parto')
  }

  if (parto.dtPartoReal === null || parto.nascidoM === null || parto.nascidoF === null) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'Registre o parto antes do desmame.')
  }

  if (parto.dtDesmameReal !== null) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'O desmame deste parto ja foi registrado.')
  }

  if (dados.dtDesmameReal < dataISO(parto.dtPartoReal)) {
    throw campoInvalido('dtDesmameReal', 'O desmame nao pode ser antes do parto.')
  }

  const vivosM = parto.nascidoM - (parto.eutanasiadoM ?? 0)
  const vivosF = parto.nascidoF - (parto.eutanasiadoF ?? 0)

  if (dados.desmamadoM > vivosM || dados.desmamadoF > vivosF) {
    throw campoInvalido(
      'desmamado',
      `Nao pode passar do nascido menos a selecao (${vivosM} M, ${vivosF} F).`,
    )
  }

  await prisma.$transaction(async (tx) => {
    await tx.parto.update({
      where: { id: idParto },
      data: {
        dtDesmameReal: paraData(dados.dtDesmameReal),
        desmamadoM: dados.desmamadoM,
        desmamadoF: dados.desmamadoF,
        idUsuarioDesmame: idUsuario,
        dtRegistroDesmame: new Date(),
      },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: idParto,
      acao: 'desmame',
      descricao: `Desmame do ${parto.ordem}o parto em ${dados.dtDesmameReal}: ${dados.desmamadoM} M e ${dados.desmamadoF} F`,
      dados: { ...dados },
    })
  })

  return cicloFicha(idParto)
}

export type Encerramento = {
  dtEncerramento: string
  motivo: string
}

/** POST /api/casais/:id/encerramento - nada e apagado, so encerra */
export async function encerrarCasal(idCasal: number, dados: Encerramento, idUsuario: number) {
  const casal = await prisma.casal.findUnique({ where: { id: idCasal } })

  if (casal === null) {
    throw naoEncontrado('Casal')
  }

  if (!casal.ativo) {
    throw new ErroDeAplicacao(400, 'VALIDACAO', 'Confira os campos destacados.', {
      campos: { idCasal: 'Este casal ja esta encerrado.' },
    })
  }

  if (dados.dtEncerramento < dataISO(casal.dtFormacao)) {
    throw campoInvalido('dtEncerramento', 'O encerramento nao pode ser antes da formacao do casal.')
  }

  await prisma.$transaction(async (tx) => {
    await tx.casal.update({
      where: { id: idCasal },
      data: {
        ativo: false,
        dtEncerramento: paraData(dados.dtEncerramento),
        motivoEncerramento: dados.motivo,
      },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'casal',
      idEntidade: idCasal,
      acao: 'encerramento',
      descricao: `Casal ${casal.identificacao} encerrado em ${dados.dtEncerramento}: ${dados.motivo}`,
      dados: { ...dados },
    })
  })

  return casalFicha(idCasal)
}
