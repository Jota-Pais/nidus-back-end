-- Colonia por animal: uma linha anonima por rato (colonia.animal), a caixa como lugar e uma
-- trilha do que aconteceu com os animais (colonia.ocorrencia).
--
-- Ate aqui o estoque era a contagem do parto em tres momentos (nascido, eutanasiado, desmamado),
-- o lote dizia quantos estavam em cada caixa de estoque, o que sobrava "estava" na caixa do casal
-- por conta, e o compromisso reservava por parto, com o lugar dos reservados decidido na leitura.
-- Agora cada rato tem uma caixa, uma situacao e no maximo um pedido, e toda conta e COUNT.
--
-- Uma migration so, sem BEGIN/COMMIT: o Prisma manda o arquivo inteiro de uma vez e o Postgres
-- roda script de varios comandos numa transacao implicita. Qualquer erro daqui desfaz tudo e o
-- banco fica como estava (provado em 08/11/2026 com um RAISE proposital no fim, no branch de teste
-- da Neon e num Postgres local com o arquivo inteiro). Antes de tentar de novo:
-- `prisma migrate resolve --rolled-back 20261108200000_colonia_por_animal`.
--
-- Ordem: 1. pre-condicoes | 2. estrutura nova | 3. conversao | 4. conferencia | 5. apaga o modelo
-- antigo | 6. CHECKs | 7. triggers. CHECKs e triggers vem por ultimo para validarem as linhas
-- convertidas sem barrar a propria conversao.
--
-- A base do DDL e o `prisma migrate diff` do schema.prisma anterior para este, reordenado a mao:
-- o diff apagaria demanda.solicitacao e criaria demanda.pedido vazia; aqui a tabela muda de nome
-- com os dados, e o que o diff apaga so sai depois da conversao.
--
-- O banco cobra so as travas estruturais: CHECK por linha e tres triggers (a topologia da caixa,
-- o animal coerente e o pedido coerente). As regras de caixa, casal, parto e datas ficam no codigo,
-- numa transacao so, com as linhas travadas.
--
-- Em 08/11/2026 a producao tinha 5 partos nascidos, 4 lotes, 2 compromissos entregues, nenhuma
-- reserva pendente e 3 pedidos. Viram 83 animais (42 vivos, 37 entregues, 4 mortos) e 15
-- ocorrencias.

-- ---------------------------------------------------------------------------
-- 1. Pre-condicoes
--
-- Duas visoes temporarias leem o modelo antigo do jeito que o codigo antigo lia, para as
-- pre-condicoes, a conversao e a conferencia usarem a mesma conta. Se alguma pre-condicao falhar,
-- nada muda: a migration para listando tudo o que falhou.
-- ---------------------------------------------------------------------------

-- Por parto nascido e sexo: as contagens antigas. oferta = o que restou depois da selecao (ou o
-- desmamado); perda = quem morreu entre a selecao e o desmame, que o modelo antigo so via como
-- diferenca; vivos na caixa do casal = a conta antiga oferta - entregue - lotes, sem Math.max
CREATE TEMP VIEW "parto_antigo" AS
SELECT b.*,
       COALESCE(b.desmamado, b.nascido - b.eutanasiado) AS oferta,
       CASE WHEN b.desmamado IS NULL THEN 0 ELSE b.nascido - b.eutanasiado - b.desmamado END AS perda,
       COALESCE(b.desmamado, b.nascido - b.eutanasiado) - b.entregue - b.nos_lotes AS vivos_na_caixa_do_casal
  FROM (
    SELECT p.id AS id_parto,
           s.sexo,
           cs.id_caixa AS id_caixa_do_casal,
           p.dt_desmame_real,
           COALESCE(p.dt_selecao, p.dt_parto_real) AS dt_selecao,
           (CASE s.sexo WHEN 'M' THEN p.nascido_m ELSE p.nascido_f END)::integer AS nascido,
           COALESCE(CASE s.sexo WHEN 'M' THEN p.eutanasiado_m ELSE p.eutanasiado_f END, 0)::integer AS eutanasiado,
           (CASE s.sexo WHEN 'M' THEN p.desmamado_m ELSE p.desmamado_f END)::integer AS desmamado,
           COALESCE(reserva.entregue, 0)::integer AS entregue,
           COALESCE(reserva.pendente, 0)::integer AS pendente,
           COALESCE(estoque.nos_lotes, 0)::integer AS nos_lotes
      FROM "reproducao"."parto" p
      JOIN "reproducao"."casal" cs ON cs.id = p.id_casal
     CROSS JOIN (VALUES ('M'::char(1)), ('F'::char(1))) AS s (sexo)
      LEFT JOIN LATERAL (
        SELECT sum(CASE s.sexo WHEN 'M' THEN c.qtd_m ELSE c.qtd_f END) FILTER (WHERE r.dt_realizada IS NOT NULL) AS entregue,
               sum(CASE s.sexo WHEN 'M' THEN c.qtd_m ELSE c.qtd_f END) FILTER (WHERE r.dt_realizada IS NULL) AS pendente
          FROM "demanda"."compromisso" c
          JOIN "demanda"."remessa" r ON r.id = c.id_remessa
         WHERE c.id_parto = p.id
           AND c.dt_cancelamento IS NULL
      ) reserva ON true
      LEFT JOIN LATERAL (
        SELECT sum(lo.qtd) AS nos_lotes
          FROM "infra"."lote" lo
          JOIN "infra"."caixa" cx ON cx.id = lo.id_caixa
         WHERE lo.id_parto = p.id
           AND cx.sexo = s.sexo
      ) estoque ON true
     WHERE p.dt_parto_real IS NOT NULL
  ) b;

-- Por lote: o que passou para ele segundo o historico ('estoque', com idParto), de modo que
-- passou - qtd e quantos sairam dele na entrega; e quando os animais chegaram nele (dt_movimento).
-- A chegada e a data da primeira passagem, nunca antes do desmame e nunca depois do nascimento do
-- parto seguinte na mesma caixa do casal nem da primeira entrega do parto: o historico do casal BC
-- tem dt_hora semeado. Sem historico, vale a criacao do lote. O lote na propria caixa do casal (a
-- caixa que virou estoque) nao teve mudanca: dt_movimento nulo.
CREATE TEMP VIEW "lote_antigo" AS
SELECT lo.id AS id_lote,
       lo.id_parto,
       cx.sexo,
       lo.id_caixa,
       cs.id_caixa AS id_caixa_do_casal,
       lo.qtd::integer AS qtd,
       COALESCE(h.passou, lo.qtd)::integer AS passou,
       h.id_usuario,
       COALESCE(h.primeiro_registro, lo.dt_criacao) AS dt_registro,
       CASE
         WHEN lo.id_caixa = cs.id_caixa THEN NULL
         ELSE GREATEST(p.dt_desmame_real,
                       LEAST(COALESCE(h.primeira_passagem, (lo.dt_criacao AT TIME ZONE 'America/Sao_Paulo')::date),
                             seguinte.dt_parto_real,
                             entrega.primeira))
       END AS dt_movimento
  FROM "infra"."lote" lo
  JOIN "infra"."caixa" cx ON cx.id = lo.id_caixa
  JOIN "reproducao"."parto" p ON p.id = lo.id_parto
  JOIN "reproducao"."casal" cs ON cs.id = p.id_casal
  LEFT JOIN LATERAL (
    SELECT sum((hi.dados ->> 'qtd')::integer) AS passou,
           min(hi.dt_hora) AS primeiro_registro,
           (min(hi.dt_hora) AT TIME ZONE 'America/Sao_Paulo')::date AS primeira_passagem,
           (array_agg(hi.id_usuario ORDER BY hi.dt_hora, hi.id))[1] AS id_usuario
      FROM "auditoria"."historico" hi
     WHERE hi.entidade = 'caixa'
       AND hi.acao = 'estoque'
       AND hi.id_entidade = lo.id_caixa
       AND hi.dados ->> 'idParto' = lo.id_parto::text
       AND hi.dados ->> 'sexo' = cx.sexo
  ) h ON true
  LEFT JOIN LATERAL (
    SELECT min(px.dt_parto_real) AS dt_parto_real
      FROM "reproducao"."parto" px
      JOIN "reproducao"."casal" cy ON cy.id = px.id_casal
     WHERE cy.id_caixa = cs.id_caixa
       AND px.dt_parto_real > p.dt_parto_real
  ) seguinte ON true
  LEFT JOIN LATERAL (
    SELECT min(r.dt_realizada) AS primeira
      FROM "demanda"."compromisso" c
      JOIN "demanda"."remessa" r ON r.id = c.id_remessa
     WHERE c.id_parto = lo.id_parto
       AND c.dt_cancelamento IS NULL
  ) entrega ON true;

DO $precondicoes$
DECLARE
  v_falhas text;
