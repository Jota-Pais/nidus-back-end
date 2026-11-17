// As correcoes da ficha do parto, que a janela Editar da ficha reune: o acasalamento, o nascimento
// (data, contagem e sexo), o desmame (data e contagem), o fechamento sem ninhada e cada baixa dos
// animais do parto (data, causa e contagem). Corrigir nao pede motivo: o historico guarda o antes,
// o depois e quem fez. Quando vem escrito, o motivo vai junto para a trilha e para o historico.
//
// Corrigir uma data nunca deixa um fato dos animais fora de ordem: a trilha (colonia.ocorrencia)
// diz quando cada um morreu, mudou de caixa ou foi entregue. A contagem que muda animal (a da baixa,
// a do desmame) anula a baixa de antes e lanca a certa na mesma transacao, com as pecas da anulacao
// (colonia/baixa.service.ts) e da baixa do parto (baixarDoParto): nenhuma regra nova de baixa.

import { agora } from '../../shared/relogio.ts'
import type { Prisma } from '@prisma/client'
import { campoInvalido, erroDeRegra } from '../../shared/erros.ts'
import { MAX_PARTOS_POR_CASAL } from '../../shared/parametros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, dataLegivel, paraData } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { MOTIVO_DO_TIPO, anularParaCorrigir, lerBaixaAnulavel, lerCaixaDaBaixa } from '../colonia/baixa.service.ts'
import type { BaixaAnulavel } from '../colonia/baixa.service.ts'
import { causaDe } from '../colonia/causa.ts'
import type { CausaDaBaixa } from '../colonia/causa.ts'
import { animaisDoParto, faltasDosPedidos, ninhadasNaCaixa } from '../colonia/consultas.ts'
import type { AnimalDoParto } from '../colonia/consultas.ts'
import { exigirEstoqueQueRecebe } from '../colonia/destino.ts'
import { escolherAnimais, exigirDepoisDaChegada, pedidosTocados } from '../colonia/escolha.ts'
import type { Escolhido } from '../colonia/escolha.ts'
import { liberarSeVazia } from '../colonia/liberacao.ts'
import { lancarOcorrencia } from '../colonia/ocorrencia.ts'
import {
  MOTIVO_NAO_CHEGOU_AO_DESMAME,
  MOTIVO_SELECAO,
  SEXOS,
  contarPorSexo,
  doSexo,
  origemDaNinhada,
  quantosAnimais,
  quantosDoSexo,
} from '../colonia/tipos.ts'
import type { PorSexo, Sexo } from '../colonia/tipos.ts'
import { travarCaixas, travarOcorrencia } from '../colonia/travas.ts'
import { calcularProximoCiclo } from './cadeiaTemporal.ts'
import { cicloFicha, contarDoParto } from './cicloFicha.ts'
import { exigirOrdem } from './ordemDasDatas.ts'
import { baixarDoParto, contagemInvalida, travarELerParto } from './reproducao.service.ts'
import type { Nascimento, PartoTravado } from './reproducao.service.ts'
import {
  baixaDoParto,
  exigirDataDoDesmame,
  levarSelecoesParaODesmame,
  primeiroFatoDoNascimento,
  rotuloDoFato,
  selecoesQuePassaram,
} from './trilhaDoParto.ts'
import type { SelecoesLevadas } from './trilhaDoParto.ts'

type Transacao = Prisma.TransactionClient

/** O motivo e opcional em toda correcao: quando vem, vai para a trilha e para o historico */
export type MotivoOpcional<T> = T & { motivo?: string | undefined }

/**
 * O motivo que as ocorrencias da correcao gravam quando ninguem escreveu um. O banco cobra motivo
 * na correcao e na anulacao (a trilha diz por que o fato mudou), e corrigir nao pede: o texto e do
 * sistema, e o historico guarda o antes e o depois
 */
const MOTIVO_DO_SISTEMA = {
  nascimento: 'correção do nascimento',
  desmame: 'correção do desmame',
  baixa: 'correção da baixa',
} as const

/** O motivo escrito, para os dados do historico: so quando veio */
function comMotivo(motivo: string | undefined): { motivo?: string } {
  return motivo === undefined ? {} : { motivo }
}

/** '[o que] de antes para depois', ou null quando nao mudou */
export function dePara(antes: string, depois: string, oQue?: string): string | null {
  if (antes === depois) return null

  return `${oQue === undefined ? '' : `${oQue} `}de ${antes} para ${depois}`
}

/**
 * A descricao da correcao no historico, que a ficha mostra como evento: o que mudou entre
 * parenteses e o motivo, quando tem. 'Correcao do acasalamento do 2o parto (de 10/10/2026 para
 * 08/10/2026): digitado errado'
 */
export function descricaoDaCorrecao(
  titulo: string,
  mudancas: (string | null)[],
  motivo?: string | undefined,
): string {
  const mudou = mudancas.filter((mudanca) => mudanca !== null)

  return `${titulo}${mudou.length === 0 ? '' : ` (${mudou.join('; ')})`}${motivo === undefined ? '' : `: ${motivo}`}`
}

// ------------------------------------------------------------ acasalamento

