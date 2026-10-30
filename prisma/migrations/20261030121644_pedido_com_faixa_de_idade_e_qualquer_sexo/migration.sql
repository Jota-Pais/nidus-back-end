-- O pedido de animais novo (29/10/2026): o nome que o pesquisador digita, a idade
-- como faixa (idade_min_dias..idade_max_dias; a exata e min = max), animais de
-- qualquer sexo alem de machos e femeas, e observacoes. O qualquer fica no pedido e
-- na remessa, como machos e femeas.
--
-- O `prisma migrate diff` entre o schema.prisma de antes e o de agora sai assim:
--
--   ALTER TABLE "demanda"."solicitacao" DROP COLUMN "idade_alvo_dias",
--   ADD COLUMN "idade_max_dias" SMALLINT NOT NULL,
--   ADD COLUMN "idade_min_dias" SMALLINT NOT NULL,
--   ADD COLUMN "nome_pesquisador" VARCHAR(120) NOT NULL,
--   ADD COLUMN "observacoes" VARCHAR(500),
--   ADD COLUMN "qtd_qualquer" SMALLINT NOT NULL DEFAULT 0;
--
--   ALTER TABLE "demanda"."remessa" ADD COLUMN "qtd_qualquer_prevista" SMALLINT NOT NULL DEFAULT 0;
--
-- O ALTER da remessa funciona do jeito que sai, porque a coluna nova tem DEFAULT 0,
-- e entra aqui igual. O da solicitacao, do jeito que sai, apagaria a idade dos
-- pedidos que existem e falharia na primeira linha da tabela (NOT NULL sem
-- DEFAULT). Por isso esta escrito a mao e chega no mesmo banco que o diff
-- descreve: a idade alvo muda de nome, as colunas NOT NULL sem DEFAULT entram
-- nulas, sao preenchidas e so depois viram NOT NULL. Os CHECKs o Prisma nao
-- modela.
--
-- Mexe em demanda.solicitacao e demanda.remessa, e nenhuma das duas tem trigger.
-- Os dois UPDATEs daqui sao de demanda.solicitacao. O compromisso_respeita_oferta e
-- de demanda.compromisso (AFTER INSERT OR UPDATE) e le parto, casal, linhagem,
-- parametro_biologico e compromisso: nada disso muda. Compromisso que ja existe fica
-- como esta, e remessa que ja existe so ganha o qualquer previsto, com 0.

-- ---------------------------------------------------------------------------
-- 1. Idade: a idade alvo vira o minimo da faixa, e o maximo comeca igual
--
-- O pedido antigo pedia uma idade so, que e a idade exata.
-- ---------------------------------------------------------------------------

ALTER TABLE "demanda"."solicitacao" RENAME COLUMN "idade_alvo_dias" TO "idade_min_dias";

ALTER TABLE "demanda"."solicitacao" ADD COLUMN "idade_max_dias" SMALLINT;

UPDATE "demanda"."solicitacao" SET "idade_max_dias" = "idade_min_dias";

ALTER TABLE "demanda"."solicitacao" ALTER COLUMN "idade_max_dias" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Nome do pesquisador
--
-- No pedido novo a pessoa digita. Nos que existem, entra o nome da conta que
-- pediu, que tambem e VARCHAR(120) e NOT NULL.
-- ---------------------------------------------------------------------------

ALTER TABLE "demanda"."solicitacao" ADD COLUMN "nome_pesquisador" VARCHAR(120);

UPDATE "demanda"."solicitacao" s
   SET "nome_pesquisador" = u."nome"
  FROM "login"."usuario" u
 WHERE u."id" = s."id_usuario_solicitante";

ALTER TABLE "demanda"."solicitacao" ALTER COLUMN "nome_pesquisador" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Qualquer sexo e observacoes
--
-- O pedido antigo nao tinha nenhum dos dois: 0 e nulo. Na remessa, o qualquer
-- previsto fica ao lado de qtd_m_prevista e qtd_f_prevista; a remessa que existe e
-- de pedido antigo e tambem comeca com 0, sem UPDATE.
-- ---------------------------------------------------------------------------

ALTER TABLE "demanda"."solicitacao"
  ADD COLUMN "qtd_qualquer" SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN "observacoes" VARCHAR(500);

ALTER TABLE "demanda"."remessa"
  ADD COLUMN "qtd_qualquer_prevista" SMALLINT NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 4. CHECKs
--
-- qtd_qualquer >= 0 e qtd_qualquer_prevista >= 0 valem ja para toda linha: as
-- colunas acabaram de nascer com 0.
--
-- Os outros tres podem esbarrar em linha antiga. A API nunca teve teto de idade
-- (so o minimo de 21), e o banco nunca conferiu a soma, nem no pedido nem na
-- remessa. Migration que falha trava o deploy da Render, entao entram NOT VALID -
-- ja valem para linha nova e para toda linha que mudar - e so sao validados se
-- nenhuma linha antiga violar. Se alguma violar, o CHECK fica NOT VALID ate a
-- linha ser corrigida e alguem rodar o VALIDATE CONSTRAINT.
--
-- A soma e em integer: tres SMALLINT somados estouram o SMALLINT acima de 32767.
-- ---------------------------------------------------------------------------

ALTER TABLE "demanda"."solicitacao"
  ADD CONSTRAINT "solicitacao_qtd_qualquer_nao_negativa" CHECK ("qtd_qualquer" >= 0);

ALTER TABLE "demanda"."solicitacao"
  ADD CONSTRAINT "solicitacao_ao_menos_um_animal"
    CHECK ("qtd_m"::integer + "qtd_f" + "qtd_qualquer" > 0) NOT VALID,
  ADD CONSTRAINT "solicitacao_faixa_de_idade"
    CHECK ("idade_min_dias" BETWEEN 21 AND 300
       AND "idade_max_dias" BETWEEN "idade_min_dias" AND 300) NOT VALID;

ALTER TABLE "demanda"."remessa"
  ADD CONSTRAINT "remessa_qtd_qualquer_prevista_nao_negativa"
    CHECK ("qtd_qualquer_prevista" >= 0);

ALTER TABLE "demanda"."remessa"
  ADD CONSTRAINT "remessa_ao_menos_um_animal"
    CHECK ("qtd_m_prevista"::integer + "qtd_f_prevista" + "qtd_qualquer_prevista" > 0) NOT VALID;

DO $valida$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "demanda"."solicitacao"
     WHERE NOT ("qtd_m"::integer + "qtd_f" + "qtd_qualquer" > 0)
  ) THEN
    ALTER TABLE "demanda"."solicitacao" VALIDATE CONSTRAINT "solicitacao_ao_menos_um_animal";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "demanda"."remessa"
     WHERE NOT ("qtd_m_prevista"::integer + "qtd_f_prevista" + "qtd_qualquer_prevista" > 0)
  ) THEN
    ALTER TABLE "demanda"."remessa" VALIDATE CONSTRAINT "remessa_ao_menos_um_animal";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "demanda"."solicitacao"
     WHERE NOT ("idade_min_dias" BETWEEN 21 AND 300
            AND "idade_max_dias" BETWEEN "idade_min_dias" AND 300)
  ) THEN
    ALTER TABLE "demanda"."solicitacao" VALIDATE CONSTRAINT "solicitacao_faixa_de_idade";
  END IF;
END;
$valida$;