BEGIN
  SELECT string_agg(falha, E'\n' ORDER BY falha)
    INTO v_falhas
    FROM (
      -- os status que a conversao sabe traduzir
      SELECT format('pedido %s: status %s', s.id, s.status) AS falha
        FROM "demanda"."solicitacao" s
       WHERE s.status NOT IN ('EN', 'AT', 'AP', 'CO', 'RE')

      -- uma remessa por pedido, com as quantidades dele
      UNION ALL
      SELECT format('pedido %s: %s remessas', r.id_solicitacao, count(*))
        FROM "demanda"."remessa" r
       GROUP BY r.id_solicitacao
      HAVING count(*) > 1
      UNION ALL
      SELECT format('pedido %s: a remessa %s tem quantidades diferentes das do pedido', s.id, r.id)
        FROM "demanda"."remessa" r
        JOIN "demanda"."solicitacao" s ON s.id = r.id_solicitacao
       WHERE (r.qtd_m_prevista, r.qtd_f_prevista, r.qtd_qualquer_prevista) <> (s.qtd_m, s.qtd_f, s.qtd_qualquer)

      -- concluido se e somente se a remessa foi realizada: e dela que vem a data da entrega
      UNION ALL
      SELECT format('pedido %s: status %s, remessa %s', s.id, s.status,
                    CASE WHEN r.dt_realizada IS NULL THEN 'nao realizada' ELSE 'realizada' END)
        FROM "demanda"."solicitacao" s
        LEFT JOIN "demanda"."remessa" r ON r.id_solicitacao = s.id
       WHERE (s.status = 'CO') <> (r.dt_realizada IS NOT NULL)

      -- compromisso ativo: de parto nascido, da linhagem do pedido, e pendente so em pedido
      -- com reserva (AP)
      UNION ALL
      SELECT format('compromisso %s: o parto %s nao nasceu', c.id, c.id_parto)
        FROM "demanda"."compromisso" c
        JOIN "reproducao"."parto" p ON p.id = c.id_parto
       WHERE c.dt_cancelamento IS NULL
         AND p.dt_parto_real IS NULL
      UNION ALL
      SELECT format('compromisso %s: o parto %s e de outra linhagem que o pedido %s', c.id, c.id_parto, s.id)
        FROM "demanda"."compromisso" c
        JOIN "demanda"."remessa" r ON r.id = c.id_remessa
        JOIN "demanda"."solicitacao" s ON s.id = r.id_solicitacao
        JOIN "reproducao"."parto" p ON p.id = c.id_parto
        JOIN "reproducao"."casal" cs ON cs.id = p.id_casal
       WHERE c.dt_cancelamento IS NULL
         AND cs.id_linhagem <> s.id_linhagem
      UNION ALL
      SELECT format('compromisso %s: reserva pendente no pedido %s, que esta com status %s', c.id, s.id, s.status)
        FROM "demanda"."compromisso" c
        JOIN "demanda"."remessa" r ON r.id = c.id_remessa
        JOIN "demanda"."solicitacao" s ON s.id = r.id_solicitacao
       WHERE c.dt_cancelamento IS NULL
         AND r.dt_realizada IS NULL
         AND s.status <> 'AP'

      -- as contagens do parto: nascimento com contagem, desmame com data e contagem juntas, e
      -- nenhuma conta impossivel (o que o Math.max do codigo antigo esconderia)
      UNION ALL
      SELECT format('parto %s: nasceu sem a contagem de machos e femeas', p.id)
        FROM "reproducao"."parto" p
       WHERE p.dt_parto_real IS NOT NULL
         AND (p.nascido_m IS NULL OR p.nascido_f IS NULL)
      UNION ALL
      SELECT format('parto %s: tem contagem ou desmame sem ter nascido', p.id)
        FROM "reproducao"."parto" p
       WHERE p.dt_parto_real IS NULL
         AND (COALESCE(p.nascido_m, p.nascido_f, p.eutanasiado_m, p.eutanasiado_f, p.desmamado_m, p.desmamado_f) IS NOT NULL
              OR p.dt_desmame_real IS NOT NULL)
      UNION ALL
      SELECT format('parto %s: desmame com a data e a contagem desencontradas', p.id)
        FROM "reproducao"."parto" p
       WHERE (p.dt_desmame_real IS NULL) <> (p.desmamado_m IS NULL)
          OR (p.desmamado_m IS NULL) <> (p.desmamado_f IS NULL)
      UNION ALL
      SELECT format('parto %s, %s: %s nascidos, %s eutanasiados e %s desmamados', pa.id_parto, pa.sexo,
                    pa.nascido, pa.eutanasiado, pa.desmamado)
        FROM parto_antigo pa
       WHERE pa.nascido < 0
          OR pa.eutanasiado < 0
          OR pa.eutanasiado > pa.nascido
          OR pa.desmamado < 0
          OR pa.desmamado > pa.nascido - pa.eutanasiado
      UNION ALL
      SELECT format('parto %s, %s: %s entregues e %s em caixas de estoque passam dos %s que restaram',
                    pa.id_parto, pa.sexo, pa.entregue, pa.nos_lotes, pa.oferta)
        FROM parto_antigo pa
       WHERE pa.entregue + pa.nos_lotes > pa.oferta

      -- caixa de estoque: ao menos um lote (e dele que sai a linhagem), uma linhagem so, da
      -- especie da caixa
      UNION ALL
      SELECT format('caixa %s: caixa de estoque sem lote', c.id)
        FROM "infra"."caixa" c
       WHERE c.tipo = 'E'
         AND NOT EXISTS (SELECT 1 FROM "infra"."lote" lo WHERE lo.id_caixa = c.id)
      UNION ALL
      SELECT format('caixa %s: lotes de %s linhagens', lo.id_caixa, count(DISTINCT cs.id_linhagem))
        FROM "infra"."lote" lo
        JOIN "reproducao"."parto" p ON p.id = lo.id_parto
        JOIN "reproducao"."casal" cs ON cs.id = p.id_casal
       GROUP BY lo.id_caixa
      HAVING count(DISTINCT cs.id_linhagem) > 1
      UNION ALL
      SELECT format('caixa %s: lote %s de outra especie', c.id, lo.id)
        FROM "infra"."lote" lo
        JOIN "infra"."caixa" c ON c.id = lo.id_caixa
        JOIN "reproducao"."parto" p ON p.id = lo.id_parto
        JOIN "reproducao"."casal" cs ON cs.id = p.id_casal
        JOIN "catalogo"."linhagem" l ON l.id = cs.id_linhagem
       WHERE l.id_especie <> c.id_especie

      -- lote so em caixa de estoque (a do proprio casal conta, quando ela virou estoque)
      UNION ALL
      SELECT format('lote %s: na caixa %s, que nao e de estoque', lo.id, lo.id_caixa)
        FROM "infra"."lote" lo
        JOIN "infra"."caixa" c ON c.id = lo.id_caixa
       WHERE c.tipo <> 'E'

      -- o historico explica a saida de cada lote: passou ao menos o que ficou, e o que saiu
      -- dos lotes esta entre os entregues
      UNION ALL
      SELECT format('lote %s: o historico registra %s passados e o lote tem %s', la.id_lote, la.passou, la.qtd)
        FROM lote_antigo la
       WHERE la.passou < la.qtd
      UNION ALL
      SELECT format('parto %s, %s: %s sairam das caixas de estoque e so %s foram entregues',
                    pa.id_parto, pa.sexo, saida.saiu, pa.entregue)
        FROM parto_antigo pa
        JOIN (
          SELECT la.id_parto, la.sexo, sum(la.passou - la.qtd) AS saiu
            FROM lote_antigo la
           GROUP BY la.id_parto, la.sexo
        ) saida ON saida.id_parto = pa.id_parto AND saida.sexo = pa.sexo
       WHERE saida.saiu > pa.entregue
    ) AS falhas;

  IF v_falhas IS NOT NULL THEN
    RAISE EXCEPTION E'A conversao para colonia por animal nao roda sobre estes dados:\n%', v_falhas;
  END IF;
END;
$precondicoes$;

-- ---------------------------------------------------------------------------
-- 2. Estrutura nova
-- ---------------------------------------------------------------------------

-- Pedido no lugar de solicitacao, no sistema todo. A tabela muda de nome com os dados e os ids, e
-- cada nome que o Prisma conhece (chave, FKs, indice) segue o nome novo, para o proximo diff sair
-- limpo. Os CHECKs de status e de regime saem na conversao e no fim.
ALTER TABLE "demanda"."solicitacao" RENAME TO "pedido";
ALTER SEQUENCE "demanda"."solicitacao_id_seq" RENAME TO "pedido_id_seq";
ALTER INDEX "demanda"."solicitacao_status_dt_desejada_idx" RENAME TO "pedido_status_dt_desejada_idx";
ALTER TABLE "demanda"."pedido" RENAME CONSTRAINT "solicitacao_pkey" TO "pedido_pkey";
ALTER TABLE "demanda"."pedido" RENAME CONSTRAINT "solicitacao_id_projeto_fkey" TO "pedido_id_projeto_fkey";
ALTER TABLE "demanda"."pedido" RENAME CONSTRAINT "solicitacao_id_usuario_solicitante_fkey" TO "pedido_id_usuario_solicitante_fkey";
ALTER TABLE "demanda"."pedido" RENAME CONSTRAINT "solicitacao_id_especie_fkey" TO "pedido_id_especie_fkey";
ALTER TABLE "demanda"."pedido" RENAME CONSTRAINT "solicitacao_id_especie_id_linhagem_fkey" TO "pedido_id_especie_id_linhagem_fkey";
ALTER TABLE "demanda"."pedido" RENAME CONSTRAINT "solicitacao_qtd_qualquer_nao_negativa" TO "pedido_qtd_qualquer_nao_negativa";
ALTER TABLE "demanda"."pedido" RENAME CONSTRAINT "solicitacao_ao_menos_um_animal" TO "pedido_ao_menos_um_animal";
ALTER TABLE "demanda"."pedido" RENAME CONSTRAINT "solicitacao_faixa_de_idade" TO "pedido_faixa_de_idade";

-- AlterTable
ALTER TABLE "demanda"."pedido" ADD COLUMN "dt_entrega" DATE;

-- AlterTable
ALTER TABLE "infra"."caixa" ADD COLUMN "dt_liberacao" DATE,
ADD COLUMN "id_linhagem" INTEGER,
ADD COLUMN "motivo_liberacao" VARCHAR(20),
ALTER COLUMN "codigo" SET DEFAULT '';

-- AlterTable
ALTER TABLE "reproducao"."parto" ADD COLUMN "dt_sem_ninhada" DATE,
ADD COLUMN "motivo_sem_ninhada" VARCHAR(200);

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "colonia";

-- CreateTable
CREATE TABLE "colonia"."animal" (
    "id" SERIAL NOT NULL,
    "id_parto" INTEGER NOT NULL,
    "sexo" CHAR(1) NOT NULL,
    "id_caixa" INTEGER NOT NULL,
    "dt_movimento" DATE,
    "situacao" VARCHAR(10) NOT NULL DEFAULT 'vivo',
    "dt_saida" DATE,
    "id_pedido" INTEGER,
    "dt_criacao" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dt_manutencao" TIMESTAMPTZ(6),

    CONSTRAINT "animal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "colonia"."ocorrencia" (
    "id" SERIAL NOT NULL,
    "tipo" VARCHAR(20) NOT NULL,
    "dt_fato" DATE NOT NULL,
    "id_usuario" INTEGER,
    "dt_registro" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id_parto" INTEGER,
    "id_caixa_origem" INTEGER,
    "id_caixa_destino" INTEGER,
    "id_pedido" INTEGER,
    "id_anulada" INTEGER,
    "motivo" VARCHAR(200),

    CONSTRAINT "ocorrencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "colonia"."ocorrencia_animal" (
    "id_ocorrencia" INTEGER NOT NULL,
    "id_animal" INTEGER NOT NULL,

    CONSTRAINT "ocorrencia_animal_pkey" PRIMARY KEY ("id_ocorrencia","id_animal")
);

-- CreateIndex
CREATE INDEX "animal_id_caixa_situacao_idx" ON "colonia"."animal"("id_caixa", "situacao");

-- CreateIndex
CREATE INDEX "animal_id_parto_sexo_idx" ON "colonia"."animal"("id_parto", "sexo");

-- CreateIndex
CREATE INDEX "animal_id_pedido_idx" ON "colonia"."animal"("id_pedido");

-- CreateIndex
CREATE UNIQUE INDEX "ocorrencia_id_anulada_key" ON "colonia"."ocorrencia"("id_anulada");

-- CreateIndex
CREATE INDEX "ocorrencia_id_parto_idx" ON "colonia"."ocorrencia"("id_parto");

-- CreateIndex
CREATE INDEX "ocorrencia_id_caixa_origem_idx" ON "colonia"."ocorrencia"("id_caixa_origem");