/**
 * PATCH /api/partos/:id/acasalamento - a data do acasalamento, editada direto na ficha, sem motivo:
 * a que o sistema abriu (6 dias depois do parto anterior) ou outra, e a que vale e a ultima. Serve
 * tambem para a nova monta quando o acasalamento nao pegou, sem gastar um dos 5 partos. A data fica
 * depois da formacao e do parto anterior, e antes do nascimento, do fechamento sem ninhada e do
 * encerramento do casal. Editada a mao, ela nao acompanha mais a correcao do nascimento anterior
 */
export async function corrigirAcasalamento(
  idParto: number,
  dados: MotivoOpcional<{ dtAcasalamento: string }>,
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
        { evento: 'da formação do casal', data: parto.casal.dtFormacao },
        { evento: `do ${anterior?.ordem}º parto`, data: anterior?.dtPartoReal },
      ],
      antesDe: [
        { evento: 'do parto', data: parto.dtPartoReal },
        { evento: 'do fechamento sem ninhada', data: parto.dtSemNinhada },
        { evento: 'do encerramento do casal', data: parto.casal.dtEncerramento },
      ],
    })

    const antes = dataISO(parto.dtAcasalamento)
    if (antes === dados.dtAcasalamento) return

    await tx.parto.update({
      where: { id: idParto },
      data: { dtAcasalamento: paraData(dados.dtAcasalamento), dtManutencao: agora() },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: idParto,
      acao: 'correcao_acasalamento',
      descricao: descricaoDaCorrecao(
        `Correção do acasalamento do ${parto.ordem}º parto`,
        [dePara(dataLegivel(antes), dataLegivel(dados.dtAcasalamento))],
        dados.motivo,
      ),
      dados: {
        ...comMotivo(dados.motivo),
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
 * nela (chegadaDaNinhada) ou, sem nenhum dela ali, no desmame. A caixa tem de ja existir nesse dia.
 * 'chegada' e null quando os a mais estao onde nasceram
 */
async function destinoDosNovos(
  tx: Transacao,
  parto: PartoTravado,
  idCaixa: number | undefined,
  novos: PorSexo,
): Promise<{ idCaixa: number; chegada: string | null }> {
  const caixaDoCasal = parto.casal.caixa
  const alvo = idCaixa ?? parto.casal.idCaixa
  const naDoCasal = alvo === parto.casal.idCaixa

  if (naDoCasal && !caixaDoCasal.ativa) {
    throw campoInvalido(
      'idCaixa',
      `A caixa ${caixaDoCasal.codigo} do casal já foi liberada: diga em qual caixa de estoque entram os animais a mais.`,
    )
  }

  if (naDoCasal && caixaDoCasal.tipo === 'casal') {
    const outra = (await ninhadasNaCaixa(tx, alvo)).find((ninhada) => ninhada.idParto !== parto.id)

    if (outra !== undefined) {
      throw campoInvalido(
        'idCaixa',
        `A caixa ${caixaDoCasal.codigo} do casal tem agora a ninhada ${origemDaNinhada(outra)}: diga em qual caixa de estoque entram os animais a mais.`,
      )
    }

    return { idCaixa: alvo, chegada: null }
  }

  if (parto.dtDesmameReal === null) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'Antes do desmame os filhotes ficam na caixa do casal.')
  }

  const sexos = SEXOS.filter((sexo) => doSexo(novos, sexo) > 0)
  const [sexo] = sexos

  if (sexo === undefined || sexos.length > 1) {
    throw campoInvalido(
      'idCaixa',
      'Machos e fêmeas ficam em caixas de estoque diferentes: corrija os a mais de um sexo de cada vez.',
    )
  }

  const quem = { sexo, idLinhagem: parto.idLinhagem }

  if (naDoCasal) {
    // a caixa do casal que virou estoque: os a mais estao onde nasceram, sem chegada
    await exigirEstoqueQueRecebe(tx, alvo, 'idCaixa', quem, {
      data: dataISO(parto.dtPartoReal ?? parto.dtDesmameReal),
      campo: 'idCaixa',
      deQue: 'do nascimento',
    })

    return { idCaixa: alvo, chegada: null }
  }

  const daNinhada = await chegadaDaNinhada(tx, parto.id, alvo)
  const chegada = daNinhada ?? dataISO(parto.dtDesmameReal)

  await exigirEstoqueQueRecebe(tx, alvo, 'idCaixa', quem, {
    data: chegada,
    campo: 'idCaixa',
    deQue: daNinhada === null ? 'do desmame' : 'da chegada da ninhada nela',
  })

  return { idCaixa: alvo, chegada }
}

export type CorrecaoDoNascimento = MotivoOpcional<Nascimento> & {
  /** Onde entram os animais a mais quando a ninhada ja saiu da caixa do casal */
  idCaixa?: number | undefined
  /** De qual pedido saem os reservados a anular, quando os livres nao bastam */
  idPedido?: number | undefined
}

/**
 * PATCH /api/partos/:id/nascimento - corrige a data e a contagem do parto. A data muda no parto e
 * na ocorrencia do nascimento, e com ela a idade de todos os animais do parto, onde estiverem. O
 * acasalamento seguinte que o sistema abriu (6 dias depois do parto) e ainda nao deu parto
 * acompanha a data nova; o que foi corrigido a mao fica onde esta e limita a data, como antes.
 * Na contagem: troca de sexo de vivos livres na caixa do casal, animais a mais onde a ninhada esta
 * e anulacao de registros (livres primeiro; nunca morto ou entregue)
 */
export async function corrigirNascimento(idParto: number, dados: CorrecaoDoNascimento, idUsuario: number) {
  const faltas = await prisma.$transaction(async (tx) => {
    const parto = await travarELerParto(tx, idParto)

    if (parto.dtPartoReal === null) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', 'Este parto ainda não foi registrado: registre antes de corrigir.')
    }

    // uma consulta de cada vez: a transacao e uma conexao so
    const seguinte = await tx.parto.findFirst({
      where: { idCasal: parto.idCasal, ordem: parto.ordem + 1 },
      select: { id: true, dtAcasalamento: true, dtPartoReal: true, dtSemNinhada: true },
    })
    const fato = await primeiroFatoDoNascimento(tx, idParto)
    const dataAntiga = dataISO(parto.dtPartoReal)
    const acasalamentoSeguinte = acasalamentoQueAcompanha(seguinte, dataAntiga, dados.dtPartoReal)

    exigirOrdem('dtPartoReal', dados.dtPartoReal, {
      depoisDe: [{ evento: 'do acasalamento', data: parto.dtAcasalamento }],
      antesDe: [
        { evento: 'do desmame', data: parto.dtDesmameReal },
        {
          evento: `do acasalamento do ${parto.ordem + 1}º parto`,
          data: acasalamentoSeguinte === null ? seguinte?.dtAcasalamento : null,
        },
        { evento: rotuloDoFato(fato), data: fato?.dtFato },
      ],
    })

    // o acasalamento que acompanha nao passa do encerramento do casal, que veio depois dele
    if (
      acasalamentoSeguinte !== null &&
      parto.casal.dtEncerramento !== null &&
      acasalamentoSeguinte.depois > dataISO(parto.casal.dtEncerramento)
    ) {
      throw campoInvalido(
        'dtPartoReal',
        `Com esta data, o acasalamento do ${parto.ordem + 1}º parto, que acompanha este parto, passaria do encerramento do casal (${dataLegivel(dataISO(parto.casal.dtEncerramento))}). Corrija antes o acasalamento dele.`,
      )
    }

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
        `Os mortos e os entregues continuam contando: o nascido não fica abaixo de ${quantosAnimais({ m: nascidos.m - vivos.m, f: nascidos.f - vivos.f })}.`,
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
          `Só troca de sexo o animal vivo, livre e na caixa do casal (nunca numa caixa de estoque): a correção troca ${quantosDoSexo(troca.qtd, troca.de)}, e só há ${trocaveis} assim. Desfaça a reserva ou corrija de outro jeito.`,
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

    if (dados.dtPartoReal !== dataAntiga) {
      await tx.parto.update({
        where: { id: idParto },
        data: { dtPartoReal: paraData(dados.dtPartoReal), dtManutencao: agora() },
      })

      await tx.ocorrencia.updateMany({
        where: { idParto, tipo: 'nascimento' },
        data: { dtFato: paraData(dados.dtPartoReal) },
      })

      if (acasalamentoSeguinte !== null) {
        await tx.parto.update({
          where: { id: acasalamentoSeguinte.idParto },
          data: { dtAcasalamento: paraData(acasalamentoSeguinte.depois), dtManutencao: agora() },
        })

        await registrarHistorico(tx, {
          idUsuario,
          entidade: 'parto',
          idEntidade: acasalamentoSeguinte.idParto,
          acao: 'correcao_acasalamento',
          descricao: descricaoDaCorrecao(
            `Correção do acasalamento do ${parto.ordem + 1}º parto`,
            [dePara(dataLegivel(acasalamentoSeguinte.antes), dataLegivel(acasalamentoSeguinte.depois))],
            `acompanha a correção do ${parto.ordem}º parto`,
          ),
          dados: {
            ...comMotivo(dados.motivo),
            antes: { dtAcasalamento: acasalamentoSeguinte.antes },
            depois: { dtAcasalamento: acasalamentoSeguinte.depois },
            automatico: true,
          },
        })
      }

      // o 5o parto encerrou o casal na data dele: o encerramento acompanha a data corrigida
      if (
        parto.ordem >= MAX_PARTOS_POR_CASAL &&
        parto.casal.dtEncerramento !== null &&
        dataISO(parto.casal.dtEncerramento) === dataAntiga
      ) {
        await tx.casal.update({
          where: { id: parto.casal.id },
          data: { dtEncerramento: paraData(dados.dtPartoReal), dtManutencao: agora() },
        })
      }
    }

    // A correcao tem a data em que os animais passam a ser como ela diz: o nascimento, para a troca
    // de sexo, o registro anulado e os a mais que nascem na caixa do casal; a chegada, para os a
    // mais numa caixa de estoque, que entram nela com a ninhada. Datas diferentes, ocorrencias
    // diferentes: a trilha conta a caixa de estoque desde a primeira chegada nela
    // (exigirEstoqueQueRecebe), e uma correcao datada do nascimento a faria existir antes disso
    const correcao = {
      tipo: 'correcao',
      idUsuario,
      idParto,
      motivo: dados.motivo ?? MOTIVO_DO_SISTEMA.nascimento,
    } as const
    // os a mais que ficam onde nasceram, sem chegada, vao com a troca de sexo e a anulacao
    const ondeNasceram =
      novos !== null && novos.chegada === null ? { idCaixa: novos.idCaixa, ...plano.novos, chegam: false } : undefined

    if (trocados.length + anulados.length > 0 || ondeNasceram !== undefined) {
      await lancarOcorrencia(tx, {
        ...correcao,
        dtFato: dados.dtPartoReal,
        trocaDeSexo: troca === null ? undefined : { ids: trocados.map((animal) => animal.id), para: troca.para },
        anulados: anulados.map((animal) => animal.id),
        novos: ondeNasceram,
      })
    }

    if (novos !== null && novos.chegada !== null) {
      await lancarOcorrencia(tx, {
        ...correcao,
        dtFato: novos.chegada,
        novos: { idCaixa: novos.idCaixa, ...plano.novos, chegam: true },
      })
    }

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: idParto,
      acao: 'correcao_nascimento',
      descricao: descricaoDaCorrecao(
        `Correção do ${parto.ordem}º parto`,
        [
          dePara(dataLegivel(dataAntiga), dataLegivel(dados.dtPartoReal), 'nascimento'),
          dePara(quantosAnimais(nascidos), quantosAnimais({ m: dados.nascidoM, f: dados.nascidoF }), 'contagem'),
        ],
        dados.motivo,
      ),
      dados: {
        ...comMotivo(dados.motivo),
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

/** O parto seguinte, como a correcao do nascimento le. Do mesmo casal: tem sempre o acasalamento */
type PartoSeguinte = { id: number; dtAcasalamento: Date | null; dtPartoReal: Date | null; dtSemNinhada: Date | null }

/**
 * O acasalamento seguinte que acompanha a correcao da data do nascimento: o que o sistema abriu
 * (exatamente 6 dias depois do parto) e ainda esta pendente. O que foi corrigido a mao, o que ja
 * deu parto e o que fechou sem ninhada nao acompanham. Null quando nao acompanha ou a data nao muda
 */
export function acasalamentoQueAcompanha(
  seguinte: PartoSeguinte | null,
  nascimentoAntes: string,
  nascimentoDepois: string,
): { idParto: number; antes: string; depois: string } | null {
  if (seguinte === null || seguinte.dtPartoReal !== null || seguinte.dtSemNinhada !== null) return null
  if (seguinte.dtAcasalamento === null || nascimentoAntes === nascimentoDepois) return null

  const antes = dataISO(seguinte.dtAcasalamento)
  if (antes !== calcularProximoCiclo(nascimentoAntes).dtAcasalamento) return null

  return { idParto: seguinte.id, antes, depois: calcularProximoCiclo(nascimentoDepois).dtAcasalamento }
}

// ------------------------------------------------------------ desmame

/** Os que chegaram vivos ao desmame no dia dado: os nascidos menos os mortos ate ele, como a ficha conta */
function desmamadosNoDia(animais: AnimalDoParto[], dtDesmame: string): PorSexo {
  return contarDoParto(paraData(dtDesmame), animais).desmamados ?? { m: 0, f: 0 }
}

export type CorrecaoDoDesmame = MotivoOpcional<{
  dtDesmameReal: string
  /** A contagem certa de um sexo ou dos dois; o sexo que nao vem fica como a data deixar */
  desmamadoM?: number | undefined
  desmamadoF?: number | undefined
  /** De qual pedido saem os reservados que passam a nao ter chegado ao desmame */
  idPedido?: number | undefined
}>

/**
 * PATCH /api/partos/:id/desmame - corrige a data e a contagem do desmame. A data fica nos mesmos
 * limites do registro (exigirDataDoDesmame); a baixa 'nao chegou ao desmame' acompanha a data, e a
 * eutanasia de selecao que ficaria depois dela passa para ela (levarSelecoesParaODesmame).
 *
 * A contagem e a dos que chegaram vivos ao desmame, e a baixa 'nao chegou ao desmame' e a diferenca:
 * corrigir a contagem e corrigir essa baixa (corrigirContagemDoDesmame), depois da data. O sexo que
 * nao vem no corpo fica como a data nova deixar
 */
export async function corrigirDesmame(idParto: number, dados: CorrecaoDoDesmame, idUsuario: number) {
  const faltas = await prisma.$transaction(async (tx) => {
    // a contagem pode anular a baixa do desmame: ela e travada antes do casal e do parto, na ordem
    // das travas (colonia/travas.ts), e lida de novo depois deles
    const previa = await baixaDoParto(tx, idParto, MOTIVO_NAO_CHEGOU_AO_DESMAME, 'asc')
    if (previa !== null) await travarOcorrencia(tx, previa.id)

    const parto = await travarELerParto(tx, idParto)

    if (parto.dtDesmameReal === null || parto.dtPartoReal === null) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', 'O desmame deste parto ainda não foi registrado.')
    }

    // a caixa do casal, de onde a contagem tira ou para onde ela devolve animais, antes dos animais
    await travarCaixas(tx, [parto.casal.idCaixa])

    await exigirDataDoDesmame(tx, parto, dados.dtDesmameReal)

    const naoChegaram = await baixaDoParto(tx, idParto, MOTIVO_NAO_CHEGOU_AO_DESMAME, 'asc')

    if ((naoChegaram?.id ?? null) !== (previa?.id ?? null)) {
      throw erroDeRegra(
        'SEQUENCIA_INVALIDA',
        'O desmame deste parto mudou durante a correção. Atualize a tela e tente de novo.',
      )
    }

    const motivo = dados.motivo ?? MOTIVO_DO_SISTEMA.desmame
    const antes = dataISO(parto.dtDesmameReal)
    const desmamadosAntes = desmamadosNoDia(await animaisDoParto(tx, idParto), antes)
    let selecoes: SelecoesLevadas = { ids: [], datas: [] }

    if (dados.dtDesmameReal !== antes) {
      await tx.parto.update({
        where: { id: idParto },
        data: { dtDesmameReal: paraData(dados.dtDesmameReal), dtManutencao: agora() },
      })

      if (naoChegaram !== null) {
        await tx.ocorrencia.update({
          where: { id: naoChegaram.id },
          data: { dtFato: paraData(dados.dtDesmameReal) },
        })
      }

      // a selecao e antes do desmame: a que ficou depois da data nova vai com ele
      selecoes = await levarSelecoesParaODesmame(tx, idParto, dados.dtDesmameReal)
      const comSaidaNova = [...(naoChegaram?.animais.map((ligacao) => ligacao.idAnimal) ?? []), ...selecoes.ids]

      if (comSaidaNova.length > 0) {
        await lancarOcorrencia(tx, {
          tipo: 'correcao',
          dtFato: dados.dtDesmameReal,
          idUsuario,
          idParto,
          motivo,
          novaSaida: { ids: comSaidaNova, dtSaida: dados.dtDesmameReal },
        })
      }
    }

    const contagem = await corrigirContagemDoDesmame(tx, parto, naoChegaram, dados, { motivo, idUsuario })

    if (dados.dtDesmameReal === antes && contagem.escolhidos === null) return []

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: idParto,
      acao: 'correcao_desmame',
      descricao: descricaoDaCorrecao(
        `Correção do desmame do ${parto.ordem}º parto`,
        [
          dePara(dataLegivel(antes), dataLegivel(dados.dtDesmameReal)),
          selecoesQuePassaram(selecoes, dados.dtDesmameReal),
          dePara(quantosAnimais(desmamadosAntes), quantosAnimais(contagem.nova), 'contagem'),
        ],
        dados.motivo,
      ),
      dados: {
        ...comMotivo(dados.motivo),
        antes: {
          dtDesmameReal: antes,
          desmamadoM: desmamadosAntes.m,
          desmamadoF: desmamadosAntes.f,
          ...(selecoes.datas.length === 0 ? {} : { dtSelecoes: selecoes.datas }),
        },
        depois: {
          dtDesmameReal: dados.dtDesmameReal,
          desmamadoM: contagem.nova.m,
          desmamadoF: contagem.nova.f,
          ...(selecoes.datas.length === 0 ? {} : { dtSelecoes: [dados.dtDesmameReal] }),
        },
      },
    })

    // o casal encerrado: a contagem que baixou os ultimos animais da caixa a libera
    if (!parto.casal.ativo) {
      await liberarSeVazia(tx, parto.casal.idCaixa, dados.dtDesmameReal, 'baixa', idUsuario)
    }

    return faltasDosPedidos(tx, pedidosTocados(contagem.escolhidos ?? []))
  })

  return { parto: await cicloFicha(idParto), faltas }
}

/**
 * A contagem do desmame corrigida, ja na data certa: quantos chegaram vivos ao desmame. Ela so muda
 * pela baixa 'nao chegou ao desmame', que e a diferenca: sobe desfazendo animais dessa baixa, desce
 * lancando nela vivos do parto que continuam na caixa do casal (quem passou para o estoque, foi
 * entregue ou morreu depois chegou ao desmame). A baixa muda anulando a de antes e lancando a certa
 * (anularParaCorrigir, baixarDoParto), e para isso os animais dela voltam para a caixa do casal: se
 * ela nao serve mais para eles (liberada, com outra ninhada), a contagem nao muda. As outras baixas
 * antes do desmame (a selecao, as mortes no aleitamento) se corrigem cada uma (corrigirBaixa).
 * 'escolhidos' e null quando a contagem nao muda
 */
async function corrigirContagemDoDesmame(
  tx: Transacao,
  parto: PartoTravado,
  naoChegaram: { id: number; animais: { idAnimal: number }[] } | null,
  dados: CorrecaoDoDesmame,
  lancamento: { motivo: string; idUsuario: number },
): Promise<{ nova: PorSexo; escolhidos: Escolhido[] | null }> {
  const dtDesmame = dados.dtDesmameReal
  const animais = await animaisDoParto(tx, parto.id)
  const atual = desmamadosNoDia(animais, dtDesmame)
  const nova = { m: dados.desmamadoM ?? atual.m, f: dados.desmamadoF ?? atual.f }

  if (nova.m === atual.m && nova.f === atual.f) return { nova, escolhidos: null }

  const daBaixa = new Set(naoChegaram?.animais.map((ligacao) => ligacao.idAnimal) ?? [])
  const naBaixa = contarPorSexo(animais.filter((animal) => daBaixa.has(animal.id)))
  // a baixa certa: a de antes mais o que a contagem desce, ou menos o que ela sobe
  const certa = { m: naBaixa.m + atual.m - nova.m, f: naBaixa.f + atual.f - nova.f }
  const sobeDemais = { m: certa.m < 0, f: certa.f < 0 }

  if (sobeDemais.m || sobeDemais.f) {
    throw contagemInvalida(
      'desmamado',
      sobeDemais,
      `A contagem do desmame só sobe desfazendo a baixa "não chegou ao desmame" (${quantosAnimais(naBaixa)}): no máximo ${quantosAnimais({ m: atual.m + naBaixa.m, f: atual.f + naBaixa.f })}. As outras baixas antes do desmame se corrigem uma a uma, na seção Baixas.`,
    )
  }

  const naCaixa = contarPorSexo(
    animais.filter((animal) => animal.situacao === 'vivo' && animal.idCaixa === parto.casal.idCaixa),
  )
  const desceDemais = { m: certa.m - naBaixa.m > naCaixa.m, f: certa.f - naBaixa.f > naCaixa.f }

  if (desceDemais.m || desceDemais.f) {
    throw contagemInvalida(
      'desmamado',
      desceDemais,
      `Só os vivos que continuam na caixa do casal (${quantosAnimais(naCaixa)}) passam a não ter chegado ao desmame: no mínimo ${quantosAnimais({ m: atual.m - naCaixa.m, f: atual.f - naCaixa.f })}. Quem passou para o estoque, foi entregue ou morreu depois do desmame chegou a ele.`,
    )
  }

  const baixa = naoChegaram === null ? null : await lerBaixaAnulavel(tx, naoChegaram.id)
  await travarCaixas(tx, [parto.casal.idCaixa, ...(baixa === null ? [] : [baixa.idCaixaOrigem])])

  if (baixa !== null) {
    await anularParaCorrigir(
      tx,
      baixa,
      await lerCaixaDaBaixa(tx, baixa.idCaixaOrigem),
      lancamento,
      (caixa, estado) =>
        `A caixa ${caixa} ${estado}: os animais que não chegaram ao desmame não voltam para ela, e a contagem do desmame não muda mais.`,
    )
  }

  const escolhidos = await baixarDoParto(tx, parto, certa, {
    campo: 'dtDesmameReal',
    dtFato: dtDesmame,
    // quem nao chegou ao desmame morreu no aleitamento
    causa: 'morte',
    motivo: MOTIVO_NAO_CHEGOU_AO_DESMAME,
    idPedido: dados.idPedido,
    idUsuario: lancamento.idUsuario,
  })

  return { nova, escolhidos }
}

// ------------------------------------------------------------ fechamento sem ninhada

export type CorrecaoDoSemNinhada = { dtSemNinhada: string; motivo: string }

/**
 * PATCH /api/partos/:id/sem-ninhada - corrige a data e o motivo do fechamento sem ninhada. O motivo
 * aqui e o dado do fechamento (por que o parto nao nasceu), e nao o da correcao. A data fica depois
 * do acasalamento e do encerramento do casal, como no registro, e nunca depois da liberacao da caixa
 * do casal: a caixa que o fechamento liberou ficou vazia no dia dele ou depois
 */
export async function corrigirSemNinhada(idParto: number, dados: CorrecaoDoSemNinhada, idUsuario: number) {
  await prisma.$transaction(async (tx) => {
    const parto = await travarELerParto(tx, idParto)

    if (parto.dtSemNinhada === null) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', 'Este parto não foi fechado sem ninhada.')
    }

    const caixa = await tx.caixa.findUnique({ where: { id: parto.casal.idCaixa }, select: { dtLiberacao: true } })

    exigirOrdem('dtSemNinhada', dados.dtSemNinhada, {
      depoisDe: [
        { evento: 'do acasalamento', data: parto.dtAcasalamento },
        { evento: 'do encerramento do casal', data: parto.casal.dtEncerramento },
      ],
      antesDe: [{ evento: 'da liberação da caixa do casal', data: caixa?.dtLiberacao }],
    })

    const antes = { dtSemNinhada: dataISO(parto.dtSemNinhada), motivo: parto.motivoSemNinhada ?? '' }
    if (antes.dtSemNinhada === dados.dtSemNinhada && antes.motivo === dados.motivo) return

    await tx.parto.update({
      where: { id: idParto },
      data: { dtSemNinhada: paraData(dados.dtSemNinhada), motivoSemNinhada: dados.motivo, dtManutencao: agora() },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: idParto,
      acao: 'correcao_sem_ninhada',
      descricao: descricaoDaCorrecao(`Correção do fechamento sem ninhada do ${parto.ordem}º parto`, [
        dePara(dataLegivel(antes.dtSemNinhada), dataLegivel(dados.dtSemNinhada)),
        dePara(`"${antes.motivo}"`, `"${dados.motivo}"`, 'motivo'),
      ]),
      dados: { antes, depois: { ...dados } },
    })
  })

  return cicloFicha(idParto)
}

