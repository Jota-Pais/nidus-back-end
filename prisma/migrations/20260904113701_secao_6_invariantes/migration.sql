-- Secao 6 do modelo de dados: as restricoes que o diagrama nao expressa e que o
-- Prisma nao gera - unique parcial, CHECK, FK composta e trigger.
--
-- A migration anterior criou as 14 tabelas. Esta poe no banco as invariantes que
-- as regras exigem, para que nao dependam de a aplicacao lembrar.
--
-- As duas FKs compostas saem do `prisma migrate diff`, verbatim, para o
-- schema.prisma continuar sendo a fonte da verdade. O resto o Prisma nao modela,
-- e ignora, sem acusar drift.

-- ---------------------------------------------------------------------------
-- 1. Schemas vazios do modelo alvo (secao 7 do modelo de dados)
--
-- Criados agora, vazios, para que toda tabela futura entre com CREATE TABLE
-- puro, sem tocar em nada existente.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS "motor";
CREATE SCHEMA IF NOT EXISTS "expedicao";
CREATE SCHEMA IF NOT EXISTS "insumo";
CREATE SCHEMA IF NOT EXISTS "auditoria";

-- ---------------------------------------------------------------------------
-- 2. RN-02 - cruzamento rotacional, e coerencia linhagem x especie
--
-- Saida literal de `prisma migrate diff --from-config-datasource --to-schema`.
-- Nao editar a mao: se divergir do schema.prisma, o proximo migrate acusa drift.
-- ---------------------------------------------------------------------------

-- DropForeignKey
ALTER TABLE "demanda"."solicitacao" DROP CONSTRAINT "solicitacao_id_linhagem_fkey";

