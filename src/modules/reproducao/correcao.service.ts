import { ErroDeAplicacao, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { MAX_PARTOS_POR_CASAL } from '../../shared/parametros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, paraData } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { calcularDesmamePrevisto } from './cadeiaTemporal.ts'
import { compromissosAtivosComPedido, faltaNaReserva, separarEntregues } from './disponibilidade.ts'
import { noEstoque } from '../infra/estoque.ts'
import type { ContagemDoCiclo } from './disponibilidade.ts'
import { cicloFicha, contagemInvalida } from './reproducao.service.ts'
import type { Desmame, Nascimento, Selecao } from './reproducao.service.ts'

export type ComMotivo<T> = T & { motivo: string }

async function partoParaCorrigir(idParto: number) {
  const parto = await prisma.parto.findUnique({
    where: { id: idParto },
    include: {
      compromissos: compromissosAtivosComPedido,
      lotes: { select: { qtd: true, caixa: { select: { sexo: true } } } },
      casal: { select: { id: true, dtEncerramento: true } },
    },
  })

  if (parto === null) {
    throw naoEncontrado('Parto')
  }

  return parto
}

/** O aviso da correcao que deixa a ninhada com menos animais do que o reservado. A correcao grava */
function alertaDeCompromisso(
  contagem: ContagemDoCiclo,
  compromissos: { qtdM: number; qtdF: number; remessa: { idSolicitacao: number } }[],
): string | null {
  const falta = faltaNaReserva({ ...contagem, compromissos })

  if (falta === null) return null

  const pedidos = falta.pedidos
    .map((pedido) => `#${pedido.idSolicitacao} (${pedido.m} M, ${pedido.f} F)`)
    .join(', ')

  return `A ninhada ficou com menos animais do que o reservado: faltam ${falta.m} M e ${falta.f} F. Pedidos com reserva nela: ${pedidos}. Na lista de solicitacoes, o pedido em falta pode ser devolvido para analise.`
}

function contagemDo(parto: ContagemDoCiclo): ContagemDoCiclo {
  return {
    nascidoM: parto.nascidoM,
    nascidoF: parto.nascidoF,
    eutanasiadoM: parto.eutanasiadoM,
    eutanasiadoF: parto.eutanasiadoF,
    desmamadoM: parto.desmamadoM,
    desmamadoF: parto.desmamadoF,
  }
}

export async function corrigirNascimento(
  idParto: number,
  dados: ComMotivo<Nascimento>,
  idUsuario: number,
) {
  const parto = await partoParaCorrigir(idParto)

  if (parto.dtPartoReal === null || parto.nascidoM === null || parto.nascidoF === null) {
    throw erroDeRegra(
      'SEQUENCIA_INVALIDA',
      'Este parto ainda nao foi registrado: registre antes de corrigir.',
    )
  }

  const vivosM = dados.nascidoM - (parto.eutanasiadoM ?? 0)
  const vivosF = dados.nascidoF - (parto.eutanasiadoF ?? 0)
  const nascidoAbaixo = {
    m: vivosM < (parto.desmamadoM ?? 0) || vivosM < 0,
    f: vivosF < (parto.desmamadoF ?? 0) || vivosF < 0,
  }

  if (nascidoAbaixo.m || nascidoAbaixo.f) {
    throw contagemInvalida(
      'nascido',
      nascidoAbaixo,
      'O nascido nao pode ficar abaixo da eutanasia e do desmame ja registrados.',
    )
  }

  const dataAntiga = dataISO(parto.dtPartoReal)
  const mudouData = dados.dtPartoReal !== dataAntiga

  const novaContagem = { ...contagemDo(parto), nascidoM: dados.nascidoM, nascidoF: dados.nascidoF }

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
      },
    })

    if (
      mudouData &&
      parto.ordem >= MAX_PARTOS_POR_CASAL &&
      parto.casal.dtEncerramento !== null &&
      dataISO(parto.casal.dtEncerramento) === dataAntiga
    ) {
      await tx.casal.update({
        where: { id: parto.casal.id },
        data: { dtEncerramento: paraData(dados.dtPartoReal) },
      })
    }

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: idParto,
      acao: 'correcao_nascimento',
      descricao: `Correcao do ${parto.ordem}o parto: ${dados.motivo}`,
      dados: {
        motivo: dados.motivo,
        antes: { dtPartoReal: dataAntiga, nascidoM: parto.nascidoM, nascidoF: parto.nascidoF },
        depois: {
          dtPartoReal: dados.dtPartoReal,
          nascidoM: dados.nascidoM,
          nascidoF: dados.nascidoF,
        },
      },
    })
  })

  return {
    parto: await cicloFicha(idParto),
    alerta: alertaDeCompromisso(novaContagem, parto.compromissos),
  }
}

