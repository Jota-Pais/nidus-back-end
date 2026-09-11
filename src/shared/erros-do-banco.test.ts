import { describe, expect, it } from 'vitest'
import { traduzirErroDoBanco } from './erros-do-banco.ts'

// Os erros abaixo NAO sao inventados: sao a forma que o adapter do Prisma 7
// produziu contra o banco da Neon, copiada de uma violacao provocada de
// proposito em cada invariante. E o que torna este teste util - um fixture
// imaginado passaria e a producao quebraria.

/** Violacao de unique: Prisma P2002, com o nome do indice em `constraint`. */
const unique = (indice: string, tabela: string) => ({
  name: 'PrismaClientKnownRequestError',
  code: 'P2002',
  meta: {
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23505',
        originalMessage: `duplicate key value violates unique constraint "${indice}"`,
        kind: 'UniqueConstraintViolation',
        constraint: { index: indice },
        table: tabela,
      },
    },
    modelName: tabela,
  },
})

/** Violacao de CHECK: nome da constraint so dentro da mensagem. */
const check = (constraint: string, tabela: string) => ({
  name: 'PrismaClientKnownRequestError',
  code: 'P2010',
  meta: {
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23514',
        originalMessage: `new row for relation "${tabela}" violates check constraint "${constraint}"`,
        kind: 'postgres',
        code: '23514',
      },
    },
  },
})

/** `RAISE EXCEPTION` de trigger nosso: a mensagem e texto que escrevemos. */
const trigger = (mensagem: string) => ({
  name: 'PrismaClientKnownRequestError',
  code: 'P2039',
  meta: {
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23514',
        originalMessage: mensagem,
        kind: 'postgres',
        code: '23514',
        severity: 'ERROR',
        message: mensagem,
      },
    },
    modelName: 'Compromisso',
  },
})

describe('invariante do banco vira o 409 do contrato', () => {
  it('RN-09 - compromisso acima da oferta vira DISPONIBILIDADE_EXCEDIDA', () => {
    // A invariante que o sistema existe para garantir.
    const traduzido = traduzirErroDoBanco(
      trigger('RN-09: o parto 8 oferta 4 machos e ja teria 6 comprometidos'),
    )

    expect(traduzido?.status).toBe(409)
    expect(traduzido?.codigo).toBe('DISPONIBILIDADE_EXCEDIDA')
    expect(traduzido?.extras.requisito).toBe('RN-09')
  })

  it('preserva a mensagem do trigger, que traz os numeros do caso', () => {
    // O banco explica melhor que qualquer texto generico: diz o parto, a oferta
    // e o total que ficaria. E mensagem para exibir ao usuario (contrato §2).
    const traduzido = traduzirErroDoBanco(
      trigger('RN-09: o parto 8 oferta 4 machos e ja teria 6 comprometidos'),
    )

    expect(traduzido?.message).toBe('RN-09: o parto 8 oferta 4 machos e ja teria 6 comprometidos')
  })

  it('RF-INF-05 - duas caixas na mesma posicao vira POSICAO_OCUPADA', () => {
    const traduzido = traduzirErroDoBanco(unique('caixa_uma_por_posicao', 'caixa'))

    expect(traduzido?.status).toBe(409)
    expect(traduzido?.codigo).toBe('POSICAO_OCUPADA')
    expect(traduzido?.extras.requisito).toBe('RF-INF-05')
  })

  it('RN-03 - segundo casal ativo na caixa vira CAIXA_JA_TEM_CASAL_ATIVO', () => {
    const traduzido = traduzirErroDoBanco(unique('casal_um_ativo_por_caixa', 'casal'))

    expect(traduzido?.codigo).toBe('CAIXA_JA_TEM_CASAL_ATIVO')
    expect(traduzido?.extras.requisito).toBe('RN-03')
  })

  it('RN-04 - sexto parto vira LIMITE_PARTOS_ATINGIDO', () => {
    const traduzido = traduzirErroDoBanco(check('parto_ordem_ciclo', 'parto'))

    expect(traduzido?.codigo).toBe('LIMITE_PARTOS_ATINGIDO')
    expect(traduzido?.extras.requisito).toBe('RN-04')
  })

  it('nao usa a mensagem crua do Postgres como texto para o usuario', () => {
    // "duplicate key value violates unique constraint" e para log.
    const traduzido = traduzirErroDoBanco(unique('caixa_uma_por_posicao', 'caixa'))

    expect(traduzido?.message).not.toMatch(/duplicate key/)
    expect(traduzido?.message).toMatch(/posicao da estante/)
  })
})

describe('o que NAO deve virar 409', () => {
  it('invariante do banco sem mapeamento continua caindo em 500', () => {
    // De proposito: violacao que ninguem nomeou e bug nosso, e 409 generico
    // esconderia o bug atras de uma mensagem amigavel.
    expect(traduzirErroDoBanco(check('constraint_que_ninguem_mapeou', 'caixa'))).toBeUndefined()
    expect(traduzirErroDoBanco(unique('indice_novo_qualquer', 'caixa'))).toBeUndefined()
  })

  it('outro SQLSTATE nao e traduzido', () => {
    // 23503 (FK) e 23502 (not null) nao estao mapeados: FK quebrada e bug de
    // programacao, nao regra que o usuario possa corrigir.
    const fk = {
      code: 'P2003',
      meta: {
        driverAdapterError: {
          cause: { originalCode: '23503', originalMessage: 'violates foreign key constraint' },
        },
      },
    }

    expect(traduzirErroDoBanco(fk)).toBeUndefined()
  })

  it('erro que nao e de banco passa direto', () => {
    expect(traduzirErroDoBanco(new Error('qualquer coisa'))).toBeUndefined()
    expect(traduzirErroDoBanco(undefined)).toBeUndefined()
    expect(traduzirErroDoBanco(null)).toBeUndefined()
    expect(traduzirErroDoBanco('texto')).toBeUndefined()
    expect(traduzirErroDoBanco({ meta: {} })).toBeUndefined()
  })
})
