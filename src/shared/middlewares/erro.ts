import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'
import { ErroDeAplicacao } from '../erros.ts'

/** Rota inexistente devolve o envelope do contrato, nao o HTML de erro do Express. */
export const rotaNaoEncontrada: RequestHandler = (req, res) => {
  res.status(404).json({
    erro: {
      codigo: 'NAO_ENCONTRADO',
      mensagem: `Rota ${req.method} ${req.originalUrl} nao existe.`,
    },
  })
}

/** Um par campo -> mensagem a partir das issues do Zod, como o contrato exige em VALIDACAO. */
function camposDoZod(erro: ZodError): Record<string, string> {
  const campos: Record<string, string> = {}

  for (const issue of erro.issues) {
    const campo = issue.path.join('.') || '(corpo)'
    campos[campo] ??= issue.message
  }

  return campos
}

/**
 * Tratador central. Fica por ultimo na cadeia e precisa dos quatro parametros -
 * e a assinatura pela qual o Express reconhece um error handler.
 *
 * O Express 5 encaminha promise rejeitada de handler async para ca sozinho, sem
 * try/catch e sem wrapper. Por isso a rota pode chamar `esquema.parse(req.body)`
 * direto: o ZodError cai aqui e vira 400.
 */
export const tratadorDeErros: ErrorRequestHandler = (erro, req, res, next) => {
  if (res.headersSent) {
    next(erro)
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
  // cliente.
  console.error(`[500] ${req.method} ${req.originalUrl}`, erro)
  res.status(500).json({
    erro: {
      codigo: 'ERRO_INTERNO',
      mensagem: 'Erro interno. Tente novamente em instantes.',
    },
  })
}