-- AddForeignKey
ALTER TABLE "reproducao"."casal" ADD CONSTRAINT "casal_grupo_macho_grupo_femea_fkey" FOREIGN KEY ("grupo_macho", "grupo_femea") REFERENCES "catalogo"."grupo_genetico_par"("grupo_macho", "grupo_femea") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "demanda"."solicitacao" ADD CONSTRAINT "solicitacao_id_especie_id_linhagem_fkey" FOREIGN KEY ("id_especie", "id_linhagem") REFERENCES "catalogo"."linhagem"("id_especie", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 3. Dominio dos char(1)/char(2)
--
-- Transcricao das legendas do modelo de dados. Sem isso o char(1) aceita
-- qualquer letra e o estado da caixa vira campo livre.
--
-- Fica de fora `demanda.remessa.status`: e o unico char(1) do modelo sem legenda
-- em documento nenhum. Ganhou DEFAULT 'P' na migration anterior sem que ninguem
-- registrasse o que 'P' significa. Definir o dominio e acrescentar o CHECK.
-- ---------------------------------------------------------------------------

ALTER TABLE "infra"."caixa"
  ADD CONSTRAINT "caixa_finalidade_dominio" CHECK ("finalidade" IN ('R','M','C','E')),
  ADD CONSTRAINT "caixa_estado_dominio"     CHECK ("estado" IN ('R','P','T','E','X'));

ALTER TABLE "reproducao"."casal"
  ADD CONSTRAINT "casal_grupo_macho_dominio" CHECK ("grupo_macho" IN ('A','B','C','D','E')),
  ADD CONSTRAINT "casal_grupo_femea_dominio" CHECK ("grupo_femea" IN ('A','B','C','D','E')),
  ADD CONSTRAINT "casal_identificacao_derivada" CHECK ("identificacao" = "grupo_macho" || "grupo_femea");

ALTER TABLE "reproducao"."parto"
  ADD CONSTRAINT "parto_grau_certeza_dominio" CHECK ("grau_certeza" IN ('C','P','J'));

ALTER TABLE "login"."usuario"
  ADD CONSTRAINT "usuario_perfil_dominio" CHECK ("perfil" IN ('P','T','G'));

ALTER TABLE "etica"."projeto"
  ADD CONSTRAINT "projeto_situacao_dominio" CHECK ("situacao" IN ('V','N','S'));

ALTER TABLE "demanda"."solicitacao"
  ADD CONSTRAINT "solicitacao_regime_dominio" CHECK ("regime" IN ('U','S','Q','M','A')),
  ADD CONSTRAINT "solicitacao_status_dominio" CHECK ("status" IN ('RA','EN','AN','AP','RE','AJ','AT','CO','CA'));

ALTER TABLE "demanda"."compromisso"
  ADD CONSTRAINT "compromisso_grau_certeza_dominio" CHECK ("grau_certeza" IN ('C','P','J'));

-- ---------------------------------------------------------------------------
-- 4. RN-04 - vida util do casal, e derivacoes de mesma linha
-- ---------------------------------------------------------------------------

ALTER TABLE "reproducao"."parto"
  ADD CONSTRAINT "parto_ordem_ciclo" CHECK ("ordem" BETWEEN 1 AND 5);

ALTER TABLE "infra"."estante"
  ADD CONSTRAINT "estante_capacidade_derivada" CHECK ("capacidade" = "faces" * "linhas" * "colunas"),
  ADD CONSTRAINT "estante_topologia_positiva"  CHECK ("faces" >= 1 AND "linhas" >= 1 AND "colunas" >= 1);

ALTER TABLE "infra"."caixa"
  ADD CONSTRAINT "caixa_posicao_positiva" CHECK ("face" >= 1 AND "linha" >= 1 AND "coluna" >= 1);

-- ---------------------------------------------------------------------------
-- 5. Unicidade parcial
--
-- O Prisma nao tem `WHERE` em @@unique, entao entram como indice.
-- ---------------------------------------------------------------------------

-- Uma caixa ativa por posicao fisica. Caixa desativada nao ocupa endereco, o que
-- deixa o historico no lugar (RNF-06) sem travar a posicao para sempre.
CREATE UNIQUE INDEX "caixa_uma_por_posicao"
  ON "infra"."caixa" ("id_estante", "face", "linha", "coluna")
  WHERE "ativa";

-- RN-03: maximo um casal ATIVO por caixa. Casais encerrados ficam no historico.
CREATE UNIQUE INDEX "casal_um_ativo_por_caixa"
  ON "reproducao"."casal" ("id_caixa")
  WHERE "ativo";

-- ---------------------------------------------------------------------------
-- 6. RF-INF-01 - a posicao cabe na topologia da estante
--
-- Nao da para ser CHECK: le outra tabela. O modelo de dados descreve como
-- "CHECK contra estante.linhas/colunas/faces", que o Postgres nao permite -
-- entao vira trigger.
-- ---------------------------------------------------------------------------

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
      'RF-INF-01: posicao face % linha % coluna % nao existe na estante % (% faces, % linhas, % colunas)',
      NEW."face", NEW."linha", NEW."coluna", NEW."id_estante",
      v_estante."faces", v_estante."linhas", v_estante."colunas"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER "caixa_dentro_da_topologia"
  BEFORE INSERT OR UPDATE OF "id_estante", "face", "linha", "coluna"
  ON "infra"."caixa"
  FOR EACH ROW
  EXECUTE FUNCTION "infra"."caixa_dentro_da_topologia"();

-- ---------------------------------------------------------------------------
-- 7. RN-09 - UM ANIMAL, UM COMPROMISSO
--
-- A invariante que o sistema existe para garantir: a soma dos compromissos
-- ativos de um parto nunca passa da oferta daquele parto.
--
-- Nao cabe em CHECK porque e agregacao entre linhas. AFTER INSERT/UPDATE mais
-- SELECT ... FOR UPDATE na linha do parto, como manda a secao 5.2 - atende
-- RF-MOT-08 (operacao atomica) e RNF-02 (resistente a corrida).
--
-- Duas leituras do documento precisaram de decisao, ambas registradas aqui:
--
--   1. A secao 5.1 define `disponivel_m` DESCONTANDO os compromissos, e a 5.2
--      compara `SUM(compromissos) <= disponivel_m`. Ao pe da letra isso daria
--      `SUM <= oferta - SUM`, ou seja metade da oferta. O teto correto e a
--      oferta BRUTA, e os dois conceitos estao nomeados separadamente abaixo:
--      `oferta` (bruta) e o saldo, que e `oferta - reservado`.
--
--   2. A secao 5.1 escreve `nascido_m - eutanasiado_m`. Se o parto foi registrado
--      e a selecao ainda nao, `eutanasiado_m` e nulo e a subtracao inteira vira
--      nula - a oferta cairia para a expectativa PROJETADA de uma ninhada que ja
--      nasceu. Aqui selecao ausente conta como zero.
--
-- O trigger fica so em `compromisso`, nao em `parto`, de proposito: o RF-REP-09
-- diz que correcao de registro ALERTA sobre compromisso que ficou inconsistente
-- e recalcula em cascata. Bloquear a correcao contrariaria o requisito.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "demanda"."compromisso_respeita_oferta"()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_oferta_m    integer;
  v_oferta_f    integer;
  v_reservado_m integer;
  v_reservado_f integer;
BEGIN
  -- Serializa quem mira a mesma ninhada. A segunda transacao espera aqui e so
  -- recalcula depois do commit da primeira, ja vendo a reserva dela.
  PERFORM 1 FROM "reproducao"."parto" WHERE "id" = NEW."id_parto" FOR UPDATE;

  -- COALESCE em tres niveis: e o RN-08 em codigo.
  --   desmamou -> confirmado | nasceu -> previsto | nem nasceu -> projetado
  SELECT COALESCE(p."desmamado_m", p."nascido_m" - COALESCE(p."eutanasiado_m", 0), pb."expectativa_m"),
         COALESCE(p."desmamado_f", p."nascido_f" - COALESCE(p."eutanasiado_f", 0), pb."expectativa_f")
    INTO v_oferta_m, v_oferta_f
    FROM "reproducao"."parto" p
    JOIN "reproducao"."casal" cs ON cs."id" = p."id_casal"
    JOIN "catalogo"."linhagem" l ON l."id"  = cs."id_linhagem"
    LEFT JOIN LATERAL (
      -- Parametro vigente na data do acasalamento, nao o de hoje: o RN-01 exige
      -- que calculo feito no passado continue reproduzivel. Linhagem especifica
      -- ganha da regra da especie inteira.
      SELECT x."expectativa_m", x."expectativa_f"
        FROM "catalogo"."parametro_biologico" x
       WHERE x."id_especie" = l."id_especie"
         AND (x."id_linhagem" = l."id" OR x."id_linhagem" IS NULL)
         AND x."dt_vigencia_inicio" <= p."dt_acasalamento"
         AND (x."dt_vigencia_fim" IS NULL OR x."dt_vigencia_fim" >= p."dt_acasalamento")
       ORDER BY (x."id_linhagem" IS NULL), x."dt_vigencia_inicio" DESC
       LIMIT 1
    ) pb ON true
   WHERE p."id" = NEW."id_parto";

  IF v_oferta_m IS NULL OR v_oferta_f IS NULL THEN
    RAISE EXCEPTION
      'RN-09: parto % nao tem oferta calculavel - registre o parto ou cadastre o parametro_biologico vigente da linhagem',
      NEW."id_parto"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(SUM(c."qtd_m"), 0), COALESCE(SUM(c."qtd_f"), 0)
    INTO v_reservado_m, v_reservado_f
    FROM "demanda"."compromisso" c
   WHERE c."id_parto" = NEW."id_parto"
     AND c."dt_cancelamento" IS NULL;

  IF v_reservado_m > v_oferta_m THEN
    RAISE EXCEPTION
      'RN-09: o parto % oferta % machos e ja teria % comprometidos',
      NEW."id_parto", v_oferta_m, v_reservado_m
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_reservado_f > v_oferta_f THEN
    RAISE EXCEPTION
      'RN-09: o parto % oferta % femeas e ja teria % comprometidas',
      NEW."id_parto", v_oferta_f, v_reservado_f
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$fn$;

CREATE TRIGGER "compromisso_respeita_oferta"
  AFTER INSERT OR UPDATE
  ON "demanda"."compromisso"
  FOR EACH ROW
  EXECUTE FUNCTION "demanda"."compromisso_respeita_oferta"();
