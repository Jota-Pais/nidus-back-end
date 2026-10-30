// Envio de e-mail. O servico ainda nao foi escolhido: ate la, fora de producao o codigo vai
// para o console do servidor, e em producao o envio falha dizendo isso

import { env } from '../env.ts'

/**
 * Manda o codigo de acesso para UM destinatario, ja validado pela rota (e-mail da UFSC, sem
 * lista). Quando o servico entrar, o endereco vai num campo proprio da chamada a ele, nunca
 * montado num cabecalho de texto
 */
export async function enviarCodigoDeAcesso(email: string, codigo: string): Promise<void> {
  if (env.NODE_ENV !== 'production') {
    console.log(`[acesso] codigo para ${email}: ${codigo}`)
    return
  }

  throw new Error(
    'Envio de e-mail nao configurado: o servico de e-mail ainda nao foi escolhido, e o codigo ' +
      `para ${email} nao saiu.`,
  )
}
