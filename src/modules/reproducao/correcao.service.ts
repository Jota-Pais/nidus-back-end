// As correcoes da ficha do parto: o acasalamento, o nascimento (data, contagem e sexo) e a data
// do desmame. A contagem do desmame e a selecao nao se corrigem aqui: anula-se a baixa errada e
// lanca-se a certa (colonia/baixa.service.ts).
//
// Corrigir uma data nunca deixa um fato dos animais fora de ordem: a trilha (colonia.ocorrencia)
// diz quando cada um morreu, mudou de caixa ou foi entregue.

import type { Prisma } from '@prisma/client'
import { campoInvalido, erroDeRegra } from '../../shared/erros.ts'
import { MAX_PARTOS_POR_CASAL } from '../../shared/parametros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, dataLegivel, paraData } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { animaisDoParto, faltasDosPedidos, ninhadasNaCaixa } from '../colonia/consultas.ts'
import { exigirEstoqueQueRecebe } from '../colonia/destino.ts'
import { escolherAnimais, pedidosTocados } from '../colonia/escolha.ts'
import type { Escolhido } from '../colonia/escolha.ts'
import { liberarSeVazia } from '../colonia/liberacao.ts'
import { lancarOcorrencia } from '../colonia/ocorrencia.ts'
import { MOTIVO_NAO_CHEGOU_AO_DESMAME, SEXOS, contarPorSexo, doSexo, quantosDoSexo } from '../colonia/tipos.ts'
import type { PorSexo, Sexo } from '../colonia/tipos.ts'
import { travarCaixas } from '../colonia/travas.ts'
import { cicloFicha } from './cicloFicha.ts'
import { exigirOrdem } from './ordemDasDatas.ts'
import { contagemInvalida, travarELerParto } from './reproducao.service.ts'
import type { Nascimento, PartoTravado } from './reproducao.service.ts'
import { baixaDoParto, exigirDataDoDesmame, primeiroFato, rotuloDoFato } from './trilhaDoParto.ts'

type Transacao = Prisma.TransactionClient

export type ComMotivo<T> = T & { motivo: string }

/** '[o que] de antes para depois', ou null quando nao mudou */
export function dePara(antes: string, depois: string, oQue?: string): string | null {
  if (antes === depois) return null

  return `${oQue === undefined ? '' : `${oQue} `}de ${antes} para ${depois}`
}

/**
 * A descricao da correcao no historico, que a ficha mostra como evento: o que mudou entre
 * parenteses e o motivo. 'Correcao do acasalamento do 2o parto (de 10/10/2026 para 08/10/2026):
 * digitado errado'
 */
export function descricaoDaCorrecao(titulo: string, mudancas: (string | null)[], motivo: string): string {
  const mudou = mudancas.filter((mudanca) => mudanca !== null)

  return `${titulo}${mudou.length === 0 ? '' : ` (${mudou.join('; ')})`}: ${motivo}`
}

const contagem = (n: PorSexo) => `${n.m} M e ${n.f} F`

// ------------------------------------------------------------ acasalamento

/**
 * PATCH /api/partos/:id/acasalamento - corrige a data do acasalamento: o erro de digitacao e a
 * nova monta quando o acasalamento nao pegou, sem gastar um dos 5 partos. A data fica depois da
 * formacao e do parto anterior, e antes do nascimento, do fechamento sem ninhada e do
 * encerramento do casal
 */