// ------------------------------------------------------------ baixa

export type CorrecaoDaBaixa = MotivoOpcional<{
  dtFato: string
  /** morte ou eutanasia */
  tipo: CausaDaBaixa
  /** quantos machos e quantas femeas ficam na baixa */
  qtdM: number
  qtdF: number
  /** De qual pedido saem os reservados quando a baixa leva mais animais e os livres nao bastam */
  idPedido?: number | undefined
}>

/**
 * O motivo da baixa corrigida, o texto que a trilha mostra. A eutanasia no aleitamento e o ajuste
 * de ninhada, a selecao do parto, como o registro grava; fora dele, o nome da causa. O motivo
 * escrito no registro fica, se nao era so o nome da causa de antes
 */
function motivoDaBaixa(baixa: BaixaAnulavel, tipo: CausaDaBaixa, selecao: boolean): string {
  if (selecao) return MOTIVO_SELECAO

  const doSistema =
    baixa.motivo === null || baixa.motivo === MOTIVO_SELECAO || baixa.motivo === MOTIVO_DO_TIPO[causaDe(baixa.causa)]

  return doSistema ? MOTIVO_DO_TIPO[tipo] : (baixa.motivo ?? MOTIVO_DO_TIPO[tipo])
}

/** Os animais do parto na forma que a conferencia da data le: a chegada e o nascimento */
function comoEscolhido(animal: AnimalDoParto, idPedido: number | null, dtNascimento: Date): Escolhido {
  return { id: animal.id, idCaixa: animal.idCaixa, idPedido, dtMovimento: animal.dtMovimento, dtNascimento }
}

