// O cadastro inicial do estoque: os ratos que a colonia ja tinha antes do Nidus, de idade
// conhecida e casal desconhecido. Entram numa caixa de estoque como uma ninhada sem casal
// (reproducao.parto sem casal, ordem e acasalamento), com o nascimento informado e ja desmamada
// no dia do cadastro, porque estoque e de desmamados. A trilha ganha a ocorrencia 'entrada' com os
// animais, e e ela que a tela Historico mostra ("Entrada de 6 machos Wistar nascidos em ... na
// caixa F2A (cadastro inicial)")

import type { Prisma } from '@prisma/client'
import { campoInvalido, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { IDADE_MINIMA_DO_ESTOQUE_DIAS } from '../../shared/parametros.ts'
import { prisma } from '../../shared/prisma.ts'
import { agora } from '../../shared/relogio.ts'
import { dataLegivel, hojeISO, paraData } from '../../shared/traducao.ts'
import { caixaLiberada } from '../colonia/liberacao.ts'
import { lancarOcorrencia } from '../colonia/ocorrencia.ts'
import { noNumero } from '../colonia/tipos.ts'
import type { Sexo } from '../colonia/tipos.ts'
import { travarCaixas } from '../colonia/travas.ts'
import { diasEntre, somarDias } from '../reproducao/cadeiaTemporal.ts'
import { exigirPosicaoVazia } from './posicao.ts'
import type { PosicaoNaEstante } from './posicao.ts'

type Transacao = Prisma.TransactionClient

/** Um grupo de idade que entra: quantos e quando nasceram ('aaaa-mm-dd') */
export type Entrada = { quantidade: number; dtNascimento: string }

/** A caixa de estoque nova do cadastro inicial, numa posicao vazia, com o primeiro grupo de idade */
export type CaixaDeEstoqueNova = Entrada & {
  posicao: PosicaoNaEstante
  idLinhagem: number
  sexo: Sexo
}

/**
 * A idade no dia da entrada: estoque e de desmamados, entao nasceu ha pelo menos
 * IDADE_MINIMA_DO_ESTOQUE_DIAS dias. Mensagem no campo do nascimento
 */
export function exigirIdadeDoEstoque(dtNascimento: string, hoje: string): void {
  const idade = diasEntre(dtNascimento, hoje)
  if (idade >= IDADE_MINIMA_DO_ESTOQUE_DIAS) return

  const ateQuando = dataLegivel(somarDias(hoje, -IDADE_MINIMA_DO_ESTOQUE_DIAS))

  throw campoInvalido(
    'dtNascimento',
    `Nascidos em ${dataLegivel(dtNascimento)}, os animais têm ${idade} ${noNumero(idade, 'dia', 'dias')}: a caixa de estoque só recebe desmamados, com ${IDADE_MINIMA_DO_ESTOQUE_DIAS} dias ou mais (nascidos até ${ateQuando}).`,
  )
}

/**
 * Cria a ninhada sem casal (nascimento informado, desmame no dia da entrada) e poe os animais
 * vivos na caixa de estoque, ja travada, com a ocorrencia de entrada. Quem cadastra fica como quem
 * registrou o nascimento e o desmame
 */
async function lancarEntrada(
  tx: Transacao,
  entrada: Entrada & { idCaixa: number; idLinhagem: number; sexo: Sexo; dtEntrada: string; idUsuario: number },
) {
  const registro = agora()
  const ninhada = await tx.parto.create({
    data: {
      idLinhagem: entrada.idLinhagem,
      dtPartoReal: paraData(entrada.dtNascimento),
      dtDesmameReal: paraData(entrada.dtEntrada),
      idUsuarioParto: entrada.idUsuario,
      dtRegistroParto: registro,
      idUsuarioDesmame: entrada.idUsuario,
      dtRegistroDesmame: registro,
    },
    select: { id: true },
  })

  return lancarOcorrencia(tx, {
    tipo: 'entrada',
    dtFato: entrada.dtEntrada,
    idUsuario: entrada.idUsuario,
    idParto: ninhada.id,
    idCaixa: entrada.idCaixa,
    entrantes: entrada.sexo === 'M' ? { m: entrada.quantidade, f: 0 } : { m: 0, f: entrada.quantidade },
  })
}

/**
 * POST /api/caixas/estoque - o cadastro inicial de uma caixa de estoque: a caixa nasce na posicao
 * vazia, com o sexo, a linhagem e a especie dela, e recebe o primeiro grupo de idade. A linhagem
 * tem de estar ativa. O codigo da caixa vem do trigger da posicao
 */
export async function criarCaixaDeEstoque(dados: CaixaDeEstoqueNova, idUsuario: number) {
  const hoje = hojeISO()
  exigirIdadeDoEstoque(dados.dtNascimento, hoje)

  const linhagem = await prisma.linhagem.findUnique({ where: { id: dados.idLinhagem } })

  if (linhagem === null) throw naoEncontrado('Linhagem')

  // a mesma regra do casal e do pedido: linhagem inativa nao recebe nada novo
  if (!linhagem.ativa) throw campoInvalido('idLinhagem', 'Esta linhagem está inativa e não recebe animais novos.')

  // uma caixa ativa por posicao tambem fica no indice parcial do banco: se a corrida passar por
  // aqui, erros-do-banco.ts traduz
  return prisma.$transaction(async (tx) => {
    const posicao = await exigirPosicaoVazia(tx, dados.posicao, 'posicao')

    const caixa = await tx.caixa.create({
      data: {
        idEstante: posicao.estante.id,
        face: posicao.face,
        linha: posicao.linha,
        coluna: posicao.coluna,
        idEspecie: linhagem.idEspecie,
        tipo: 'estoque',
        sexo: dados.sexo,
        idLinhagem: linhagem.id,
      },
      select: { id: true, codigo: true },
    })

    await lancarEntrada(tx, {
      idCaixa: caixa.id,
      idLinhagem: linhagem.id,
      sexo: dados.sexo,
      quantidade: dados.quantidade,
      dtNascimento: dados.dtNascimento,
      dtEntrada: hoje,
      idUsuario,
    })

    return { idCaixa: caixa.id, codigo: caixa.codigo }
  })
}

/**
 * POST /api/caixas/:id/entrada - mais um grupo de idade do cadastro inicial numa caixa de estoque
 * que ja existe: o sexo e a linhagem sao os da caixa, que tem de estar ativa e com a linhagem ativa
 */
export async function registrarEntrada(idCaixa: number, dados: Entrada, idUsuario: number) {
  const hoje = hojeISO()
  exigirIdadeDoEstoque(dados.dtNascimento, hoje)

  return prisma.$transaction(async (tx) => {
    await travarCaixas(tx, [idCaixa])

    const caixa = await tx.caixa.findUnique({
      where: { id: idCaixa },
      select: {
        codigo: true,
        ativa: true,
        tipo: true,
        sexo: true,
        idEspecie: true,
        linhagem: { select: { id: true, nome: true, ativa: true, idEspecie: true } },
      },
    })

    if (caixa === null) throw naoEncontrado('Caixa')
    if (!caixa.ativa) throw caixaLiberada(caixa.codigo)

    const { linhagem, sexo } = caixa

    if (caixa.tipo !== 'estoque' || linhagem === null || (sexo !== 'M' && sexo !== 'F')) {
      throw erroDeRegra(
        'SEQUENCIA_INVALIDA',
        `A caixa ${caixa.codigo} é uma caixa do casal: a entrada do cadastro inicial vai numa caixa de estoque.`,
      )
    }

    if (!linhagem.ativa) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', `A linhagem ${linhagem.nome} desta caixa está inativa e não recebe animais novos.`)
    }

    // a caixa ja nasce da especie da linhagem; o trigger dos animais cobra o mesmo
    if (linhagem.idEspecie !== caixa.idEspecie) {
      throw erroDeRegra('ANIMAL_CAIXA', `A caixa ${caixa.codigo} é de outra espécie que a linhagem ${linhagem.nome}.`)
    }

    await lancarEntrada(tx, {
      idCaixa,
      idLinhagem: linhagem.id,
      sexo,
      quantidade: dados.quantidade,
      dtNascimento: dados.dtNascimento,
      dtEntrada: hoje,
      idUsuario,
    })

    return { idCaixa, codigo: caixa.codigo }
  })
}