export async function corrigirAcasalamento(
  idParto: number,
  dados: ComMotivo<{ dtAcasalamento: string }>,
  idUsuario: number,
) {
  await prisma.$transaction(async (tx) => {
    const parto = await travarELerParto(tx, idParto)
    const anterior = await tx.parto.findFirst({
      where: { idCasal: parto.idCasal, ordem: parto.ordem - 1 },
      select: { ordem: true, dtPartoReal: true },
    })

    exigirOrdem('dtAcasalamento', dados.dtAcasalamento, {
      depoisDe: [
        { evento: 'da formacao do casal', data: parto.casal.dtFormacao },
        { evento: `do ${anterior?.ordem}o parto`, data: anterior?.dtPartoReal },
      ],
      antesDe: [
        { evento: 'do parto', data: parto.dtPartoReal },
        { evento: 'do fechamento sem ninhada', data: parto.dtSemNinhada },
        { evento: 'do encerramento do casal', data: parto.casal.dtEncerramento },
      ],
    })

    const antes = dataISO(parto.dtAcasalamento)

    await tx.parto.update({
      where: { id: idParto },
      data: { dtAcasalamento: paraData(dados.dtAcasalamento), dtManutencao: new Date() },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: idParto,
      acao: 'correcao_acasalamento',
      descricao: descricaoDaCorrecao(
        `Correcao do acasalamento do ${parto.ordem}o parto`,
        [dePara(dataLegivel(antes), dataLegivel(dados.dtAcasalamento))],
        dados.motivo,
      ),
      dados: {
        motivo: dados.motivo,
        antes: { dtAcasalamento: antes },
        depois: { dtAcasalamento: dados.dtAcasalamento },
      },
    })
  })

  return cicloFicha(idParto)
}

// ------------------------------------------------------------ nascimento

/** O que muda nos animais para a contagem do parto passar de 'atual' para 'nova' */
export type PlanoDaContagem = {
  /** Animais registrados com o sexo trocado */
  troca: { de: Sexo; para: Sexo; qtd: number } | null
  /** Animais que nasceram e nao foram registrados */
  novos: PorSexo
  /** Registros de animal que nao existiu */
  anular: PorSexo
}

/**
 * Quando um sexo sobe e o outro desce, a diferenca comum e troca de sexo (eram machos registrados
 * como femeas, ou o contrario). O resto e animal a mais ou registro a anular
 */
export function planoDaContagem(atual: PorSexo, nova: PorSexo): PlanoDaContagem {
  const difM = nova.m - atual.m
  const difF = nova.f - atual.f

  if (difM > 0 && difF < 0) {
    const qtd = Math.min(difM, -difF)
    return { troca: { de: 'F', para: 'M', qtd }, novos: { m: difM - qtd, f: 0 }, anular: { m: 0, f: -difF - qtd } }
  }

  if (difF > 0 && difM < 0) {
    const qtd = Math.min(difF, -difM)
    return { troca: { de: 'M', para: 'F', qtd }, novos: { m: 0, f: difF - qtd }, anular: { m: -difM - qtd, f: 0 } }
  }

  return {
    troca: null,
    novos: { m: Math.max(0, difM), f: Math.max(0, difF) },
    anular: { m: Math.max(0, -difM), f: Math.max(0, -difF) },
  }
}

/**
 * Quando os animais do parto chegaram na caixa: a chegada mais antiga dos que estao nela, ou que
 * sairam dela (morte, entrega), sem contar registro anulado. Null se nenhum animal do parto
 * passou a ser dela. Lida depois de travar a caixa: e a de agora, e nao a de antes das travas
 */
async function chegadaDaNinhada(tx: Transacao, idParto: number, idCaixa: number): Promise<string | null> {
  const { _min } = await tx.animal.aggregate({
    where: { idParto, idCaixa, situacao: { not: 'anulado' } },
    _min: { dtMovimento: true },
  })

  return _min.dtMovimento === null ? null : dataISO(_min.dtMovimento)
}

/**
 * Onde entram os animais a mais: onde a ninhada esta. Na caixa do casal se ela continua ativa e
 * sem vivos de outro parto (duas ninhadas nao dividem a caixa, a mesma regra do nascimento e da
 * anulacao), ou na caixa de estoque indicada, depois do desmame. A caixa do casal que virou
 * estoque recebe como estoque, e la os a mais estao onde nasceram. A caixa de estoque guarda um
 * sexo so: os a mais dos dois sexos, com a ninhada ja separada, entram um sexo por vez.
 *
 * Os a mais chegam na caixa de estoque com a ninhada: no dia em que os animais do parto chegaram
 * nela (chegadaDaNinhada) ou, sem nenhum dela ali, no desmame. A caixa tem de ja existir nesse dia
 */