/**
 * PATCH /api/partos/:id/baixas/:idOcorrencia - corrige uma baixa dos animais do parto: a data, a
 * causa e quantos de cada sexo. A eutanasia no aleitamento (ate o desmame, ou sem desmame ainda) e o
 * ajuste de ninhada, a selecao do parto; fora dele, a baixa e a comum, como o registro faz.
 *
 * Com a mesma contagem, os mesmos animais: a baixa muda no lugar e a saida deles acompanha a data
 * por uma ocorrencia de correcao, como no desmame. Com outra contagem, anula a baixa e lanca a certa
 * na mesma transacao: os animais voltam vivos para a caixa da baixa, na data dela (anularParaCorrigir),
 * e a baixa nova leva primeiro os mesmos, os livres antes dos reservados, e, se pede mais, outros
 * vivos do parto na caixa, livres primeiro. Nunca mais animais do que a baixa e os vivos do parto na
 * caixa. A data nao fica antes do nascimento nem da chegada dos animais na caixa, nem depois da
 * liberacao dela; na caixa do casal, nem depois do parto seguinte, que so nasce com a caixa sem a
 * ninhada de antes. A baixa 'nao chegou ao desmame' e a diferenca do desmame, e se corrige pela
 * contagem dele (corrigirDesmame)
 */