-- CreateIndex
CREATE INDEX "ocorrencia_id_caixa_destino_idx" ON "colonia"."ocorrencia"("id_caixa_destino");

-- CreateIndex
CREATE INDEX "ocorrencia_id_pedido_idx" ON "colonia"."ocorrencia"("id_pedido");

-- CreateIndex
CREATE INDEX "ocorrencia_dt_fato_idx" ON "colonia"."ocorrencia"("dt_fato");

-- CreateIndex
CREATE INDEX "ocorrencia_animal_id_animal_idx" ON "colonia"."ocorrencia_animal"("id_animal");

-- AddForeignKey
ALTER TABLE "infra"."caixa" ADD CONSTRAINT "caixa_id_linhagem_fkey" FOREIGN KEY ("id_linhagem") REFERENCES "catalogo"."linhagem"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "colonia"."animal" ADD CONSTRAINT "animal_id_parto_fkey" FOREIGN KEY ("id_parto") REFERENCES "reproducao"."parto"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "colonia"."animal" ADD CONSTRAINT "animal_id_caixa_fkey" FOREIGN KEY ("id_caixa") REFERENCES "infra"."caixa"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "colonia"."animal" ADD CONSTRAINT "animal_id_pedido_fkey" FOREIGN KEY ("id_pedido") REFERENCES "demanda"."pedido"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "colonia"."ocorrencia" ADD CONSTRAINT "ocorrencia_id_usuario_fkey" FOREIGN KEY ("id_usuario") REFERENCES "login"."usuario"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "colonia"."ocorrencia" ADD CONSTRAINT "ocorrencia_id_parto_fkey" FOREIGN KEY ("id_parto") REFERENCES "reproducao"."parto"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "colonia"."ocorrencia" ADD CONSTRAINT "ocorrencia_id_caixa_origem_fkey" FOREIGN KEY ("id_caixa_origem") REFERENCES "infra"."caixa"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "colonia"."ocorrencia" ADD CONSTRAINT "ocorrencia_id_caixa_destino_fkey" FOREIGN KEY ("id_caixa_destino") REFERENCES "infra"."caixa"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "colonia"."ocorrencia" ADD CONSTRAINT "ocorrencia_id_pedido_fkey" FOREIGN KEY ("id_pedido") REFERENCES "demanda"."pedido"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "colonia"."ocorrencia" ADD CONSTRAINT "ocorrencia_id_anulada_fkey" FOREIGN KEY ("id_anulada") REFERENCES "colonia"."ocorrencia"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "colonia"."ocorrencia_animal" ADD CONSTRAINT "ocorrencia_animal_id_ocorrencia_fkey" FOREIGN KEY ("id_ocorrencia") REFERENCES "colonia"."ocorrencia"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "colonia"."ocorrencia_animal" ADD CONSTRAINT "ocorrencia_animal_id_animal_fkey" FOREIGN KEY ("id_animal") REFERENCES "colonia"."animal"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- O codigo da posicao, a mesma formula de codigoDaPosicao (src/modules/infra/endereco.ts): face
-- (F frontal, T traseira), linha e a letra da coluna, com a traseira continuando as letras da
-- frontal. Nulo quando a topologia passa das 26 letras. Usada pelo trigger da topologia e pela
-- conferencia da conversao.
CREATE FUNCTION "infra"."codigo_da_posicao"(p_face integer, p_linha integer, p_coluna integer, p_colunas integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
           WHEN (p_face - 1) * p_colunas + (p_coluna - 1) BETWEEN 0 AND 25
           THEN CASE WHEN p_face = 1 THEN 'F' ELSE 'T' END
                || p_linha
                || chr(ascii('A') + (p_face - 1) * p_colunas + (p_coluna - 1))
         END
$fn$;

-- Onde um animal vivo pode estar: em caixa ativa da especie dele; na caixa de estoque, so do sexo
-- e da linhagem dela; na caixa de casal, so filhote do proprio casal. Devolve o motivo da recusa,
-- ou nulo quando o lugar serve. Usada pelo trigger colonia.animal_coerente e pela conferencia da
-- conversao.
--
-- O trigger confere o lugar quando o animal se mexe. O lado da caixa e do codigo, como as outras
-- regras de caixa: liberar so sem vivo dentro, e a especie, o sexo e a linhagem da caixa, que nao
-- mudam depois de gravados. Por isso le a caixa com FOR SHARE: quem libera a caixa ou a vira de
-- estoque trava a linha com FOR UPDATE e conta os vivos, entao um espera o outro, e quem chega
-- depois de uma liberacao ve a caixa inativa.
-- Quem mexe em mais de uma caixa na mesma transacao trava todas antes, em ordem de id: duas mudancas
-- em sentidos opostos (A para B e B para A) ficam em fila, em vez de uma esperar a outra (deadlock).
CREATE FUNCTION "colonia"."lugar_recusado"(p_id_parto integer, p_sexo char(1), p_id_caixa integer)
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_parto record;
  v_caixa record;
BEGIN
  SELECT cs.id_caixa AS id_caixa_do_casal, cs.id_linhagem, l.id_especie, l.nome AS linhagem
    INTO v_parto
    FROM "reproducao"."parto" p
    JOIN "reproducao"."casal" cs ON cs.id = p.id_casal
    JOIN "catalogo"."linhagem" l ON l.id = cs.id_linhagem
   WHERE p.id = p_id_parto;

  IF NOT FOUND THEN
    -- parto inexistente e problema da FK, nao desta regra
    RETURN NULL;
  END IF;

  SELECT c.codigo, c.ativa, c.tipo, c.sexo, c.id_linhagem, c.id_especie, l.nome AS linhagem
    INTO v_caixa
    FROM "infra"."caixa" c
    LEFT JOIN "catalogo"."linhagem" l ON l.id = c.id_linhagem
   WHERE c.id = p_id_caixa
     FOR SHARE OF c;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT v_caixa.ativa THEN
    RETURN format('a caixa %s ja foi liberada, e animal vivo so fica em caixa ativa', v_caixa.codigo);
  END IF;

  IF v_caixa.id_especie <> v_parto.id_especie THEN
    RETURN format('a caixa %s e de outra especie', v_caixa.codigo);
  END IF;

  IF v_caixa.tipo = 'estoque' AND (v_caixa.sexo <> p_sexo OR v_caixa.id_linhagem <> v_parto.id_linhagem) THEN
    RETURN format('a caixa de estoque %s guarda %s %s, e este animal e %s %s', v_caixa.codigo,
                  CASE v_caixa.sexo WHEN 'M' THEN 'machos' ELSE 'femeas' END, v_caixa.linhagem,
                  CASE p_sexo WHEN 'M' THEN 'macho' ELSE 'femea' END, v_parto.linhagem);
  END IF;

  IF v_caixa.tipo = 'casal' AND p_id_caixa <> v_parto.id_caixa_do_casal THEN
    RETURN format('a caixa de casal %s so guarda a ninhada do proprio casal', v_caixa.codigo);
  END IF;

  RETURN NULL;
END;
$fn$;

-- O pedido coerente com os seus animais. Com este status, esta linhagem e estas quantidades, o
-- pedido tem de ficar assim:
--   - todo animal do pedido, vivo, morto ou entregue, e da linhagem dele: a linhagem (e com ela a
--     especie, pela FK composta) nao muda depois da primeira reserva;
--   - os vivos mais os entregues nao passam do que ele pede (o mesmo teto do trigger do animal,
--     visto do pedido);
--   - o pedido que ja entregou animais fica entregue: entregue e final, como no animal;
--   - reservado: os vivos reservados cobrem o pedido exatamente (M >= qtd_m, F >= qtd_f e
--     M + F = total, o qualquer virando M ou F);
--   - entregue: nenhum vivo reservado, e os entregues cobrem o pedido exatamente;
--   - enviado, aprovado ou recusado: nenhum vivo reservado. So o pedido reservado segura animal; a
--     reserva entra com o pedido aprovado e ele passa a reservado na mesma transacao.
-- Quem vem depois de quem no status e regra do codigo. Devolve a recusa ja com o prefixo do erro da
-- API ('PEDIDO_INCOMPLETO: ...'), ou nulo quando o pedido fica coerente. Usada pelo trigger
-- demanda.pedido_coerente e pela conferencia da conversao.
CREATE FUNCTION "demanda"."pedido_recusado"(
  p_id integer, p_status text, p_id_linhagem integer, p_qtd_m integer, p_qtd_f integer, p_qtd_qualquer integer)
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_total          integer := p_qtd_m + p_qtd_f + p_qtd_qualquer;
  v_vivos_m        integer;
  v_vivos_f        integer;
  v_entregues_m    integer;
  v_entregues_f    integer;
  v_outra_linhagem integer;
BEGIN
  SELECT count(*) FILTER (WHERE a.situacao = 'vivo' AND a.sexo = 'M'),
         count(*) FILTER (WHERE a.situacao = 'vivo' AND a.sexo = 'F'),
         count(*) FILTER (WHERE a.situacao = 'entregue' AND a.sexo = 'M'),
         count(*) FILTER (WHERE a.situacao = 'entregue' AND a.sexo = 'F'),
         count(*) FILTER (WHERE cs.id_linhagem <> p_id_linhagem)
    INTO v_vivos_m, v_vivos_f, v_entregues_m, v_entregues_f, v_outra_linhagem
    FROM "colonia"."animal" a
    JOIN "reproducao"."parto" p ON p.id = a.id_parto
    JOIN "reproducao"."casal" cs ON cs.id = p.id_casal
   WHERE a.id_pedido = p_id;

  IF v_outra_linhagem > 0 THEN
    RETURN format('PEDIDO_RESERVA: o pedido %s tem %s animais de outra linhagem: a linhagem do pedido nao muda depois da reserva',
                  p_id, v_outra_linhagem);
  END IF;

  IF v_vivos_m + v_entregues_m > p_qtd_m + p_qtd_qualquer
     OR v_vivos_f + v_entregues_f > p_qtd_f + p_qtd_qualquer
     OR v_vivos_m + v_vivos_f + v_entregues_m + v_entregues_f > v_total THEN
    RETURN format('PEDIDO_EXCEDIDO: o pedido %s ficaria pedindo %s machos, %s femeas e %s de qualquer sexo, e ja tem %s machos e %s femeas reservados ou entregues',
                  p_id, p_qtd_m, p_qtd_f, p_qtd_qualquer, v_vivos_m + v_entregues_m, v_vivos_f + v_entregues_f);
  END IF;

  IF p_status <> 'entregue' AND v_entregues_m + v_entregues_f > 0 THEN
    RETURN format('PEDIDO_ENTREGUE: o pedido %s ja entregou %s animais, e pedido entregue continua entregue',
                  p_id, v_entregues_m + v_entregues_f);
  END IF;

  IF p_status = 'reservado'
     AND NOT (v_vivos_m >= p_qtd_m AND v_vivos_f >= p_qtd_f AND v_vivos_m + v_vivos_f = v_total) THEN
    RETURN format('PEDIDO_INCOMPLETO: o pedido %s pede %s machos, %s femeas e %s de qualquer sexo, e tem %s machos e %s femeas reservados',
                  p_id, p_qtd_m, p_qtd_f, p_qtd_qualquer, v_vivos_m, v_vivos_f);
  END IF;

  IF p_status = 'entregue' AND v_vivos_m + v_vivos_f > 0 THEN
    RETURN format('PEDIDO_INCOMPLETO: o pedido %s ainda tem %s animais reservados que nao foram entregues',
                  p_id, v_vivos_m + v_vivos_f);
  END IF;

  IF p_status = 'entregue'
     AND NOT (v_entregues_m >= p_qtd_m AND v_entregues_f >= p_qtd_f AND v_entregues_m + v_entregues_f = v_total) THEN
    RETURN format('PEDIDO_INCOMPLETO: o pedido %s pede %s machos, %s femeas e %s de qualquer sexo, e foram entregues %s machos e %s femeas',
                  p_id, p_qtd_m, p_qtd_f, p_qtd_qualquer, v_entregues_m, v_entregues_f);
  END IF;

  IF p_status NOT IN ('reservado', 'entregue') AND v_vivos_m + v_vivos_f > 0 THEN
    RETURN format('PEDIDO_COM_RESERVA: o pedido %s ainda tem %s animais reservados: desfaca a reserva antes',
                  p_id, v_vivos_m + v_vivos_f);
  END IF;

  RETURN NULL;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Conversao
-- ---------------------------------------------------------------------------

-- 3.1 Caixa. O tipo passa a guardar a palavra. Os dois CHECKs antigos saem antes, porque falam
-- C e E; os novos entram no fim. A caixa de estoque ganha a linhagem dos seus lotes (a
-- pre-condicao garante uma so). A data e o motivo da caixa ja liberada vem depois dos animais
-- (3.5), porque a da caixa enviada e a da entrega que a esvaziou.
ALTER TABLE "infra"."caixa" DROP CONSTRAINT "caixa_tipo_dominio",
DROP CONSTRAINT "caixa_sexo_do_estoque";

ALTER TABLE "infra"."caixa" ALTER COLUMN "tipo" DROP DEFAULT;

ALTER TABLE "infra"."caixa" ALTER COLUMN "tipo" SET DATA TYPE VARCHAR(10)
  USING (CASE "tipo" WHEN 'C' THEN 'casal' WHEN 'E' THEN 'estoque' END);

ALTER TABLE "infra"."caixa" ALTER COLUMN "tipo" SET DEFAULT 'casal';

UPDATE "infra"."caixa" c
   SET id_linhagem = da_caixa.id_linhagem
  FROM (
    SELECT DISTINCT lo.id_caixa, cs.id_linhagem
      FROM "infra"."lote" lo
      JOIN "reproducao"."parto" p ON p.id = lo.id_parto
      JOIN "reproducao"."casal" cs ON cs.id = p.id_casal
  ) da_caixa
 WHERE da_caixa.id_caixa = c.id
   AND c.tipo = 'estoque';

-- 3.2 Casal: ativo e o mesmo que nao ter data de encerramento
UPDATE "reproducao"."casal"
   SET ativo = (dt_encerramento IS NULL)
 WHERE ativo <> (dt_encerramento IS NULL);

-- 3.3 Pedido: o status passa a guardar a palavra. Em atendimento (AT) era aprovado sem animais;
-- aprovado (AP) era com os animais reservados. A data da entrega vem da remessa realizada.
ALTER TABLE "demanda"."pedido" DROP CONSTRAINT "solicitacao_status_dominio";

ALTER TABLE "demanda"."pedido" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "demanda"."pedido" ALTER COLUMN "status" SET DATA TYPE VARCHAR(10)
  USING (CASE "status"
           WHEN 'EN' THEN 'enviado'
           WHEN 'AT' THEN 'aprovado'
           WHEN 'AP' THEN 'reservado'
           WHEN 'CO' THEN 'entregue'
           WHEN 'RE' THEN 'recusado'
         END);

ALTER TABLE "demanda"."pedido" ALTER COLUMN "status" SET DEFAULT 'enviado';

UPDATE "demanda"."pedido" pe
   SET dt_entrega = r.dt_realizada
  FROM "demanda"."remessa" r
 WHERE r.id_solicitacao = pe.id
   AND pe.status = 'entregue';

-- 3.4 Animais. Para cada parto nascido e cada sexo, nesta ordem:
--   a) os eutanasiados na selecao: mortos na caixa do casal, na data da selecao;
--   b) os que nao chegaram ao desmame (a diferenca que o modelo antigo engolia): mortos na data
--      do desmame;
--   c) os entregues de cada compromisso entregue, em ordem de id. Saem primeiro dos lotes que a
--      entrega baixou (passou - qtd de cada lote, em ordem de lote), levando a chegada do lote; o
--      resto saiu da caixa do casal;
--   d) os vivos na caixa do casal: oferta - entregue - lotes;
--   e) os vivos de cada lote, na caixa do lote, com a chegada do lote;
--   f) a reserva pendente de cada compromisso, em ordem de id: marca os vivos livres do parto e
--      do sexo por ordem de id, que e a caixa do casal primeiro e depois os lotes por id, o mesmo
--      FIFO que a tela mostrava. Se faltar vivo, a falta fica com o pedido (aviso na conferencia).
-- Cada linha criada fica anotada em animal_convertido, que as ocorrencias usam em seguida.

