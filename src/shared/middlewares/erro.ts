import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'
import { traduzirErroDoBanco } from '../erros-do-banco.ts'
import { ErroDeAplicacao } from '../erros.ts'

/** Rota inexistente devolve o envelope de erro da API, nao o HTML de erro do Express. */
export const rotaNaoEncontrada: RequestHandler = (req, res) => {
  res.status(404).json({
    erro: {
      codigo: 'NAO_ENCONTRADO',
      mensagem: `Rota ${req.method} ${req.originalUrl} nao existe.`,
    },
  })
}

/** Um par campo -> mensagem a partir das issues do Zod, exigido em VALIDACAO. */
function camposDoZod(erro: ZodError): Record<string, string> {
  const campos: Record<string, string> = {}

  for (const issue of erro.issues) {
    const campo = issue.path.join('.') || '(corpo)'
    campos[campo] ??= issue.message
  }

  return campos
}

/**
 * tratador central. Fica por ultimo na cadeia e precisa dos quatro parametros -
 * e a assinatura pela qual o Express reconhece um error handler
 */
export const tratadorDeErros: ErrorRequestHandler = (erro, req, res, next) => {
  if (res.headersSent) {
    next(erro)
    return
  }

  const tipoDoCorpo = (erro as { type?: unknown }).type

  if (tipoDoCorpo === 'entity.parse.failed' || tipoDoCorpo === 'entity.too.large') {
    const grande = tipoDoCorpo === 'entity.too.large'
    res.status(grande ? 413 : 400).json({
      erro: {
        codigo: 'VALIDACAO',
        mensagem: grande
          ? 'O corpo da requisicao e grande demais.'
          : 'O corpo da requisicao nao e um JSON valido.',
        campos: { '(corpo)': grande ? 'Grande demais.' : 'JSON invalido.' },
      },
    })
    return
  }

  if (erro instanceof ZodError) {
    res.status(400).json({
      erro: {
        codigo: 'VALIDACAO',
        mensagem: 'Confira os campos destacados.',
        campos: camposDoZod(erro),
      },
    })
    return
  }

  // Invariante recusada pelo banco: 'CHECK', unique parcial ou trigger. Sao
  // regras de negocio que ficam no Postgres de proposito -
  // viram 409 com o codigo de erro da API, nunca 500
  const doBanco = traduzirErroDoBanco(erro)

  if (doBanco !== undefined) {
    res.status(doBanco.status).json({
      erro: {
        codigo: doBanco.codigo,
        mensagem: doBanco.message,
        ...doBanco.extras,
      },
    })
    return
  }

  if (erro instanceof ErroDeAplicacao) {
    res.status(erro.status).json({
      erro: {
        codigo: erro.codigo,
        mensagem: erro.message,
        ...erro.extras,
      },
    })
    return
  }

  // Aqui e bug, nao regra: log inteiro do lado do servidor, nada de stack para o
  // cliente. Invariante do banco que ninguem mapeou cai aqui de proposito - ver
  // 'erros-do-banco.ts'
  console.error(`[500] ${req.method} ${req.originalUrl}`, erro)
  res.status(500).json({
    erro: {
      codigo: 'ERRO_INTERNO',
      mensagem: 'Erro interno. Tente novamente em instantes.',
    },
  })
}
