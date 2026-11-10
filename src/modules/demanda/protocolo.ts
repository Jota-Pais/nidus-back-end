// O numero do projeto CEUA: o protocolo do pedido de animais e o numero do projeto no cadastro.
// A CEUA da UFSC usa dois formatos, e os dois valem:
// - o numero do processo da UFSC (NUP), 23080.NNNNNN/AAAA-DD: 23080 e a UFSC, depois vem 6
//   digitos da sequencia, 4 do ano e 2 verificadores, em modulo 11
// - o numero do Sistema CEUA, 10 digitos, em que os 6 ultimos sao a data do registro (DDMMAA)
// A API recebe e grava o processo com a pontuacao e o Sistema CEUA com os 10 digitos limpos. O
// front confere a mesma regra enquanto a pessoa digita

import { z } from 'zod'
import { hojeISO } from '../../shared/traducao.ts'

const PROCESSO = /^23080\.\d{6}\/\d{4}-\d{2}$/
const SISTEMA_CEUA = /^\d{10}$/

/** Modulo 11, com pesos decrescentes ate 2. A conta da de 1 a 11, e 10 e 11 viram 0 e 1 */
function digitoVerificador(digitos: string): number {
  const soma = [...digitos].reduce(
    (total, digito, i) => total + Number(digito) * (digitos.length + 1 - i),
    0,
  )

  return (11 - (soma % 11)) % 10
}

/** O primeiro verificador sai dos 15 primeiros digitos; o segundo, dos 15 e do primeiro */
function verificadoresDoProcesso(digitos: string): string {
  const primeiro = digitoVerificador(digitos.slice(0, 15))
  const segundo = digitoVerificador(`${digitos.slice(0, 15)}${primeiro}`)

  return `${primeiro}${segundo}`
}

/** A data DDMMAA dos 6 ultimos digitos, 'aaaa-mm-dd', ou null se ela nao existe (31/02) */
function dataDoRegistro(numero: string): string | null {
  const dia = Number(numero.slice(4, 6))
  const mes = Number(numero.slice(6, 8))
  const data = new Date(Date.UTC(2000 + Number(numero.slice(8, 10)), mes - 1, dia))

  return data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia
    ? data.toISOString().slice(0, 10)
    : null
}

/**
 * Confere o numero ja na forma da API. Devolve o que esta errado, ou null quando o numero vale.
 * 'hoje' e o dia de Brasilia: o registro de hoje vale, o de amanha nao
 */
export function conferirProtocolo(numero: string, hoje: string = hojeISO()): string | null {
  if (PROCESSO.test(numero)) {
    const digitos = numero.replace(/\D/g, '')

    if (verificadoresDoProcesso(digitos) !== digitos.slice(15)) {
      return 'Dígito verificador errado. Confira o número do processo.'
    }

    if (Number(digitos.slice(11, 15)) > Number(hoje.slice(0, 4))) {
      return 'O ano do processo ainda não chegou.'
    }

    return null
  }

  if (SISTEMA_CEUA.test(numero)) {
    // a data nos 6 ultimos digitos e conferida, mas a mensagem nao explica a regra por dentro
    const registro = dataDoRegistro(numero)

    if (registro === null || registro > hoje) {
      return 'Protocolo no formato incorreto.'
    }

    return null
  }

  return 'Use o processo, 23080.XXXXXX/AAAA-XX, ou os 10 dígitos do Sistema CEUA.'
}

/**
 * O protocolo do pedido e o numero no cadastro do projeto seguem a mesma regra: senao o gestor
 * cadastra um numero que o pesquisador nao consegue pedir
 */
export const numeroCeua = z
  .string()
  .trim()
  .superRefine((numero, contexto) => {
    const problema = conferirProtocolo(numero)

    if (problema !== null) {
      contexto.addIssue({ code: 'custom', message: problema })
    }
  })