CREATE TEMP TABLE "animal_convertido" (
  id_animal      integer PRIMARY KEY,
  -- selecao | perda | entregue | vivo
  faixa          text NOT NULL,
  -- o lote de onde o entregue saiu, ou onde o vivo esta
  id_lote        integer,
  -- o compromisso que entregou ou reservou o animal
  id_compromisso integer
);

-- Quantos dos que sairam de cada lote ainda nao foram atribuidos a uma entrega
CREATE TEMP TABLE "saida_do_lote" AS
SELECT la.id_lote, la.id_parto, la.sexo, la.id_caixa, la.dt_movimento, la.passou - la.qtd AS restante
  FROM lote_antigo la;

CREATE FUNCTION pg_temp.criar_animais(
  p_id_parto integer, p_sexo char(1), p_qtd integer, p_id_caixa integer, p_situacao text,
  p_dt_movimento date, p_dt_saida date, p_id_pedido integer,
  p_faixa text, p_id_lote integer, p_id_compromisso integer)
RETURNS void
LANGUAGE sql
AS $fn$
  WITH novos AS (
    INSERT INTO "colonia"."animal" (id_parto, sexo, id_caixa, situacao, dt_movimento, dt_saida, id_pedido)
    SELECT p_id_parto, p_sexo, p_id_caixa, p_situacao, p_dt_movimento, p_dt_saida, p_id_pedido
      FROM generate_series(1, p_qtd)
    RETURNING id
  )
  INSERT INTO animal_convertido (id_animal, faixa, id_lote, id_compromisso)
  SELECT novos.id, p_faixa, p_id_lote, p_id_compromisso FROM novos;
$fn$;

DO $animais$
DECLARE
  v_parto record;
  v_reserva record;
  v_lote record;
  v_faltam integer;
  v_qtd integer;
BEGIN
  FOR v_parto IN SELECT * FROM parto_antigo ORDER BY id_parto, sexo DESC LOOP
    -- a) selecao
    PERFORM pg_temp.criar_animais(v_parto.id_parto, v_parto.sexo, v_parto.eutanasiado,
      v_parto.id_caixa_do_casal, 'morto', NULL, v_parto.dt_selecao, NULL, 'selecao', NULL, NULL);

    -- b) nao chegaram ao desmame
    PERFORM pg_temp.criar_animais(v_parto.id_parto, v_parto.sexo, v_parto.perda,
      v_parto.id_caixa_do_casal, 'morto', NULL, v_parto.dt_desmame_real, NULL, 'perda', NULL, NULL);

    -- c) entregues
    FOR v_reserva IN
      SELECT c.id, r.id_solicitacao AS id_pedido, r.dt_realizada,
             (CASE v_parto.sexo WHEN 'M' THEN c.qtd_m ELSE c.qtd_f END)::integer AS qtd
        FROM "demanda"."compromisso" c
        JOIN "demanda"."remessa" r ON r.id = c.id_remessa
       WHERE c.id_parto = v_parto.id_parto
         AND c.dt_cancelamento IS NULL
         AND r.dt_realizada IS NOT NULL
       ORDER BY c.id
    LOOP
      v_faltam := v_reserva.qtd;

      FOR v_lote IN
        SELECT * FROM saida_do_lote
         WHERE id_parto = v_parto.id_parto AND sexo = v_parto.sexo AND restante > 0
         ORDER BY id_lote
      LOOP
        EXIT WHEN v_faltam = 0;
        v_qtd := LEAST(v_faltam, v_lote.restante);

        PERFORM pg_temp.criar_animais(v_parto.id_parto, v_parto.sexo, v_qtd, v_lote.id_caixa, 'entregue',
          v_lote.dt_movimento, v_reserva.dt_realizada, v_reserva.id_pedido, 'entregue', v_lote.id_lote, v_reserva.id);

        UPDATE saida_do_lote SET restante = restante - v_qtd WHERE id_lote = v_lote.id_lote;
        v_faltam := v_faltam - v_qtd;
      END LOOP;

      PERFORM pg_temp.criar_animais(v_parto.id_parto, v_parto.sexo, v_faltam, v_parto.id_caixa_do_casal,
        'entregue', NULL, v_reserva.dt_realizada, v_reserva.id_pedido, 'entregue', NULL, v_reserva.id);
    END LOOP;

    -- d) vivos na caixa do casal
    PERFORM pg_temp.criar_animais(v_parto.id_parto, v_parto.sexo, v_parto.vivos_na_caixa_do_casal,
      v_parto.id_caixa_do_casal, 'vivo', NULL, NULL, NULL, 'vivo', NULL, NULL);

    -- e) vivos de cada lote
    FOR v_lote IN
      SELECT * FROM lote_antigo WHERE id_parto = v_parto.id_parto AND sexo = v_parto.sexo ORDER BY id_lote
    LOOP
      PERFORM pg_temp.criar_animais(v_parto.id_parto, v_parto.sexo, v_lote.qtd, v_lote.id_caixa, 'vivo',
        v_lote.dt_movimento, NULL, NULL, 'vivo', v_lote.id_lote, NULL);
    END LOOP;

    -- f) reserva pendente
    FOR v_reserva IN
      SELECT c.id, r.id_solicitacao AS id_pedido,
             (CASE v_parto.sexo WHEN 'M' THEN c.qtd_m ELSE c.qtd_f END)::integer AS qtd
        FROM "demanda"."compromisso" c
        JOIN "demanda"."remessa" r ON r.id = c.id_remessa
       WHERE c.id_parto = v_parto.id_parto
         AND c.dt_cancelamento IS NULL
         AND r.dt_realizada IS NULL
       ORDER BY c.id
    LOOP
      WITH marcados AS (
        UPDATE "colonia"."animal" a
           SET id_pedido = v_reserva.id_pedido
         WHERE a.id IN (
           SELECT livre.id
             FROM "colonia"."animal" livre
            WHERE livre.id_parto = v_parto.id_parto
              AND livre.sexo = v_parto.sexo
              AND livre.situacao = 'vivo'
              AND livre.id_pedido IS NULL
            ORDER BY livre.id
            LIMIT v_reserva.qtd)
        RETURNING a.id
      )
      UPDATE animal_convertido ac
         SET id_compromisso = v_reserva.id
        FROM marcados
       WHERE marcados.id = ac.id_animal;
    END LOOP;
  END LOOP;