export async function corrigirBaixa(
  idParto: number,
  idOcorrencia: number,
  dados: CorrecaoDaBaixa,
  idUsuario: number,
) {
  const faltas = await prisma.$transaction(async (tx) => {
    // a baixa primeiro, depois o casal, o parto e a caixa: a ordem das travas (colonia/travas.ts)
    await travarOcorrencia(tx, idOcorrencia)
    const baixa = await lerBaixaAnulavel(tx, idOcorrencia)

    const deOutro = baixa.animais.filter((animal) => animal.idParto !== idParto).length

    if (deOutro === baixa.animais.length) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', 'Esta baixa não é deste parto. Atualize a tela e tente de novo.')
    }

    if (deOutro > 0) {
      throw erroDeRegra(
        'SEQUENCIA_INVALIDA',
        'Esta baixa leva também animais de outra ninhada e não se corrige pela ficha deste parto. Exclua a baixa e lance de novo a de cada ninhada.',
      )
    }

    if (baixa.motivo === MOTIVO_NAO_CHEGOU_AO_DESMAME) {
      throw erroDeRegra(
        'SEQUENCIA_INVALIDA',
        'Esta baixa é a diferença entre os vivos e os desmamados: corrija a contagem do desmame, e ela acompanha.',
      )
    }

    const parto = await travarELerParto(tx, idParto)
    const seguinte = await tx.parto.findFirst({
      where: { idCasal: parto.idCasal, ordem: parto.ordem + 1 },
      select: { ordem: true, dtPartoReal: true },
    })

    await travarCaixas(tx, [baixa.idCaixaOrigem])
    const origem = await lerCaixaDaBaixa(tx, baixa.idCaixaOrigem)

    const antes = { dtFato: dataISO(baixa.dtFato), tipo: causaDe(baixa.causa), ...contarPorSexo(baixa.animais) }
    const nova = { m: dados.qtdM, f: dados.qtdF }
    const mesmaContagem = antes.m === nova.m && antes.f === nova.f

    if (mesmaContagem && antes.dtFato === dados.dtFato && antes.tipo === dados.tipo) return []

    exigirOrdem('dtFato', dados.dtFato, {
      antesDe: [
        { evento: 'da liberação da caixa', data: origem.dtLiberacao },
        {
          evento: `do ${seguinte?.ordem}º parto, que nasceu na mesma caixa`,
          data: origem.id === parto.casal.idCaixa ? seguinte?.dtPartoReal : null,
        },
      ],
    })

    // a eutanasia da ninhada na caixa do casal, ate o desmame, e o ajuste de ninhada
    const dtDesmame = parto.dtDesmameReal === null ? null : dataISO(parto.dtDesmameReal)
    const selecao =
      dados.tipo === 'eutanasia' &&
      origem.id === parto.casal.idCaixa &&
      (dtDesmame === null || dados.dtFato <= dtDesmame)
    const motivoNovo = motivoDaBaixa(baixa, dados.tipo, selecao)
    const motivo = dados.motivo ?? MOTIVO_DO_SISTEMA.baixa
    const animais = await animaisDoParto(tx, idParto)
    // os animais do parto tem o nascimento dele
    const nascimento = parto.dtPartoReal ?? baixa.dtFato
    // os animais que a baixa nova tira de um pedido: os pedidos deles podem ficar em falta
    let tocados: Escolhido[] = []

    if (mesmaContagem) {
      const daBaixa = new Set(baixa.animais.map((animal) => animal.id))
      const mesmos = animais
        .filter((animal) => daBaixa.has(animal.id))
        .map((animal) => comoEscolhido(animal, animal.idPedido, nascimento))
      exigirDepoisDaChegada('dtFato', dados.dtFato, mesmos)

      await tx.ocorrencia.update({
        where: { id: baixa.id },
        data: {
          dtFato: paraData(dados.dtFato),
          causa: dados.tipo,
          motivo: motivoNovo,
          idParto: selecao ? idParto : null,
        },
      })

      if (dados.dtFato !== antes.dtFato) {
        await lancarOcorrencia(tx, {
          tipo: 'correcao',
          dtFato: dados.dtFato,
          idUsuario,
          idParto,
          motivo,
          novaSaida: { ids: mesmos.map((animal) => animal.id), dtSaida: dados.dtFato },
        })
      }
    } else {
      // nunca mais do que ha: os da baixa e os vivos do parto que estao na caixa dela
      const vivosAqui = contarPorSexo(
        animais.filter((animal) => animal.situacao === 'vivo' && animal.idCaixa === origem.id),
      )
      const maximo = { m: antes.m + vivosAqui.m, f: antes.f + vivosAqui.f }
      const passou = { m: nova.m > maximo.m, f: nova.f > maximo.f }

      if (passou.m || passou.f) {
        throw contagemInvalida(
          'qtd',
          passou,
          `Não pode passar de ${quantosAnimais(maximo)}: os desta baixa e os vivos deste parto na caixa ${origem.codigo}.`,
        )
      }

      const voltaram = await anularParaCorrigir(
        tx,
        baixa,
        origem,
        { motivo, idUsuario },
        (caixa, estado) =>
          `A caixa ${caixa} ${estado}: os animais desta baixa não voltam para ela, e a contagem da baixa não muda mais. Corrija só a data e a causa, ou exclua a baixa.`,
      )
      const doParto = new Map(animais.map((animal) => [animal.id, animal]))
      const escolhidos: Escolhido[] = []

      for (const sexo of SEXOS) {
        const quantos = doSexo(nova, sexo)
        // os mesmos animais primeiro, os livres antes dos reservados
        const mesmos = voltaram
          .filter((animal) => animal.sexo === sexo)
          .sort((a, b) => Number(a.idPedido !== null) - Number(b.idPedido !== null) || a.id - b.id)
          .slice(0, quantos)
          .flatMap((animal) => {
            const lido = doParto.get(animal.id)
            return lido === undefined ? [] : [comoEscolhido(lido, animal.idPedido, nascimento)]
          })

        escolhidos.push(
          ...mesmos,
          ...(await escolherAnimais(tx, { idCaixa: origem.id, idParto, sexo }, quantos - mesmos.length, {
            idPedido: dados.idPedido,
            excluir: voltaram.map((animal) => animal.id),
          })),
        )
      }

      exigirDepoisDaChegada('dtFato', dados.dtFato, escolhidos)

      await lancarOcorrencia(tx, {
        tipo: 'baixa',
        causa: dados.tipo,
        dtFato: dados.dtFato,
        idUsuario,
        idCaixa: origem.id,
        idParto: selecao ? idParto : undefined,
        motivo: motivoNovo,
        ids: escolhidos.map((animal) => animal.id),
      })

      await liberarSeVazia(tx, origem.id, dados.dtFato, 'baixa', idUsuario)
      tocados = escolhidos
    }

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: idParto,
      acao: 'correcao_baixa',
      descricao: descricaoDaCorrecao(
        `Correção da baixa de ${dataLegivel(antes.dtFato)} do ${parto.ordem}º parto`,
        [
          dePara(dataLegivel(antes.dtFato), dataLegivel(dados.dtFato), 'data'),
          dePara(MOTIVO_DO_TIPO[antes.tipo], MOTIVO_DO_TIPO[dados.tipo], 'causa'),
          dePara(quantosAnimais(antes), quantosAnimais(nova), 'contagem'),
        ],
        dados.motivo,
      ),
      dados: {
        ...comMotivo(dados.motivo),
        idOcorrencia,
        antes: { dtFato: antes.dtFato, causa: antes.tipo, qtdM: antes.m, qtdF: antes.f },
        depois: { dtFato: dados.dtFato, causa: dados.tipo, qtdM: nova.m, qtdF: nova.f },
      },
    })

    return faltasDosPedidos(tx, pedidosTocados(tocados))
  })

  return { parto: await cicloFicha(idParto), faltas }
}
