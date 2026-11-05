import { ErroDeAplicacao } from '../../shared/erros.ts'

const JANELA_MS = 15 * 60_000
const MAX_FALHAS = 5

const falhas = new Map<string, { quantas: number; desde: number }>()

export function conferirTentativas(chave: string, agora: number = Date.now()): void {
  const registro = falhas.get(chave)

  if (registro === undefined || agora - registro.desde > JANELA_MS) {
    return
  }

  if (registro.quantas >= MAX_FALHAS) {
    throw new ErroDeAplicacao(
      429,
      'MUITAS_TENTATIVAS',
      'Muitas tentativas de login. Espere 15 minutos e tente de novo.',
    )
  }
}

export function registrarFalha(chave: string, agora: number = Date.now()): void {
  for (const [outra, antigo] of falhas) {
    if (agora - antigo.desde > JANELA_MS) falhas.delete(outra)
  }

  const registro = falhas.get(chave)

  if (registro === undefined || agora - registro.desde > JANELA_MS) {
    falhas.set(chave, { quantas: 1, desde: agora })
    return
  }

  registro.quantas += 1
}

export function limparFalhas(chave: string): void {
  falhas.delete(chave)
}

export function chavesGuardadas(): number {
  return falhas.size
}