END;
$animais$;

-- 3.5 Caixa ja liberada: a data e o motivo do fato que a esvaziou. A enviada (estado X) foi
-- esvaziada pela entrega, e a data e a da ultima entrega que saiu dela, de onde o Kanban conta os
-- dias em Enviado; o resto foi o casal encerrado. Sem entrega que tenha saido dela, vale a linha
-- 'liberacao' do historico, ou a ultima manutencao, ou a criacao, em Brasilia.
UPDATE "infra"."caixa" c
   SET dt_liberacao = COALESCE(
         CASE WHEN c.estado = 'X' THEN
           (SELECT max(a.dt_saida)
              FROM "colonia"."animal" a
             WHERE a.id_caixa = c.id
               AND a.situacao = 'entregue')
         END,
         (COALESCE(
            (SELECT max(h.dt_hora)
               FROM "auditoria"."historico" h
              WHERE h.entidade = 'caixa'
                AND h.acao = 'liberacao'
                AND h.id_entidade = c.id),
            c.dt_manutencao,
            c.dt_criacao) AT TIME ZONE 'America/Sao_Paulo')::date),
       motivo_liberacao = CASE WHEN c.estado = 'X' THEN 'entrega' ELSE 'casal_encerrado' END
 WHERE NOT c.ativa;

-- 3.6 Ocorrencias, com usuario e carimbo copiados de onde existem (sem carimbo, a hora desta
-- conversao; sem usuario, nulo, que a tela mostra como Sistema):
--   nascimento por parto nascido, com todos os animais do parto;
--   baixa da selecao por parto com eutanasia, e baixa 'nao chegou ao desmame' para a perda;
--   mudanca por lote fora da caixa do casal, com os vivos do lote e os entregues que sairam dele;
--   reserva por compromisso, com os animais que ele entregou ou reservou;
--   entrega por pedido entregue, com o usuario da linha 'entrega' do historico.
-- Compromisso cancelado nao vira nada e fica no historico.

CREATE FUNCTION pg_temp.lancar_ocorrencia(
  p_tipo text, p_dt_fato date, p_id_usuario integer, p_dt_registro timestamptz,
  p_id_parto integer, p_id_caixa_origem integer, p_id_caixa_destino integer,
  p_id_pedido integer, p_motivo text, p_animais integer[])
RETURNS void
LANGUAGE sql
AS $fn$
  WITH nova AS (
    INSERT INTO "colonia"."ocorrencia"
      (tipo, dt_fato, id_usuario, dt_registro, id_parto, id_caixa_origem, id_caixa_destino, id_pedido, motivo)
    VALUES
      (p_tipo, p_dt_fato, p_id_usuario, COALESCE(p_dt_registro, now()), p_id_parto, p_id_caixa_origem,
       p_id_caixa_destino, p_id_pedido, p_motivo)
    RETURNING id
  )
  INSERT INTO "colonia"."ocorrencia_animal" (id_ocorrencia, id_animal)
  SELECT nova.id, animal.id FROM nova CROSS JOIN unnest(p_animais) AS animal (id);
$fn$;

DO $ocorrencias$
BEGIN
  PERFORM pg_temp.lancar_ocorrencia('nascimento', p.dt_parto_real, p.id_usuario_parto, p.dt_registro_parto,
            p.id, NULL, cs.id_caixa, NULL, NULL,
            ARRAY(SELECT a.id FROM "colonia"."animal" a WHERE a.id_parto = p.id ORDER BY a.id))
     FROM "reproducao"."parto" p
     JOIN "reproducao"."casal" cs ON cs.id = p.id_casal
    WHERE p.dt_parto_real IS NOT NULL
    ORDER BY p.id;

  PERFORM pg_temp.lancar_ocorrencia('baixa', COALESCE(p.dt_selecao, p.dt_parto_real), p.id_usuario_selecao,
            p.dt_registro_selecao, p.id, cs.id_caixa, NULL, NULL, 'eutanasia de selecao', baixa.animais)
     FROM "reproducao"."parto" p
     JOIN "reproducao"."casal" cs ON cs.id = p.id_casal
     JOIN LATERAL (
       SELECT array_agg(ac.id_animal ORDER BY ac.id_animal) AS animais
         FROM animal_convertido ac
         JOIN "colonia"."animal" a ON a.id = ac.id_animal
        WHERE a.id_parto = p.id AND ac.faixa = 'selecao'
     ) baixa ON baixa.animais IS NOT NULL
    ORDER BY p.id;

  PERFORM pg_temp.lancar_ocorrencia('baixa', p.dt_desmame_real, p.id_usuario_desmame, p.dt_registro_desmame,
            p.id, cs.id_caixa, NULL, NULL, 'nao chegou ao desmame', baixa.animais)
     FROM "reproducao"."parto" p
     JOIN "reproducao"."casal" cs ON cs.id = p.id_casal
     JOIN LATERAL (
       SELECT array_agg(ac.id_animal ORDER BY ac.id_animal) AS animais
         FROM animal_convertido ac
         JOIN "colonia"."animal" a ON a.id = ac.id_animal
        WHERE a.id_parto = p.id AND ac.faixa = 'perda'
     ) baixa ON baixa.animais IS NOT NULL
    ORDER BY p.id;

  PERFORM pg_temp.lancar_ocorrencia('mudanca', la.dt_movimento, la.id_usuario, la.dt_registro,
            la.id_parto, la.id_caixa_do_casal, la.id_caixa, NULL, NULL, mudanca.animais)
     FROM lote_antigo la
     JOIN LATERAL (
       SELECT array_agg(ac.id_animal ORDER BY ac.id_animal) AS animais
         FROM animal_convertido ac
        WHERE ac.id_lote = la.id_lote
     ) mudanca ON mudanca.animais IS NOT NULL
    WHERE la.id_caixa <> la.id_caixa_do_casal
    ORDER BY la.id_lote;

  PERFORM pg_temp.lancar_ocorrencia('reserva', (c.dt_criacao AT TIME ZONE 'America/Sao_Paulo')::date,
            c.id_usuario_criacao, c.dt_criacao, c.id_parto, NULL, NULL, r.id_solicitacao, NULL, reserva.animais)
     FROM "demanda"."compromisso" c
     JOIN "demanda"."remessa" r ON r.id = c.id_remessa
     JOIN LATERAL (
       SELECT array_agg(ac.id_animal ORDER BY ac.id_animal) AS animais
         FROM animal_convertido ac
        WHERE ac.id_compromisso = c.id
     ) reserva ON reserva.animais IS NOT NULL
    WHERE c.dt_cancelamento IS NULL
    ORDER BY c.id;

  PERFORM pg_temp.lancar_ocorrencia('entrega', pe.dt_entrega, h.id_usuario, h.dt_hora,
            NULL, NULL, NULL, pe.id, NULL, entrega.animais)
     FROM "demanda"."pedido" pe
     LEFT JOIN LATERAL (
       SELECT hi.id_usuario, hi.dt_hora
         FROM "auditoria"."historico" hi
        WHERE hi.entidade = 'solicitacao'
          AND hi.acao = 'entrega'
          AND hi.id_entidade = pe.id
        ORDER BY hi.dt_hora DESC
        LIMIT 1
     ) h ON true
     JOIN LATERAL (
       SELECT array_agg(a.id ORDER BY a.id) AS animais
         FROM "colonia"."animal" a
        WHERE a.id_pedido = pe.id AND a.situacao = 'entregue'
     ) entrega ON entrega.animais IS NOT NULL
    WHERE pe.status = 'entregue'
    ORDER BY pe.id;
END;
$ocorrencias$;

-- 3.7 Historico: a entidade solicitacao passa a se chamar pedido
UPDATE "auditoria"."historico" SET entidade = 'pedido' WHERE entidade = 'solicitacao';

-- ---------------------------------------------------------------------------
-- 4. Conferencia
--
-- Confere o modelo novo contra o antigo, que ainda esta inteiro, sem nenhum numero fixo. Se algo
-- nao fechar, a migration para aqui e nada muda. Avisos (falta de reserva que ja existia, coluna
-- do Kanban diferente do estado gravado) saem como NOTICE e nao barram.
-- ---------------------------------------------------------------------------

-- Cada pedido pela regra do trigger do pedido, que so olha as mudancas que vierem depois. Falta e o
-- pedido reservado com menos vivos reservados do que pede: com o teto e o entregue em ordem, e o que
-- sobra do PEDIDO_INCOMPLETO de um reservado.
CREATE TEMP VIEW "pedido_conferido" AS
SELECT pe.id, pe.status, r.recusa,
       COALESCE(pe.status = 'reservado' AND r.recusa LIKE 'PEDIDO_INCOMPLETO:%', false) AS falta
  FROM "demanda"."pedido" pe
 CROSS JOIN LATERAL (
   SELECT "demanda"."pedido_recusado"(pe.id, pe.status, pe.id_linhagem, pe.qtd_m, pe.qtd_f, pe.qtd_qualquer) AS recusa
 ) r;

DO $confere$
DECLARE
  v_falhas text;
  v_avisos text;
