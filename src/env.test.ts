import { describe, expect, it } from 'vitest'
import { esquemaEnv } from './env.ts'

// O esquema direto, sem o process.env: o que esta em jogo e quem sobe e quem cai no boot

const base = { DATABASE_URL: 'postgresql://placeholder/nidus-testes' }
const brevo = { BREVO_API_KEY: 'chave-de-mentira', EMAIL_REMETENTE: 'nidus@exemplo.com' }

/** As variaveis que derrubaram o boot */
const recusadas = (fonte: Record<string, string>) => {
  const resultado = esquemaEnv.safeParse(fonte)
  return resultado.success ? [] : resultado.error.issues.map((problema) => problema.path.join('.'))
}

describe('variaveis do envio de e-mail', () => {
  it('production nao sobe sem a chave da Brevo e sem o remetente', () => {
    expect(recusadas({ ...base, NODE_ENV: 'production' })).toEqual(['BREVO_API_KEY', 'EMAIL_REMETENTE'])
    expect(recusadas({ ...base, NODE_ENV: 'production', BREVO_API_KEY: 'chave-de-mentira' })).toEqual([
      'EMAIL_REMETENTE',
    ])
  })

  it('em production, variavel vazia como no .env.example conta como ausente', () => {
    expect(
      recusadas({ ...base, NODE_ENV: 'production', BREVO_API_KEY: '', EMAIL_REMETENTE: '  ' }),
    ).toEqual(['BREVO_API_KEY', 'EMAIL_REMETENTE'])
  })

  it('production sobe com as duas', () => {
    const resultado = esquemaEnv.parse({ ...base, NODE_ENV: 'production', ...brevo })

    expect(resultado).toMatchObject(brevo)
  })

  it.each(['development', 'test'])('%s sobe sem elas, ou com elas vazias', (nodeEnv) => {
    expect(recusadas({ ...base, NODE_ENV: nodeEnv })).toEqual([])
    expect(recusadas({ ...base, NODE_ENV: nodeEnv, BREVO_API_KEY: '', EMAIL_REMETENTE: '' })).toEqual([])
  })

  it('remetente que nao e e-mail nao sobe em ambiente nenhum', () => {
    expect(recusadas({ ...base, NODE_ENV: 'development', EMAIL_REMETENTE: 'nidus' })).toEqual([
      'EMAIL_REMETENTE',
    ])
  })
})
