// Casais e o registro dos partos: nascimento, eutanasia de selecao e desmame

import { registrarHistorico } from '../historico/historico.service.ts'
import { codigoDaPosicao } from '../infra/endereco.ts'
import {
  compromissosAtivosComPedido,
  disponibilidadeDoParto,
  faltaNaReserva,
  separarEntregues,
} from './disponibilidade.ts'
import {
  calcularCicloInicial,
  calcularDesmamePrevisto,
} from './cadeiaTemporal.ts'
import { ErroDeAplicacao, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { MAX_PARTOS_POR_CASAL } from '../../shared/parametros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, paraData } from '../../shared/traducao.ts'
import { liberarCaixaVazia } from '../infra/liberacaoDaCaixa.ts'

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
 * O objeto ciclo da ficha, com a disponibilidade liquida e o reservado separado do ja entregue.
 * Reaproveitado pelos tres eventos e pela ficha da posicao
 */
export async function cicloFicha(idParto: number) {
  const parto = await prisma.parto.findUnique({
    where: { id: idParto },
    include: { compromissos: compromissosAtivosComPedido },
  })

  if (parto === null) {
    throw naoEncontrado('Parto')
  }

  const disponibilidade = disponibilidadeDoParto(parto)
  const { comprometido, entregue } = separarEntregues(parto.compromissos)
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
    comprometido,
    entregue,
    /** reserva acima do que a ninhada tem depois do desmame ou da correcao; null quando cabe */
    falta: faltaNaReserva(parto),
  }
}

function campoInvalido(campo: string, mensagem: string) {
  return new ErroDeAplicacao(400, 'VALIDACAO', 'Confira os campos destacados.', {
    campos: { [campo]: mensagem },
  })
}

/**
 * Contagem que passou do limite, com a mensagem no campo de cada sexo que passou
 * ('desmamadoM', 'desmamadoF'...): o formulario destaca o campo certo
 */
export function contagemInvalida(campo: string, passou: { m: boolean; f: boolean }, mensagem: string) {
  return new ErroDeAplicacao(400, 'VALIDACAO', 'Confira os campos destacados.', {
    campos: {
      ...(passou.m ? { [`${campo}M`]: mensagem } : {}),
      ...(passou.f ? { [`${campo}F`]: mensagem } : {}),
    },
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
 * As colunas de onde a caixa nao recebe casal novo. O casal novo leva a caixa para Livres, e
 * Estoque e Reserva nao voltam para Livres (fluxoDoKanban.ts). Enviado volta: e assim que a
 * caixa enviada e reaproveitada
 */
const COLUNA_SEM_VOLTA: Record<string, string> = { E: 'Estoque', T: 'Reserva' }

/**
 * POST /api/casais - forma o casal e ja cria o 1o parto, com as datas previstas. Numa posicao
 * vazia a caixa nasce na mesma transacao, com a especie da linhagem escolhida
 */
export async function formarCasal(dados: NovoCasal, idUsuario: number) {
  const linhagem = await prisma.linhagem.findUnique({ where: { id: dados.idLinhagem } })

  if (linhagem === null) {
    throw naoEncontrado('Linhagem')
  }

  // a mesma regra do pedido: linhagem inativa nao aparece no catalogo e nao recebe nada novo
  if (!linhagem.ativa) {
    throw campoInvalido('idLinhagem', 'Esta linhagem esta inativa e nao forma casal novo.')
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

  const semVolta = caixaExistente === null ? undefined : COLUNA_SEM_VOLTA[caixaExistente.estado]

  if (semVolta !== undefined) {
    throw erroDeRegra(
      'TRANSICAO_INVALIDA',
      `Esta caixa esta em ${semVolta} e nao volta para Livres: casal novo nao entra em caixa de Estoque ou Reserva.`,
    )
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
) {
  const parto = await prisma.parto.findUnique({
    where: { id: idParto },
    include: { casal: { select: { ativo: true, idCaixa: true } } },
  })

  if (parto === null) {
    throw naoEncontrado('Parto')
  }

  if (parto.dtPartoReal !== null) {
    throw erroDeRegra(
      'SEQUENCIA_INVALIDA',
      'Este parto ja tem data real registrada. Para mudar, use Corrigir no parto.',
    )
  }

  if (!parto.casal.ativo) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'Este casal esta encerrado e nao recebe parto novo.')
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

      await liberarCaixaVazia(tx, parto.casal.idCaixa, idUsuario)
    }
  })

  return cicloFicha(idParto)
}

export type Acasalamento = {
  dtAcasalamento: string
}

export async function registrarAcasalamento(idCasal: number, dados: Acasalamento, idUsuario: number) {
  const casal = await prisma.casal.findUnique({
    where: { id: idCasal },
    include: { partos: { orderBy: { ordem: 'desc' }, take: 1 } },
  })

  if (casal === null) {
    throw naoEncontrado('Casal')
  }

  if (!casal.ativo) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'Este casal esta encerrado e nao recebe acasalamento novo.')
  }

  const [ultimo] = casal.partos

  if (ultimo !== undefined && ultimo.dtPartoReal === null) {
    throw erroDeRegra(
      'SEQUENCIA_INVALIDA',
      `Registre o ${ultimo.ordem}o parto antes do acasalamento seguinte.`,
    )
  }

  const ordem = (ultimo?.ordem ?? 0) + 1

  if (ordem > MAX_PARTOS_POR_CASAL) {
    throw erroDeRegra(
      'SEQUENCIA_INVALIDA',
      `Este casal ja teve os ${MAX_PARTOS_POR_CASAL} partos.`,
    )
  }

  const ciclo = calcularCicloInicial(dados.dtAcasalamento)

  const criado = await prisma.$transaction(async (tx) => {
    const parto = await tx.parto.create({
      data: {
        idCasal,
        ordem,
        dtAcasalamento: paraData(ciclo.dtAcasalamento),
        dtPartoPrevisto: paraData(ciclo.dtPartoPrevisto),
        dtDesmamePrevisto: paraData(ciclo.dtDesmamePrevisto),
      },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: parto.id,
      acao: 'acasalamento',
      descricao: `Acasalamento do ${ordem}o parto do casal ${casal.identificacao.trim()} em ${dados.dtAcasalamento}`,
      dados: { ...dados },
    })

    return parto
  })

  return cicloFicha(criado.id)
}