BEGIN
  WITH contado AS (
    SELECT a.id_parto, a.sexo,
           count(*)::integer AS animais,
           count(*) FILTER (WHERE a.situacao IN ('vivo', 'entregue'))::integer AS restaram,
           count(*) FILTER (WHERE a.situacao = 'entregue')::integer AS entregues
      FROM "colonia"."animal" a
     GROUP BY a.id_parto, a.sexo
  ),
  baixado AS (
    SELECT o.id_parto, a.sexo, o.motivo, count(*)::integer AS animais
      FROM "colonia"."ocorrencia" o
      JOIN "colonia"."ocorrencia_animal" oa ON oa.id_ocorrencia = o.id
      JOIN "colonia"."animal" a ON a.id = oa.id_animal
     WHERE o.tipo = 'baixa'
     GROUP BY o.id_parto, a.sexo, o.motivo
  ),
  vivos_esperados AS (
    SELECT id_parto, sexo, id_caixa, sum(vivos)::integer AS vivos
      FROM (
        SELECT id_parto, sexo, id_caixa_do_casal AS id_caixa, vivos_na_caixa_do_casal AS vivos FROM parto_antigo
        UNION ALL
        SELECT id_parto, sexo, id_caixa, qtd FROM lote_antigo
      ) esperado
     GROUP BY id_parto, sexo, id_caixa
  ),
  vivos_contados AS (
    SELECT a.id_parto, a.sexo, a.id_caixa, count(*)::integer AS vivos
      FROM "colonia"."animal" a
     WHERE a.situacao = 'vivo'
     GROUP BY a.id_parto, a.sexo, a.id_caixa
  ),
  pedido_esperado AS (
    SELECT r.id_solicitacao AS id_pedido, s.sexo,
           COALESCE(sum(CASE s.sexo WHEN 'M' THEN c.qtd_m ELSE c.qtd_f END) FILTER (WHERE r.dt_realizada IS NOT NULL), 0)::integer AS entregues,
           COALESCE(sum(CASE s.sexo WHEN 'M' THEN c.qtd_m ELSE c.qtd_f END) FILTER (WHERE r.dt_realizada IS NULL), 0)::integer AS pendentes
      FROM "demanda"."compromisso" c
      JOIN "demanda"."remessa" r ON r.id = c.id_remessa
     CROSS JOIN (VALUES ('M'::char(1)), ('F'::char(1))) AS s (sexo)
     WHERE c.dt_cancelamento IS NULL
     GROUP BY r.id_solicitacao, s.sexo
  ),
  pedido_contado AS (
    SELECT a.id_pedido, a.sexo,
           count(*) FILTER (WHERE a.situacao = 'entregue')::integer AS entregues,
           count(*) FILTER (WHERE a.situacao = 'vivo')::integer AS reservados
      FROM "colonia"."animal" a
     WHERE a.id_pedido IS NOT NULL
     GROUP BY a.id_pedido, a.sexo
  ),
  trilha AS (
    SELECT a.id, a.situacao, a.id_pedido, a.dt_movimento,
           count(o.id) FILTER (WHERE o.tipo = 'nascimento') AS nascimentos,
           count(o.id) FILTER (WHERE o.tipo = 'baixa') AS baixas,
           count(o.id) FILTER (WHERE o.tipo = 'mudanca') AS mudancas,
           count(o.id) FILTER (WHERE o.tipo = 'reserva') AS reservas,
           count(o.id) FILTER (WHERE o.tipo = 'entrega') AS entregas
      FROM "colonia"."animal" a
      LEFT JOIN "colonia"."ocorrencia_animal" oa ON oa.id_animal = a.id
      LEFT JOIN "colonia"."ocorrencia" o ON o.id = oa.id_ocorrencia
     GROUP BY a.id
  )
  SELECT string_agg(falha, E'\n' ORDER BY falha)
    INTO v_falhas
    FROM (
      -- por parto e sexo: uma linha por nascido; vivos e entregues somam o que restou; os
      -- entregues batem com os compromissos entregues
      SELECT format('parto %s, %s: %s animais para %s nascidos', pa.id_parto, pa.sexo, COALESCE(c.animais, 0), pa.nascido) AS falha
        FROM parto_antigo pa
        LEFT JOIN contado c ON c.id_parto = pa.id_parto AND c.sexo = pa.sexo
       WHERE COALESCE(c.animais, 0) <> pa.nascido
      UNION ALL
      SELECT format('parto %s, %s: %s vivos ou entregues para %s que restaram', pa.id_parto, pa.sexo, COALESCE(c.restaram, 0), pa.oferta)
        FROM parto_antigo pa
        LEFT JOIN contado c ON c.id_parto = pa.id_parto AND c.sexo = pa.sexo
       WHERE COALESCE(c.restaram, 0) <> pa.oferta
      UNION ALL
      SELECT format('parto %s, %s: %s entregues para %s nos compromissos', pa.id_parto, pa.sexo, COALESCE(c.entregues, 0), pa.entregue)
        FROM parto_antigo pa
        LEFT JOIN contado c ON c.id_parto = pa.id_parto AND c.sexo = pa.sexo
       WHERE COALESCE(c.entregues, 0) <> pa.entregue

      -- os mortos, contados pelas baixas da trilha
      UNION ALL
      SELECT format('parto %s, %s: %s baixas de selecao para %s eutanasiados', pa.id_parto, pa.sexo, COALESCE(b.animais, 0), pa.eutanasiado)
        FROM parto_antigo pa
        LEFT JOIN baixado b ON b.id_parto = pa.id_parto AND b.sexo = pa.sexo AND b.motivo = 'eutanasia de selecao'
       WHERE COALESCE(b.animais, 0) <> pa.eutanasiado
      UNION ALL
      SELECT format('parto %s, %s: %s baixas no desmame para %s que nao chegaram a ele', pa.id_parto, pa.sexo, COALESCE(b.animais, 0), pa.perda)
        FROM parto_antigo pa
        LEFT JOIN baixado b ON b.id_parto = pa.id_parto AND b.sexo = pa.sexo AND b.motivo = 'nao chegou ao desmame'
       WHERE COALESCE(b.animais, 0) <> pa.perda

      -- por lugar: os vivos de cada parto em cada caixa sao o que o modelo antigo dizia (na
      -- caixa do casal, oferta - entregue - lotes; em cada lote, a qtd dele)
      UNION ALL
      SELECT format('parto %s, %s, caixa %s: %s vivos para %s no modelo antigo',
                    COALESCE(e.id_parto, c.id_parto), COALESCE(e.sexo, c.sexo), COALESCE(e.id_caixa, c.id_caixa),
                    COALESCE(c.vivos, 0), COALESCE(e.vivos, 0))
        FROM vivos_esperados e
        FULL JOIN vivos_contados c ON c.id_parto = e.id_parto AND c.sexo = e.sexo AND c.id_caixa = e.id_caixa
       WHERE COALESCE(e.vivos, 0) <> COALESCE(c.vivos, 0)

      -- por pedido: os entregues batem com os compromissos entregues, e os reservados nunca
      -- passam da reserva pendente (a menos e falta, que sai como aviso)
      UNION ALL
      SELECT format('pedido %s, %s: %s entregues para %s nos compromissos',
                    COALESCE(e.id_pedido, c.id_pedido), COALESCE(e.sexo, c.sexo), COALESCE(c.entregues, 0), COALESCE(e.entregues, 0))
        FROM pedido_esperado e
        FULL JOIN pedido_contado c ON c.id_pedido = e.id_pedido AND c.sexo = e.sexo
       WHERE COALESCE(e.entregues, 0) <> COALESCE(c.entregues, 0)
      UNION ALL
      SELECT format('pedido %s, %s: %s reservados para %s pendentes',
                    COALESCE(e.id_pedido, c.id_pedido), COALESCE(e.sexo, c.sexo), COALESCE(c.reservados, 0), COALESCE(e.pendentes, 0))
        FROM pedido_esperado e
        FULL JOIN pedido_contado c ON c.id_pedido = e.id_pedido AND c.sexo = e.sexo
       WHERE COALESCE(c.reservados, 0) > COALESCE(e.pendentes, 0)

      -- todo pedido coerente com os seus animais, pela regra que o trigger do pedido passa a cobrar
      -- (a linhagem, o teto, o entregue exato, so o reservado segurando animal). So a falta do
      -- pedido reservado passa, como aviso
      UNION ALL
      SELECT format('pedido %s (%s): %s', pe.id, pe.status, pe.recusa)
        FROM pedido_conferido pe
       WHERE pe.recusa IS NOT NULL
         AND NOT pe.falta

      -- todo vivo num lugar que o trigger dos animais aceita
      UNION ALL
      SELECT format('animal %s: %s', a.id, colonia.lugar_recusado(a.id_parto, a.sexo, a.id_caixa))
        FROM "colonia"."animal" a
       WHERE a.situacao = 'vivo'
         AND colonia.lugar_recusado(a.id_parto, a.sexo, a.id_caixa) IS NOT NULL

      -- todo entregue saiu depois do desmame e depois de chegar na caixa
      UNION ALL
      SELECT format('animal %s: entregue em %s, com desmame em %s e chegada na caixa em %s',
                    a.id, a.dt_saida, p.dt_desmame_real, a.dt_movimento)
        FROM "colonia"."animal" a
        JOIN "reproducao"."parto" p ON p.id = a.id_parto
       WHERE a.situacao = 'entregue'
         AND (p.dt_desmame_real IS NULL OR a.dt_saida < p.dt_desmame_real OR a.dt_saida < a.dt_movimento)

      -- o codigo gravado e o da posicao, pela formula que o trigger da topologia passa a usar
      UNION ALL
      SELECT format('caixa %s: codigo %s, e a posicao da %s', c.id, c.codigo,
                    infra.codigo_da_posicao(c.face, c.linha, c.coluna, e.colunas))
        FROM "infra"."caixa" c
        JOIN "infra"."estante" e ON e.id = c.id_estante
       WHERE c.codigo IS DISTINCT FROM infra.codigo_da_posicao(c.face, c.linha, c.coluna, e.colunas)

      -- a trilha conta a historia de cada animal uma vez: um nascimento; uma baixa se morreu;
      -- uma reserva se tem pedido; uma entrega se foi entregue; uma mudanca se mudou de caixa
      UNION ALL
      SELECT format('animal %s: %s nascimentos na trilha', t.id, t.nascimentos)
        FROM trilha t WHERE t.nascimentos <> 1
      UNION ALL
      SELECT format('animal %s (%s): %s baixas na trilha', t.id, t.situacao, t.baixas)
        FROM trilha t WHERE t.baixas <> CASE WHEN t.situacao = 'morto' THEN 1 ELSE 0 END
      UNION ALL
      SELECT format('animal %s (%s): %s entregas na trilha', t.id, t.situacao, t.entregas)
        FROM trilha t WHERE t.entregas <> CASE WHEN t.situacao = 'entregue' THEN 1 ELSE 0 END
      UNION ALL
      SELECT format('animal %s: %s reservas na trilha', t.id, t.reservas)
        FROM trilha t WHERE t.reservas <> CASE WHEN t.id_pedido IS NOT NULL THEN 1 ELSE 0 END
      UNION ALL
      SELECT format('animal %s: %s mudancas na trilha', t.id, t.mudancas)
        FROM trilha t WHERE t.mudancas <> CASE WHEN t.dt_movimento IS NOT NULL THEN 1 ELSE 0 END
    ) AS falhas;

  IF v_falhas IS NOT NULL THEN
    RAISE EXCEPTION E'A conversao para colonia por animal nao fechou com o modelo antigo:\n%', v_falhas;
  END IF;

  SELECT string_agg(aviso, E'\n' ORDER BY aviso)
    INTO v_avisos
    FROM (
      -- pedido reservado sem cobertura exata: a falta que ja existia passa a ser do pedido
      SELECT format('pedido %s (falta): %s', pe.id, pe.recusa) AS aviso
        FROM pedido_conferido pe
       WHERE pe.falta

      -- a coluna do Kanban passa a ser calculada; o estado gravado podia ter sido arrastado a mao
      UNION ALL
      SELECT format('caixa %s (%s): estado gravado %s', c.id, c.codigo, c.estado)
        FROM "infra"."caixa" c
       WHERE (c.ativa AND c.tipo = 'casal' AND c.estado NOT IN ('R', 'P'))
          OR (c.ativa AND c.tipo = 'estoque' AND c.estado <> 'E')
          OR (NOT c.ativa AND (c.estado = 'X') <> (c.motivo_liberacao = 'entrega'))
    ) AS avisos;

  IF v_avisos IS NOT NULL THEN
    RAISE NOTICE E'Conversao para colonia por animal, avisos:\n%', v_avisos;
  END IF;
