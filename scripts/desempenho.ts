const API = process.env.NIDUS_API ?? 'http://localhost:3333'
const COOKIE = process.env.NIDUS_COOKIE
const REPETICOES = Number(process.env.NIDUS_REPETICOES ?? 30)
const SIMULTANEAS = Number(process.env.NIDUS_SIMULTANEAS ?? 5)
const LIMITE_P95_MS = Number(process.env.NIDUS_LIMITE_P95_MS ?? 1000)

const ROTAS = [
  '/saude',
  '/api/quadro?especie=rato',
  '/api/estantes',
  '/api/solicitacoes',
  '/api/estoque?especie=rato',
  '/api/busca?especie=rato&machos=4&femeas=4&idade=28',
]

function percentil(tempos: number[], p: number): number {
  const ordenados = [...tempos].sort((a, b) => a - b)
  const indice = Math.min(ordenados.length - 1, Math.ceil((p / 100) * ordenados.length) - 1)
  return ordenados[Math.max(0, indice)] ?? 0
}

async function medir(rota: string): Promise<{ tempos: number[]; falhas: number }> {
  const tempos: number[] = []
  let falhas = 0
  let restantes = REPETICOES

  async function trabalhador() {
    while (restantes > 0) {
      restantes -= 1
      const inicio = performance.now()
      const resposta = await fetch(`${API}${rota}`, {
        headers: COOKIE === undefined ? {} : { cookie: `nidus_sessao=${COOKIE}` },
      }).catch(() => null)
      tempos.push(performance.now() - inicio)
      if (resposta === null || !resposta.ok) falhas += 1
      await resposta?.arrayBuffer()
    }
  }

  await Promise.all(Array.from({ length: SIMULTANEAS }, trabalhador))
  return { tempos, falhas }
}

async function main() {
  console.log(`API ${API} | ${REPETICOES} chamadas por rota, ${SIMULTANEAS} ao mesmo tempo`)
  console.log(`Limite: p95 ate ${LIMITE_P95_MS} ms\n`)

  await fetch(`${API}/saude`).catch(() => null)

  let reprovou = false
  const rotas = COOKIE === undefined ? ROTAS.slice(0, 1) : ROTAS

  for (const rota of rotas) {
    const { tempos, falhas } = await medir(rota)
    const p50 = percentil(tempos, 50)
    const p95 = percentil(tempos, 95)
    const passou = p95 <= LIMITE_P95_MS && falhas === 0
    if (!passou) reprovou = true

    console.log(
      `${passou ? 'ok   ' : 'FALHA'} ${rota.padEnd(52)} p50 ${p50.toFixed(0).padStart(5)} ms  p95 ${p95.toFixed(0).padStart(5)} ms  erros ${falhas}`,
    )
  }

  if (COOKIE === undefined) {
    console.log('\nSem NIDUS_COOKIE so a /saude foi medida. Veja o README, secao Desempenho.')
  }

  process.exitCode = reprovou ? 1 : 0
}

void main()