export type Selecao = {
  dtSelecao: string
  eutanasiadoM: number
  eutanasiadoF: number
}

/** POST /api/partos/:id/selecao */
export async function registrarSelecao(idParto: number, dados: Selecao, idUsuario: number) {
  const parto = await prisma.parto.findUnique({
    where: { id: idParto },
    include: { casal: { select: { ativo: true, idCaixa: true } } },
  })

  if (parto === null) {
    throw naoEncontrado('Parto')
  }

  if (parto.dtPartoReal === null || parto.nascidoM === null || parto.nascidoF === null) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'Registre o parto antes da eutanasia.')
  }

  if (parto.dtDesmameReal !== null) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'O desmame ja foi registrado: a eutanasia vem antes dele.')
  }

  if (parto.dtSelecao !== null) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'A eutanasia deste parto ja foi registrada.')
  }

  const eutanasiaPassou = {
    m: dados.eutanasiadoM > parto.nascidoM,
    f: dados.eutanasiadoF > parto.nascidoF,
  }

  if (eutanasiaPassou.m || eutanasiaPassou.f) {
    throw contagemInvalida(
      'eutanasiado',
      eutanasiaPassou,
      `Nao pode passar do nascido (${parto.nascidoM} M, ${parto.nascidoF} F).`,
    )
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
      descricao: `Eutanasia do ${parto.ordem}o parto em ${dados.dtSelecao}: ${dados.eutanasiadoM} M e ${dados.eutanasiadoF} F`,
      dados: { ...dados },
    })

    if (!parto.casal.ativo) {
      await liberarCaixaVazia(tx, parto.casal.idCaixa, idUsuario)
    }
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
  const parto = await prisma.parto.findUnique({
    where: { id: idParto },
    include: { casal: { select: { ativo: true, idCaixa: true } } },
  })

  if (parto === null) {
    throw naoEncontrado('Parto')
  }

  if (parto.dtPartoReal === null || parto.nascidoM === null || parto.nascidoF === null) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'Registre o parto antes do desmame.')
  }

  if (parto.dtDesmameReal !== null) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'O desmame deste parto ja foi registrado.')
  }

  const vivosM = parto.nascidoM - (parto.eutanasiadoM ?? 0)
  const vivosF = parto.nascidoF - (parto.eutanasiadoF ?? 0)
  const desmamePassou = { m: dados.desmamadoM > vivosM, f: dados.desmamadoF > vivosF }

  if (desmamePassou.m || desmamePassou.f) {
    throw contagemInvalida(
      'desmamado',
      desmamePassou,
      `Nao pode passar do nascido menos a eutanasia (${vivosM} M, ${vivosF} F).`,
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

    if (!parto.casal.ativo) {
      await liberarCaixaVazia(tx, parto.casal.idCaixa, idUsuario)
    }
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

    await liberarCaixaVazia(tx, casal.idCaixa, idUsuario)
  })

  return casalFicha(idCasal)
}
