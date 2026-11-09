import { describe, expect, it } from 'vitest'
import { traduzirErroDoBanco } from './erros-do-banco.ts'

// Os erros abaixo NAO sao inventados: sao a forma que o adapter do Prisma 7
// produziu contra o banco da Neon, copiada de uma violacao provocada de
// proposito em cada invariante. E o que torna este teste util - um fixture
// imaginado passaria e a producao quebraria

/** Violacao de unique: Prisma P2002, com o nome do indice em constraint */
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

/** Violacao de CHECK num update ou create do Prisma: nome da constraint so dentro da mensagem */
const check = (constraint: string, tabela: string) => {
  const mensagem = `new row for relation "${tabela}" violates check constraint "${constraint}"`

  return {
    name: 'PrismaClientKnownRequestError',
    code: 'P2039',
    meta: {
      modelName: tabela,
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
    },
  }
}

/** violacao de FK: nome da constraint so dentro da mensagem, como no CHECK. */
const fk = (constraint: string, tabela: string) => ({
  name: 'PrismaClientKnownRequestError',
  code: 'P2003',
  meta: {
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23503',
        originalMessage: `insert or update on table "${tabela}" violates foreign key constraint "${constraint}"`,
        kind: 'postgres',
        code: '23503',
      },
    },
  },
})

/** 'RAISE EXCEPTION' de trigger nosso: a mensagem e texto que escrevemos, com o prefixo */
const trigger = (mensagem: string, modelo = 'Animal') => ({
  name: 'PrismaClientKnownRequestError',
  code: 'P2039',
  meta: {
    modelName: modelo,
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
  },
})

describe('trigger do banco vira 409 com o codigo do prefixo', () => {
  // Uma mensagem real de cada prefixo dos tres triggers
  it.each([
    ['TOPOLOGIA', 'TOPOLOGIA: a posicao face 1 linha 99 coluna 1 nao existe na estante 4 (2 faces, 8 linhas, 8 colunas)', 'Caixa'],
    ['ANIMAL_ORIGEM', 'ANIMAL_ORIGEM: o parto 3 ainda nao nasceu', 'Animal'],
    ['ANIMAL_SITUACAO', 'ANIMAL_SITUACAO: o animal 21 ja esta entregue, e isso nao muda mais', 'Animal'],
    ['ANIMAL_CAIXA', 'ANIMAL_CAIXA: a caixa de estoque F2A guarda machos Swiss, e este animal e femea Swiss', 'Animal'],
    ['PEDIDO_RESERVA', 'PEDIDO_RESERVA: o pedido 2 esta entregue, e so pedido aprovado ou reservado recebe animais', 'Animal'],
    ['PEDIDO_EXCEDIDO', 'PEDIDO_EXCEDIDO: o pedido 1 pede 0 machos, 0 femeas e 12 de qualquer sexo, e ficaria com 10 machos e 3 femeas', 'Animal'],
    ['PEDIDO_INCOMPLETO', 'PEDIDO_INCOMPLETO: o pedido 1 pede 0 machos, 0 femeas e 12 de qualquer sexo, e tem 0 machos e 0 femeas reservados', 'Pedido'],
    ['PEDIDO_COM_RESERVA', 'PEDIDO_COM_RESERVA: o pedido 1 ainda tem 12 animais reservados: desfaca a reserva antes', 'Pedido'],
    ['PEDIDO_ENTREGUE', 'PEDIDO_ENTREGUE: o pedido 3 ja entregou 7 animais, e pedido entregue continua entregue', 'Pedido'],
  ])('%s', (codigo, mensagem, modelo) => {
    const traduzido = traduzirErroDoBanco(trigger(mensagem, modelo))

    expect(traduzido?.status).toBe(409)
    expect(traduzido?.codigo).toBe(codigo)
  })

  it('preserva a mensagem do trigger, que traz os numeros do caso, sem o prefixo', () => {
    // O banco explica melhor que qualquer texto generico: diz o pedido, o que ele pede e com
    // quanto ficaria. E mensagem para exibir ao usuario
    const traduzido = traduzirErroDoBanco(
      trigger('PEDIDO_EXCEDIDO: o pedido 1 pede 0 machos, 0 femeas e 12 de qualquer sexo, e ficaria com 10 machos e 3 femeas'),
    )

    expect(traduzido?.message).toBe(
      'O pedido 1 pede 0 machos, 0 femeas e 12 de qualquer sexo, e ficaria com 10 machos e 3 femeas',
    )
  })
})