async function destinoDosNovos(
  tx: Transacao,
  parto: PartoTravado,
  idCaixa: number | undefined,
  novos: PorSexo,
): Promise<{ idCaixa: number; dtMovimento: string | null }> {
  const caixaDoCasal = parto.casal.caixa
  const alvo = idCaixa ?? parto.casal.idCaixa
  const naDoCasal = alvo === parto.casal.idCaixa

  if (naDoCasal && !caixaDoCasal.ativa) {
    throw campoInvalido(
      'idCaixa',
      `A caixa ${caixaDoCasal.codigo} do casal ja foi liberada: diga em qual caixa de estoque entram os animais a mais.`,
    )
  }

  if (naDoCasal && caixaDoCasal.tipo === 'casal') {
    const outra = (await ninhadasNaCaixa(tx, alvo)).find((ninhada) => ninhada.idParto !== parto.id)

    if (outra !== undefined) {
      throw campoInvalido(
        'idCaixa',
        `A caixa ${caixaDoCasal.codigo} do casal tem agora a ninhada do ${outra.ordem}o parto: diga em qual caixa de estoque entram os animais a mais.`,
      )
    }

    return { idCaixa: alvo, dtMovimento: null }
  }

  if (parto.dtDesmameReal === null) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'Antes do desmame os filhotes ficam na caixa do casal.')
  }

  const sexos = SEXOS.filter((sexo) => doSexo(novos, sexo) > 0)
  const [sexo] = sexos

  if (sexo === undefined || sexos.length > 1) {
    throw campoInvalido(
      'idCaixa',
      'Machos e femeas ficam em caixas de estoque diferentes: corrija os a mais de um sexo de cada vez.',
    )
  }

  const quem = { sexo, idLinhagem: parto.casal.idLinhagem }

  if (naDoCasal) {
    // a caixa do casal que virou estoque: os a mais estao onde nasceram, sem chegada
    await exigirEstoqueQueRecebe(tx, alvo, 'idCaixa', quem, {
      data: dataISO(parto.dtPartoReal ?? parto.dtDesmameReal),
      campo: 'idCaixa',
      deQue: 'do nascimento',
    })

    return { idCaixa: alvo, dtMovimento: null }
  }

  const daNinhada = await chegadaDaNinhada(tx, parto.id, alvo)
  const chegada = daNinhada ?? dataISO(parto.dtDesmameReal)

  await exigirEstoqueQueRecebe(tx, alvo, 'idCaixa', quem, {
    data: chegada,
    campo: 'idCaixa',
    deQue: daNinhada === null ? 'do desmame' : 'da chegada da ninhada nela',
  })

  return { idCaixa: alvo, dtMovimento: chegada }
}

export type CorrecaoDoNascimento = ComMotivo<Nascimento> & {
  /** Onde entram os animais a mais quando a ninhada ja saiu da caixa do casal */
  idCaixa?: number | undefined
  /** De qual pedido saem os reservados a anular, quando os livres nao bastam */
  idPedido?: number | undefined
}

/**
 * PATCH /api/partos/:id/nascimento - corrige a data e a contagem do parto. A data muda no parto e
 * na ocorrencia do nascimento, e com ela a idade de todos os animais do parto, onde estiverem.
 * Na contagem: troca de sexo de vivos livres na caixa do casal, animais a mais onde a ninhada esta
 * e anulacao de registros (livres primeiro; nunca morto ou entregue)
 */
