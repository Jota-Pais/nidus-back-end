import { Router } from 'express'
import { z } from 'zod'
import { emailsCapturados } from './email.ts'
import { avancarRelogio, lerRelogio } from './relogio.ts'

/**
 * As rotas do relogio de teste. So sao registradas com RELOGIO_DE_TESTE=ligado (app.ts), e por isso
 * ficam sem login: no ar elas nao existem
 */
export const relogioRoutes = Router()

const avanco = z.object({ dias: z.number().int().min(0) })

relogioRoutes.get('/', (_req, res) => {
  res.json(lerRelogio())
})

relogioRoutes.post('/', (req, res) => {
  const dados = avanco.safeParse(req.body)

  if (!dados.success) {
    res.status(400).json({
      erro: { codigo: 'VALIDACAO', mensagem: 'Informe "dias" como um número inteiro, 0 ou mais.' },
    })
    return
  }

  avancarRelogio(dados.data.dias)
  res.json(lerRelogio())
})

relogioRoutes.get('/emails', (_req, res) => {
  res.json(emailsCapturados().map((email) => ({ ...email, quando: email.quando.toISOString() })))
})