describe('constraint do banco vira 409', () => {
  it('duas caixas na mesma posicao vira POSICAO_OCUPADA', () => {
    const traduzido = traduzirErroDoBanco(unique('caixa_uma_por_posicao', 'caixa'))

    expect(traduzido?.status).toBe(409)
    expect(traduzido?.codigo).toBe('POSICAO_OCUPADA')
  })

  it('segundo casal ativo na caixa vira CAIXA_JA_TEM_CASAL_ATIVO', () => {
    const traduzido = traduzirErroDoBanco(unique('casal_um_ativo_por_caixa', 'casal'))

    expect(traduzido?.codigo).toBe('CAIXA_JA_TEM_CASAL_ATIVO')
  })

  it('parto registrado duas vezes (duplo clique) vira SEQUENCIA_INVALIDA', () => {
    const traduzido = traduzirErroDoBanco(unique('parto_id_casal_ordem_key', 'parto'))

    expect(traduzido?.status).toBe(409)
    expect(traduzido?.codigo).toBe('SEQUENCIA_INVALIDA')
    expect(traduzido?.message).toBe('Este parto ja foi aberto por outro registro de acasalamento. Atualize a ficha.')
  })

  it('sexto parto vira LIMITE_PARTOS_ATINGIDO', () => {
    const traduzido = traduzirErroDoBanco(check('parto_ordem_ciclo', 'parto'))

    expect(traduzido?.codigo).toBe('LIMITE_PARTOS_ATINGIDO')
  })

  it.each([
    ['parto_datas_em_ordem', 'parto'],
    ['casal_encerra_depois_de_formar', 'casal'],
    ['animal_sai_depois_de_chegar', 'animal'],
  ])('data fora da ordem (%s) vira DATA_FORA_DA_ORDEM, com texto para o usuario', (constraint, tabela) => {
    // Rede de seguranca: o zod e os servicos conferem antes, com a mensagem no campo
    const traduzido = traduzirErroDoBanco(check(constraint, tabela))

    expect(traduzido?.status).toBe(409)
    expect(traduzido?.codigo).toBe('DATA_FORA_DA_ORDEM')
    expect(traduzido?.message).not.toMatch(/violates/)
  })

  it('FK composta recusada vira PAR_GENETICO_INVALIDO (rede de seguranca)', () => {
    // O caminho normal e o pre-check em reproducao.service.ts, que da a mensagem rica com os
    // pares validos. Isto so cobre a corrida: par desativado entre o pre-check e o insert
    const traduzido = traduzirErroDoBanco(fk('casal_grupo_macho_grupo_femea_fkey', 'casal'))

    expect(traduzido?.status).toBe(409)
    expect(traduzido?.codigo).toBe('PAR_GENETICO_INVALIDO')
  })

  it('nao usa a mensagem crua do Postgres como texto para o usuario', () => {
    // "duplicate key value violates unique constraint" e para log
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

  it.each([
    ['animal_situacao_dominio', 'animal'],
    ['pedido_status_dominio', 'pedido'],
    ['caixa_tipo_dominio', 'caixa'],
    ['caixa_estoque_completo', 'caixa'],
    ['caixa_liberacao_coerente', 'caixa'],
    ['casal_ativo_coerente', 'casal'],
    ['animal_saida_coerente', 'animal'],
    ['pedido_entregue_tem_data', 'pedido'],
    ['pedido_qtd_nao_negativa', 'pedido'],
    ['parto_sem_ninhada_tem_motivo', 'parto'],
  ])('CHECK de dominio ou de coerencia da linha (%s) continua caindo em 500', (constraint, tabela) => {
    // Os valores deles sao o codigo que calcula, ou o zod da rota que confere antes: se um deles
    // recusar, e bug do codigo, nao regra que o usuario possa corrigir
    expect(traduzirErroDoBanco(check(constraint, tabela))).toBeUndefined()
  })

  it('prefixo de trigger que ninguem mapeou continua caindo em 500', () => {
    // Inclusive o RN-09 do trigger da oferta, que saiu com o modelo por caixa
    expect(traduzirErroDoBanco(trigger('RN-09: o parto 8 oferta 4 machos e ja teria 6 comprometidos'))).toBeUndefined()
    expect(traduzirErroDoBanco(trigger('PREFIXO_NOVO: algo que ninguem traduziu'))).toBeUndefined()
  })

  it('FK sem constraint mapeada continua sem traducao', () => {
    // 23503 (FK) so traduz a unica composta mapeada (par genetico,
    // acima). Qualquer outra FK quebrada e bug de programacao, e 23502 (not
    // null) nem chega a ser considerado - nenhum dos dois deve virar 409.
    expect(traduzirErroDoBanco(fk('casal_id_caixa_fkey', 'casal'))).toBeUndefined()
    expect(
      traduzirErroDoBanco({
        code: 'P2003',
        meta: {
          driverAdapterError: {
            cause: { originalCode: '23502', originalMessage: 'null value in column "id_caixa"' },
          },
        },
      }),
    ).toBeUndefined()
  })

  it('erro que nao e de banco passa direto', () => {
    expect(traduzirErroDoBanco(new Error('qualquer coisa'))).toBeUndefined()
    expect(traduzirErroDoBanco(undefined)).toBeUndefined()
    expect(traduzirErroDoBanco(null)).toBeUndefined()
    expect(traduzirErroDoBanco('texto')).toBeUndefined()
    expect(traduzirErroDoBanco({ meta: {} })).toBeUndefined()
  })
})