export async function corrigirNascimento(idParto: number, dados: CorrecaoDoNascimento, idUsuario: number) {
  const faltas = await prisma.$transaction(async (tx) => {
    const parto = await travarELerParto(tx, idParto)

    if (parto.dtPartoReal === null) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', 'Este parto ainda nao foi registrado: registre antes de corrigir.')
    }

    // uma consulta de cada vez: a transacao e uma conexao so
    const seguinte = await tx.parto.findFirst({
      where: { idCasal: parto.idCasal, ordem: parto.ordem + 1 },
      select: { dtAcasalamento: true },
    })
    const fato = await primeiroFato(tx, idParto, ['baixa', 'mudanca', 'entrega'])

    exigirOrdem('dtPartoReal', dados.dtPartoReal, {
      depoisDe: [{ evento: 'do acasalamento', data: parto.dtAcasalamento }],
      antesDe: [
        { evento: 'do desmame', data: parto.dtDesmameReal },
        { evento: `do acasalamento do ${parto.ordem + 1}o parto`, data: seguinte?.dtAcasalamento },
        { evento: rotuloDoFato(fato), data: fato?.dtFato },
      ],
    })

    const animais = await animaisDoParto(tx, idParto)
    const nascidos = contarPorSexo(animais.filter((animal) => animal.situacao !== 'anulado'))
    const vivos = contarPorSexo(animais.filter((animal) => animal.situacao === 'vivo'))
    const plano = planoDaContagem(nascidos, { m: dados.nascidoM, f: dados.nascidoF })

    // so vivo se anula ou troca de sexo: o morto e o entregue aconteceram como foram registrados.
    // Somando a troca e a anulacao de um sexo, o que sai dele e nascidos - nova contagem
    const passou = { m: dados.nascidoM < nascidos.m - vivos.m, f: dados.nascidoF < nascidos.f - vivos.f }

    if (passou.m || passou.f) {
      throw contagemInvalida(
        'nascido',
        passou,
        `Os mortos e os entregues continuam contando: o nascido nao fica abaixo de ${nascidos.m - vivos.m} M e ${nascidos.f - vivos.f} F.`,
      )
    }

    // a troca de sexo vale so para vivo livre na caixa do casal: o reservado conta no pedido pelo
    // sexo, e a caixa de estoque guarda um sexo so (tambem a do casal que virou estoque)
    const troca = plano.troca
    const caixaDaNinhada = parto.casal.caixa.tipo === 'casal' ? parto.casal.idCaixa : null

    if (troca !== null) {
      const trocaveis = animais.filter(
        (animal) =>
          animal.situacao === 'vivo' &&
          animal.sexo === troca.de &&
          animal.idPedido === null &&
          animal.idCaixa === caixaDaNinhada,
      ).length

      if (trocaveis < troca.qtd) {
        throw erroDeRegra(
          'SEQUENCIA_INVALIDA',
          `So troca de sexo o animal vivo, livre e na caixa do casal (nunca numa caixa de estoque): a correcao troca ${quantosDoSexo(troca.qtd, troca.de)}, e so ha ${trocaveis} assim. Desfaca a reserva ou corrija de outro jeito.`,
        )
      }
    }

    // as caixas que a correcao pode tocar, travadas juntas e em ordem antes de ler o destino
    await travarCaixas(tx, [
      parto.casal.idCaixa,
      ...(dados.idCaixa === undefined ? [] : [dados.idCaixa]),
      ...animais.filter((animal) => animal.situacao === 'vivo').map((animal) => animal.idCaixa),
    ])

    const novos =
      plano.novos.m + plano.novos.f === 0 ? null : await destinoDosNovos(tx, parto, dados.idCaixa, plano.novos)

    const trocados =
      troca === null
        ? []
        : await escolherAnimais(tx, { idParto, idCaixa: parto.casal.idCaixa, sexo: troca.de }, troca.qtd, {
            soLivres: true,
          })

    const anulados: Escolhido[] = []

    for (const sexo of SEXOS) {
      anulados.push(
        ...(await escolherAnimais(tx, { idParto, sexo }, doSexo(plano.anular, sexo), {
          idPedido: dados.idPedido,
          excluir: [...trocados, ...anulados].map((animal) => animal.id),
        })),
      )
    }

    const dataAntiga = dataISO(parto.dtPartoReal)

    if (dados.dtPartoReal !== dataAntiga) {
      await tx.parto.update({
        where: { id: idParto },
        data: { dtPartoReal: paraData(dados.dtPartoReal), dtManutencao: new Date() },
      })

      await tx.ocorrencia.updateMany({
        where: { idParto, tipo: 'nascimento' },
        data: { dtFato: paraData(dados.dtPartoReal) },
      })

      // o 5o parto encerrou o casal na data dele: o encerramento acompanha a data corrigida
      if (
        parto.ordem >= MAX_PARTOS_POR_CASAL &&
        parto.casal.dtEncerramento !== null &&
        dataISO(parto.casal.dtEncerramento) === dataAntiga
      ) {
        await tx.casal.update({
          where: { id: parto.casal.id },
          data: { dtEncerramento: paraData(dados.dtPartoReal), dtManutencao: new Date() },
        })
      }
    }

    if (trocados.length + anulados.length > 0 || novos !== null) {
      await lancarOcorrencia(tx, {
        tipo: 'correcao',
        dtFato: dados.dtPartoReal,
        idUsuario,
        idParto,
        motivo: dados.motivo,
        trocaDeSexo: troca === null ? undefined : { ids: trocados.map((animal) => animal.id), para: troca.para },
        anulados: anulados.map((animal) => animal.id),
        novos: novos === null ? undefined : { ...novos, ...plano.novos },
      })
    }

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: idParto,
      acao: 'correcao_nascimento',
      descricao: descricaoDaCorrecao(
        `Correcao do ${parto.ordem}o parto`,
        [
          dePara(dataLegivel(dataAntiga), dataLegivel(dados.dtPartoReal), 'nascimento'),
          dePara(contagem(nascidos), contagem({ m: dados.nascidoM, f: dados.nascidoF }), 'contagem'),
        ],
        dados.motivo,
      ),
      dados: {
        motivo: dados.motivo,
        antes: { dtPartoReal: dataAntiga, nascidoM: nascidos.m, nascidoF: nascidos.f },
        depois: { dtPartoReal: dados.dtPartoReal, nascidoM: dados.nascidoM, nascidoF: dados.nascidoF },
      },
    })

    // a caixa que so tinha registros anulados fica vazia desde o ultimo fato real nela, que a
    // liberacao acha na trilha; o parto e o piso
    for (const idCaixa of new Set(anulados.map((animal) => animal.idCaixa))) {
      await liberarSeVazia(tx, idCaixa, dados.dtPartoReal, 'baixa', idUsuario)
    }

    return faltasDosPedidos(tx, pedidosTocados(anulados))
  })

  return { parto: await cicloFicha(idParto), faltas }
}