export async function corrigirSelecao(
  idParto: number,
  dados: ComMotivo<Selecao>,
  idUsuario: number,
) {
  const parto = await partoParaCorrigir(idParto)

  if (
    parto.dtSelecao === null ||
    parto.dtPartoReal === null ||
    parto.nascidoM === null ||
    parto.nascidoF === null
  ) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'A eutanasia deste parto ainda nao foi registrada.')
  }

  const vivosM = parto.nascidoM - dados.eutanasiadoM
  const vivosF = parto.nascidoF - dados.eutanasiadoF

  if (vivosM < 0 || vivosF < 0) {
    throw contagemInvalida(
      'eutanasiado',
      { m: vivosM < 0, f: vivosF < 0 },
      `Nao pode passar do nascido (${parto.nascidoM} M, ${parto.nascidoF} F).`,
    )
  }

  const abaixoDoDesmame = {
    m: vivosM < (parto.desmamadoM ?? 0),
    f: vivosF < (parto.desmamadoF ?? 0),
  }

  if (abaixoDoDesmame.m || abaixoDoDesmame.f) {
    throw contagemInvalida(
      'eutanasiado',
      abaixoDoDesmame,
      'Com essa eutanasia sobrariam menos animais do que os ja desmamados.',
    )
  }

  const selecaoAntiga = dataISO(parto.dtSelecao)
  const novaContagem = {
    ...contagemDo(parto),
    eutanasiadoM: dados.eutanasiadoM,
    eutanasiadoF: dados.eutanasiadoF,
  }

  await prisma.$transaction(async (tx) => {
    await tx.parto.update({
      where: { id: idParto },
      data: {
        dtSelecao: paraData(dados.dtSelecao),
        eutanasiadoM: dados.eutanasiadoM,
        eutanasiadoF: dados.eutanasiadoF,
      },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: idParto,
      acao: 'correcao_selecao',
      descricao: `Correcao da eutanasia do ${parto.ordem}o parto: ${dados.motivo}`,
      dados: {
        motivo: dados.motivo,
        antes: {
          dtSelecao: selecaoAntiga,
          eutanasiadoM: parto.eutanasiadoM,
          eutanasiadoF: parto.eutanasiadoF,
        },
        depois: {
          dtSelecao: dados.dtSelecao,
          eutanasiadoM: dados.eutanasiadoM,
          eutanasiadoF: dados.eutanasiadoF,
        },
      },
    })
  })

  return {
    parto: await cicloFicha(idParto),
    alerta: alertaDeCompromisso(novaContagem, parto.compromissos),
  }
}

export async function corrigirDesmame(
  idParto: number,
  dados: ComMotivo<Desmame>,
  idUsuario: number,
) {
  const parto = await partoParaCorrigir(idParto)

  if (
    parto.dtDesmameReal === null ||
    parto.dtPartoReal === null ||
    parto.nascidoM === null ||
    parto.nascidoF === null
  ) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'O desmame deste parto ainda nao foi registrado.')
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

  // o que ja saiu da caixa do casal (entregue ou na caixa de estoque) aconteceu: o desmame nao
  // fica abaixo disso
  const { entregue } = separarEntregues(parto.compromissos)
  const estoque = noEstoque(parto)
  const saiu = { m: entregue.m + estoque.m, f: entregue.f + estoque.f }
  const abaixo = { m: dados.desmamadoM < saiu.m, f: dados.desmamadoF < saiu.f }

  if (abaixo.m || abaixo.f) {
    throw contagemInvalida(
      'desmamado',
      abaixo,
      `Nao pode ficar abaixo do que ja saiu da caixa do casal, entregue ou no estoque (${saiu.m} M, ${saiu.f} F).`,
    )
  }

  const desmameAntigo = dataISO(parto.dtDesmameReal)
  const novaContagem = {
    ...contagemDo(parto),
    desmamadoM: dados.desmamadoM,
    desmamadoF: dados.desmamadoF,
  }

  await prisma.$transaction(async (tx) => {
    await tx.parto.update({
      where: { id: idParto },
      data: {
        dtDesmameReal: paraData(dados.dtDesmameReal),
        desmamadoM: dados.desmamadoM,
        desmamadoF: dados.desmamadoF,
      },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: idParto,
      acao: 'correcao_desmame',
      descricao: `Correcao do desmame do ${parto.ordem}o parto: ${dados.motivo}`,
      dados: {
        motivo: dados.motivo,
        antes: {
          dtDesmameReal: desmameAntigo,
          desmamadoM: parto.desmamadoM,
          desmamadoF: parto.desmamadoF,
        },
        depois: {
          dtDesmameReal: dados.dtDesmameReal,
          desmamadoM: dados.desmamadoM,
          desmamadoF: dados.desmamadoF,
        },
      },
    })
  })

  return {
    parto: await cicloFicha(idParto),
    alerta: alertaDeCompromisso(novaContagem, parto.compromissos),
  }
}