END;
$confere$;

-- ---------------------------------------------------------------------------
-- 5. Apaga o modelo por caixa
--
-- Primeiro o que a conversao criou so para si (as visoes dependem das colunas que saem), depois o
-- trigger da oferta, as tabelas e as colunas que viraram contagem de animais.
-- ---------------------------------------------------------------------------

DROP FUNCTION pg_temp.lancar_ocorrencia(text, date, integer, timestamptz, integer, integer, integer, integer, text, integer[]);
DROP FUNCTION pg_temp.criar_animais(integer, char, integer, integer, text, date, date, integer, text, integer, integer);
DROP TABLE saida_do_lote;
DROP TABLE animal_convertido;
DROP VIEW pedido_conferido;
DROP VIEW lote_antigo;
DROP VIEW parto_antigo;

DROP TRIGGER "compromisso_respeita_oferta" ON "demanda"."compromisso";
DROP FUNCTION "demanda"."compromisso_respeita_oferta"();

-- DropTable
DROP TABLE "demanda"."compromisso";

-- DropTable
DROP TABLE "demanda"."remessa";

-- DropTable
DROP TABLE "infra"."lote";

-- DropIndex
DROP INDEX "infra"."caixa_estado_id_especie_idx";

-- AlterTable
ALTER TABLE "infra"."caixa" DROP CONSTRAINT "caixa_estado_dominio",
DROP COLUMN "estado";

-- DropForeignKey
ALTER TABLE "reproducao"."parto" DROP CONSTRAINT "parto_id_usuario_selecao_fkey";

-- AlterTable
ALTER TABLE "reproducao"."parto" DROP COLUMN "desmamado_f",
DROP COLUMN "desmamado_m",
DROP COLUMN "dt_desmame_previsto",
DROP COLUMN "dt_parto_previsto",
DROP COLUMN "dt_registro_selecao",
DROP COLUMN "dt_selecao",
DROP COLUMN "eutanasiado_f",
DROP COLUMN "eutanasiado_m",
DROP COLUMN "id_usuario_selecao",
DROP COLUMN "nascido_f",
DROP COLUMN "nascido_m";

-- AlterTable
ALTER TABLE "demanda"."pedido" DROP CONSTRAINT "solicitacao_regime_dominio",
DROP COLUMN "regime";

-- ---------------------------------------------------------------------------
-- 6. CHECKs
--
-- Escritos a mao: o Prisma nao gera CHECK. O que e barato conferir na propria linha fica aqui; o
-- que le outra tabela fica nos tres triggers ou no codigo.
-- ---------------------------------------------------------------------------

-- A caixa de estoque tem sexo e linhagem; a de casal, nenhum dos dois. O dominio do tipo fica so
-- no seu CHECK. Liberada se e somente se tem a data e o motivo da liberacao.
ALTER TABLE "infra"."caixa"
  ADD CONSTRAINT "caixa_tipo_dominio" CHECK ("tipo" IN ('casal', 'estoque')),
  ADD CONSTRAINT "caixa_estoque_completo" CHECK (
    CASE WHEN "tipo" = 'estoque'
      THEN "sexo" IN ('M', 'F') AND "id_linhagem" IS NOT NULL
      ELSE "sexo" IS NULL AND "id_linhagem" IS NULL
    END
  ),
  ADD CONSTRAINT "caixa_motivo_liberacao_dominio" CHECK ("motivo_liberacao" IN ('entrega', 'baixa', 'mudanca', 'casal_encerrado')),
  ADD CONSTRAINT "caixa_liberacao_coerente" CHECK (
    "ativa" = ("dt_liberacao" IS NULL) AND ("dt_liberacao" IS NULL) = ("motivo_liberacao" IS NULL)
  );

ALTER TABLE "reproducao"."casal"
  ADD CONSTRAINT "casal_ativo_coerente" CHECK ("ativo" = ("dt_encerramento" IS NULL)),
  ADD CONSTRAINT "casal_encerra_depois_de_formar" CHECK ("dt_encerramento" IS NULL OR "dt_encerramento" >= "dt_formacao");

-- O mesmo dia vale. O desmame so depois do nascimento; "sem ninhada" so sem nascimento.
ALTER TABLE "reproducao"."parto"
  ADD CONSTRAINT "parto_datas_em_ordem" CHECK (
    ("dt_parto_real" IS NULL OR "dt_parto_real" >= "dt_acasalamento")
    AND ("dt_desmame_real" IS NULL OR ("dt_parto_real" IS NOT NULL AND "dt_desmame_real" >= "dt_parto_real"))
    AND ("dt_sem_ninhada" IS NULL OR ("dt_parto_real" IS NULL AND "dt_sem_ninhada" >= "dt_acasalamento"))
  ),
  ADD CONSTRAINT "parto_sem_ninhada_tem_motivo" CHECK (("dt_sem_ninhada" IS NULL) = ("motivo_sem_ninhada" IS NULL));

-- Morto e entregue tem data de saida; ninguem sai antes de chegar na caixa; entregue tem pedido.
ALTER TABLE "colonia"."animal"
  ADD CONSTRAINT "animal_sexo_dominio" CHECK ("sexo" IN ('M', 'F')),
  ADD CONSTRAINT "animal_situacao_dominio" CHECK ("situacao" IN ('vivo', 'morto', 'entregue', 'anulado')),
  ADD CONSTRAINT "animal_saida_coerente" CHECK (("situacao" IN ('morto', 'entregue')) = ("dt_saida" IS NOT NULL)),
  ADD CONSTRAINT "animal_sai_depois_de_chegar" CHECK ("dt_saida" IS NULL OR "dt_movimento" IS NULL OR "dt_saida" >= "dt_movimento"),
  ADD CONSTRAINT "animal_entregue_tem_pedido" CHECK ("situacao" <> 'entregue' OR "id_pedido" IS NOT NULL);

ALTER TABLE "colonia"."ocorrencia"
  ADD CONSTRAINT "ocorrencia_tipo_dominio" CHECK (
    "tipo" IN ('nascimento', 'baixa', 'mudanca', 'reserva', 'reserva_desfeita', 'entrega', 'correcao', 'anulacao')
  ),
  ADD CONSTRAINT "ocorrencia_mudanca_tem_dois_lugares" CHECK (
    "tipo" <> 'mudanca'
    OR ("id_caixa_origem" IS NOT NULL AND "id_caixa_destino" IS NOT NULL AND "id_caixa_origem" <> "id_caixa_destino")
  ),
  ADD CONSTRAINT "ocorrencia_demanda_tem_pedido" CHECK ("tipo" NOT IN ('reserva', 'reserva_desfeita', 'entrega') OR "id_pedido" IS NOT NULL),
  ADD CONSTRAINT "ocorrencia_anulacao_aponta" CHECK (("tipo" = 'anulacao') = ("id_anulada" IS NOT NULL)),
  ADD CONSTRAINT "ocorrencia_correcao_tem_motivo" CHECK ("tipo" NOT IN ('correcao', 'anulacao') OR "motivo" IS NOT NULL);

-- Entregue se e somente se tem a data da entrega
ALTER TABLE "demanda"."pedido"
  ADD CONSTRAINT "pedido_status_dominio" CHECK ("status" IN ('enviado', 'aprovado', 'reservado', 'entregue', 'recusado')),
  ADD CONSTRAINT "pedido_entregue_tem_data" CHECK (("status" = 'entregue') = ("dt_entrega" IS NOT NULL)),
  ADD CONSTRAINT "pedido_qtd_nao_negativa" CHECK ("qtd_m" >= 0 AND "qtd_f" >= 0);

-- ---------------------------------------------------------------------------
-- 7. Triggers
--
-- Os tres que leem outra tabela. Todos levantam check_violation com 'PREFIXO: texto', que
-- src/shared/erros-do-banco.ts traduz para 409 com o texto sem o prefixo.
-- ---------------------------------------------------------------------------

-- 7.1 A posicao cabe na estante, e o codigo da caixa e sempre o da posicao: o trigger escreve o
-- codigo em todo INSERT e em toda mudanca de posicao (ou de codigo, que volta ao da posicao).
CREATE OR REPLACE FUNCTION "infra"."caixa_dentro_da_topologia"()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_estante record;
BEGIN
  SELECT "faces", "linhas", "colunas"
    INTO v_estante
    FROM "infra"."estante"
   WHERE "id" = NEW."id_estante";

  IF NOT FOUND THEN
    -- Estante inexistente e problema da FK, nao deste trigger.
    RETURN NEW;
  END IF;

  IF NEW."face"   > v_estante."faces"
  OR NEW."linha"  > v_estante."linhas"
  OR NEW."coluna" > v_estante."colunas" THEN
    RAISE EXCEPTION
      'TOPOLOGIA: a posicao face % linha % coluna % nao existe na estante % (% faces, % linhas, % colunas)',
      NEW."face", NEW."linha", NEW."coluna", NEW."id_estante",
      v_estante."faces", v_estante."linhas", v_estante."colunas"
      USING ERRCODE = 'check_violation';
  END IF;

  NEW."codigo" := "infra"."codigo_da_posicao"(NEW."face", NEW."linha", NEW."coluna", v_estante."colunas");

  IF NEW."codigo" IS NULL THEN
    RAISE EXCEPTION
      'TOPOLOGIA: a estante % tem colunas demais para as 26 letras do endereco',
      NEW."id_estante"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER "caixa_dentro_da_topologia" ON "infra"."caixa";

CREATE TRIGGER "caixa_dentro_da_topologia"
  BEFORE INSERT OR UPDATE OF "id_estante", "face", "linha", "coluna", "codigo"
  ON "infra"."caixa"
  FOR EACH ROW
  EXECUTE FUNCTION "infra"."caixa_dentro_da_topologia"();