// ------------------------------------------------------------ desmame

/**
 * PATCH /api/partos/:id/desmame - corrige so a data do desmame, nos mesmos limites do registro
 * (exigirDataDoDesmame). A baixa 'nao chegou ao desmame' acompanha a data. A contagem se corrige
 * anulando essa baixa ou lancando outra
 */
export async function corrigirDesmame(
  idParto: number,
  dados: ComMotivo<{ dtDesmameReal: string }>,
  idUsuario: number,
) {
  await prisma.$transaction(async (tx) => {
    const parto = await travarELerParto(tx, idParto)

    if (parto.dtDesmameReal === null || parto.dtPartoReal === null) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', 'O desmame deste parto ainda nao foi registrado.')
    }

    await exigirDataDoDesmame(tx, parto, dados.dtDesmameReal, await animaisDoParto(tx, idParto))

    const naoChegaram = await baixaDoParto(tx, idParto, MOTIVO_NAO_CHEGOU_AO_DESMAME, 'asc')

    const antes = dataISO(parto.dtDesmameReal)
    if (dados.dtDesmameReal === antes) return

    await tx.parto.update({
      where: { id: idParto },
      data: { dtDesmameReal: paraData(dados.dtDesmameReal), dtManutencao: new Date() },
    })

    if (naoChegaram !== null) {
      await tx.ocorrencia.update({
        where: { id: naoChegaram.id },
        data: { dtFato: paraData(dados.dtDesmameReal) },
      })

      await lancarOcorrencia(tx, {
        tipo: 'correcao',
        dtFato: dados.dtDesmameReal,
        idUsuario,
        idParto,
        motivo: dados.motivo,
        novaSaida: { ids: naoChegaram.animais.map((ligacao) => ligacao.idAnimal), dtSaida: dados.dtDesmameReal },
      })
    }

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: idParto,
      acao: 'correcao_desmame',
      descricao: descricaoDaCorrecao(
        `Correcao do desmame do ${parto.ordem}o parto`,
        [dePara(dataLegivel(antes), dataLegivel(dados.dtDesmameReal))],
        dados.motivo,
      ),
      dados: {
        motivo: dados.motivo,
        antes: { dtDesmameReal: antes },
        depois: { dtDesmameReal: dados.dtDesmameReal },
      },
    })
  })

  return { parto: await cicloFicha(idParto) }
}