-- 7.2 O animal coerente.
--   - A vida do animal: entra vivo, de parto que ja nasceu, e o parto de origem nunca muda.
--     Entregue e anulado sao finais. Morto so volta a vivo (a anulacao da baixa). So quem fica
--     vivo muda de caixa ou de sexo, e o sexo de animal reservado nao muda. O animal nao se apaga:
--     a vida dele termina em morto, entregue ou anulado, com o porque na trilha.
--   - O lugar do vivo: a regra de colonia.lugar_recusado.
--   - A reserva: so de vivo, para pedido aprovado ou reservado da linhagem do parto; nao troca de
--     pedido sem desfazer antes; desfazer so deixa o animal vivo e livre (o morto guarda o pedido
--     como registro). Toda reserva que entra ou sai trava o pedido (FOR UPDATE), o que poe em fila
--     quem reserva, desfaz ou muda o status ou as quantidades dele (7.3). Quando o animal passa a
--     contar no pedido, os vivos mais os entregues do pedido nao passam de M <= qtd_m + qualquer,
--     F <= qtd_f + qualquer e M + F <= total. As linhas que o mesmo comando ja atualizou sao vistas
--     pela contagem.
--   - A entrega: so do reservado, com o pedido dele em reservado, travado como na reserva. O pedido
--     so passa a entregue depois que os animais saem (7.3), entao nao ha entrega que pule a reserva
--     inteira do pedido.
CREATE FUNCTION "colonia"."animal_coerente"()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_dt_parto_real date;
  v_id_linhagem   integer;
  v_motivo        text;
  v_pedido        record;
  v_status_pedido text;
  v_m             integer;
  v_f             integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ANIMAL_SITUACAO: o animal % nao se apaga: a baixa, a entrega ou a anulacao encerram a vida dele', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT p.dt_parto_real, cs.id_linhagem
    INTO v_dt_parto_real, v_id_linhagem
    FROM "reproducao"."parto" p
    JOIN "reproducao"."casal" cs ON cs.id = p.id_casal
   WHERE p.id = NEW.id_parto;

  IF NOT FOUND THEN
    -- parto inexistente e problema da FK
    RETURN NEW;
  END IF;

  -- A vida do animal
  IF TG_OP = 'INSERT' THEN
    IF NEW.situacao <> 'vivo' THEN
      RAISE EXCEPTION 'ANIMAL_SITUACAO: todo animal entra vivo, no nascimento'
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_dt_parto_real IS NULL THEN
      RAISE EXCEPTION 'ANIMAL_ORIGEM: o parto % ainda nao nasceu', NEW.id_parto
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.id_parto <> OLD.id_parto THEN
      RAISE EXCEPTION 'ANIMAL_ORIGEM: o parto de origem do animal % nao muda', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.situacao IN ('entregue', 'anulado')
       AND (NEW.id_caixa, NEW.sexo, NEW.situacao, NEW.dt_movimento, NEW.dt_saida, NEW.id_pedido)
           IS DISTINCT FROM (OLD.id_caixa, OLD.sexo, OLD.situacao, OLD.dt_movimento, OLD.dt_saida, OLD.id_pedido) THEN
      RAISE EXCEPTION 'ANIMAL_SITUACAO: o animal % ja esta %, e isso nao muda mais', NEW.id, OLD.situacao
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.situacao = 'morto' AND NEW.situacao NOT IN ('morto', 'vivo') THEN
      RAISE EXCEPTION 'ANIMAL_SITUACAO: o animal % esta morto e so volta a vivo, pela anulacao da baixa', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.situacao <> 'vivo' AND (NEW.id_caixa <> OLD.id_caixa OR NEW.sexo <> OLD.sexo) THEN
      RAISE EXCEPTION 'ANIMAL_SITUACAO: so animal vivo muda de caixa ou de sexo'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.sexo <> OLD.sexo AND (OLD.id_pedido IS NOT NULL OR NEW.id_pedido IS NOT NULL) THEN
      RAISE EXCEPTION 'PEDIDO_RESERVA: o animal % esta reservado e o sexo dele nao muda: desfaca a reserva antes', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- O lugar do vivo, conferido quando ele entra, volta a viver, muda de caixa ou de sexo
  IF NEW.situacao = 'vivo'
     AND (TG_OP = 'INSERT' OR OLD.situacao <> 'vivo' OR NEW.id_caixa <> OLD.id_caixa OR NEW.sexo <> OLD.sexo) THEN
    v_motivo := "colonia"."lugar_recusado"(NEW.id_parto, NEW.sexo, NEW.id_caixa);

    IF v_motivo IS NOT NULL THEN
      RAISE EXCEPTION 'ANIMAL_CAIXA: %', v_motivo
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- A reserva que entra, sai ou troca (no INSERT, OLD e nulo): so com o animal vivo depois do
  -- comando, e sem trocar de pedido
  IF NEW.id_pedido IS DISTINCT FROM OLD.id_pedido THEN
    IF NEW.id_pedido IS NOT NULL AND OLD.id_pedido IS NOT NULL THEN
      RAISE EXCEPTION 'PEDIDO_RESERVA: o animal % ja esta reservado para o pedido %: desfaca essa reserva antes',
        NEW.id, OLD.id_pedido
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.situacao <> 'vivo' AND NEW.id_pedido IS NOT NULL THEN
      RAISE EXCEPTION 'PEDIDO_RESERVA: o animal % esta %, e so animal vivo e reservado', NEW.id, NEW.situacao
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.situacao <> 'vivo' THEN
      RAISE EXCEPTION 'PEDIDO_RESERVA: so se desfaz a reserva de animal vivo; o % guarda o pedido como registro', NEW.situacao
        USING ERRCODE = 'check_violation';
    END IF;

    -- A reserva que sai trava o pedido como a que entra (abaixo): quem desfaz espera quem conta
    -- os reservados do pedido para mudar o status dele, e vice-versa
    IF OLD.id_pedido IS NOT NULL THEN
      PERFORM 1 FROM "demanda"."pedido" pe WHERE pe.id = OLD.id_pedido FOR UPDATE;
    END IF;
  END IF;

  -- A entrega (so no UPDATE: o INSERT ja entrou vivo). Sem pedido, quem recusa e o CHECK
  -- animal_entregue_tem_pedido
  IF NEW.situacao = 'entregue' AND OLD.situacao IS DISTINCT FROM 'entregue' THEN
    SELECT pe.status
      INTO v_status_pedido
      FROM "demanda"."pedido" pe
     WHERE pe.id = NEW.id_pedido
       FOR UPDATE;

    IF FOUND AND v_status_pedido <> 'reservado' THEN
      RAISE EXCEPTION 'PEDIDO_RESERVA: o pedido % esta %, e so pedido reservado recebe a entrega dos animais',
        NEW.id_pedido, v_status_pedido
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- O animal que passa a contar no pedido: reserva nova, ou reservado que volta a viver
  IF NEW.situacao = 'vivo'
     AND NEW.id_pedido IS NOT NULL
     AND (NEW.id_pedido IS DISTINCT FROM OLD.id_pedido OR OLD.situacao IS DISTINCT FROM 'vivo') THEN
    SELECT pe.status, pe.id_linhagem, pe.qtd_m, pe.qtd_f, pe.qtd_qualquer
      INTO v_pedido
      FROM "demanda"."pedido" pe
     WHERE pe.id = NEW.id_pedido
       FOR UPDATE;

    IF FOUND THEN
      IF v_pedido.status NOT IN ('aprovado', 'reservado') THEN
        RAISE EXCEPTION 'PEDIDO_RESERVA: o pedido % esta %, e so pedido aprovado ou reservado recebe animais',
          NEW.id_pedido, v_pedido.status
          USING ERRCODE = 'check_violation';
      END IF;

      IF v_pedido.id_linhagem <> v_id_linhagem THEN
        RAISE EXCEPTION 'PEDIDO_RESERVA: o animal % e de outra linhagem que o pedido %', NEW.id, NEW.id_pedido
          USING ERRCODE = 'check_violation';
      END IF;

      SELECT count(*) FILTER (WHERE a.sexo = 'M'), count(*) FILTER (WHERE a.sexo = 'F')
        INTO v_m, v_f
        FROM "colonia"."animal" a
       WHERE a.id_pedido = NEW.id_pedido
         AND a.situacao IN ('vivo', 'entregue')
         AND a.id <> NEW.id;

      IF NEW.sexo = 'M' THEN
        v_m := v_m + 1;
      ELSE
        v_f := v_f + 1;
      END IF;

      IF v_m > v_pedido.qtd_m + v_pedido.qtd_qualquer
         OR v_f > v_pedido.qtd_f + v_pedido.qtd_qualquer
         OR v_m + v_f > v_pedido.qtd_m + v_pedido.qtd_f + v_pedido.qtd_qualquer THEN
        RAISE EXCEPTION 'PEDIDO_EXCEDIDO: o pedido % pede % machos, % femeas e % de qualquer sexo, e ficaria com % machos e % femeas',
          NEW.id_pedido, v_pedido.qtd_m, v_pedido.qtd_f, v_pedido.qtd_qualquer, v_m, v_f
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER "animal_coerente"
  BEFORE INSERT OR UPDATE OR DELETE
  ON "colonia"."animal"
  FOR EACH ROW
  EXECUTE FUNCTION "colonia"."animal_coerente"();

-- 7.3 O pedido coerente com os seus animais: a regra de demanda.pedido_recusado, conferida quando o
-- pedido nasce e quando o status, a linhagem ou as quantidades mudam. O pedido novo nao tem animal,
-- entao so nasce num status que nao segura nenhum. O UPDATE trava a linha do pedido e toda reserva
-- ou entrega trava o pedido (7.2), entao contar aqui nao corre com quem reserva, desfaz ou entrega.
CREATE FUNCTION "demanda"."pedido_coerente"()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_recusa text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.status, NEW.id_linhagem, NEW.qtd_m, NEW.qtd_f, NEW.qtd_qualquer)
         IS NOT DISTINCT FROM (OLD.status, OLD.id_linhagem, OLD.qtd_m, OLD.qtd_f, OLD.qtd_qualquer) THEN
    RETURN NEW;
  END IF;

  v_recusa := "demanda"."pedido_recusado"(NEW.id, NEW.status, NEW.id_linhagem, NEW.qtd_m, NEW.qtd_f, NEW.qtd_qualquer);

  IF v_recusa IS NOT NULL THEN
    RAISE EXCEPTION '%', v_recusa
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER "pedido_coerente"
  BEFORE INSERT OR UPDATE OF "status", "id_linhagem", "qtd_m", "qtd_f", "qtd_qualquer"
  ON "demanda"."pedido"
  FOR EACH ROW
  EXECUTE FUNCTION "demanda"."pedido_coerente"();
