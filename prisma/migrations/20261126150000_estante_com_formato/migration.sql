-- Estante com formato. Ate aqui cada estante guardava o fabricante, o modelo e as medidas (faces,
-- linhas e colunas) copiados no cadastro, e nada disso mudava depois: para trocar, removia a estante
-- e cadastrava de novo. As medidas passam a ser um cadastro proprio, o formato, e a estante aponta
-- para ele pela chave. O tecnico e o gestor cadastram, editam e removem formatos e trocam o formato
-- da estante; mudar as medidas de um formato muda todas as estantes dele.
--
-- O banco continua garantindo que a caixa cabe na estante, agora pelas medidas do formato. Trocar o
-- formato da estante ou mudar as medidas do formato reescreve o codigo das caixas ativas (a letra da
-- traseira continua as da frontal, entao muda com o numero de colunas) e recusa, com TOPOLOGIA, a
-- caixa ativa que ficaria fora. O servico confere antes e diz quais caixas sao; o banco garante a
-- regra mesmo sem ele.
--
-- Nao apaga nada: entram os 4 formatos da spec, com os nomes do cliente; cada combinacao de
-- fabricante, modelo e medidas das estantes, ativas ou nao, que nao bate com um deles vira um formato
-- tambem; e cada estante passa a apontar para o seu. So depois disso saem as colunas copiadas.
--
-- Em producao, em 26/11/2026: 3 salas, 6 estantes ativas, todas num dos 4 formatos da spec, e 35
-- caixas ativas. Num banco vazio entram so os 4 formatos.
--
-- Sem BEGIN/COMMIT, como a 20261108200000_colonia_por_animal: o Prisma manda o arquivo inteiro de uma
-- vez e o Postgres o roda numa transacao implicita, entao qualquer erro daqui desfaz tudo e o banco
-- fica como estava.
--
-- Ordem: 1. o formato | 2. os 4 da spec | 3. os formatos das estantes | 4. a estante aponta para o
-- formato | 5. o trigger da caixa le o formato | 6 e 7. os triggers que reescrevem as caixas |
-- 8. saem as colunas copiadas | 9. conferencia

-- ---------------------------------------------------------------------------
-- 1. O formato
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "infra"."formato" (
    "id" SERIAL NOT NULL,
    "nome" VARCHAR(60) NOT NULL,
    "faces" SMALLINT NOT NULL,
    "linhas" SMALLINT NOT NULL,
    "colunas" SMALLINT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "dt_criacao" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dt_manutencao" TIMESTAMPTZ(6),

    CONSTRAINT "formato_pkey" PRIMARY KEY ("id")
);

-- As medidas cabem no endereco: 1 ou 2 faces, ate 26 linhas e 26 colunas, e faces x colunas ate as
-- 26 letras, porque a traseira continua as letras da frontal. O Zod da rota e o servico conferem
-- antes, com a mensagem no campo; o nome vem sem espaco nas pontas
ALTER TABLE "infra"."formato"
  ADD CONSTRAINT "formato_topologia" CHECK (
    "faces" BETWEEN 1 AND 2
    AND "linhas" BETWEEN 1 AND 26
    AND "colunas" BETWEEN 1 AND 26
    AND "faces" * "colunas" <= 26
  ),
  ADD CONSTRAINT "formato_nome_preenchido" CHECK (btrim("nome") <> '');

-- O nome e unico entre os formatos ativos, sem diferenciar maiuscula, como o da sala. O servico
-- confere antes (FORMATO_DUPLICADO); dois cadastros ao mesmo tempo param aqui, e o formato removido
-- libera o nome
CREATE UNIQUE INDEX "formato_nome_unico"
  ON "infra"."formato" (lower("nome"))
  WHERE "ativo";

-- ---------------------------------------------------------------------------
-- 2. Os 4 formatos da spec, com os nomes do cliente
-- ---------------------------------------------------------------------------

INSERT INTO "infra"."formato" ("nome", "faces", "linhas", "colunas") VALUES
  ('ALESCO Modelo 1', 2, 8, 8),
  ('ALESCO Modelo 2', 2, 5, 5),
  ('TECNIPLAST Modelo 1', 2, 8, 7),
  ('TECNIPLAST Modelo 2', 2, 5, 4);

-- ---------------------------------------------------------------------------
-- 3. Os formatos das estantes
--
-- Cada combinacao de fabricante, modelo e medidas das estantes, ativas ou nao, fica com o formato de
-- mesmo nome (sem diferenciar maiuscula) e mesmas medidas, ou ganha um novo, a da estante mais antiga
-- primeiro. O nome e o fabricante e o modelo, cortado em 60 letras. Se ele ja e de um formato com
-- outras medidas, ou fica vazio, leva as medidas junto, 'X (1 face, 1 x 9)', e um numero se ainda
-- repetir, 'X (1 face, 1 x 9, 2)': nunca dois formatos ativos com o mesmo nome. Em producao todas
-- batem com os 4 da spec, e nenhum formato novo entra.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE "formato_da_combinacao" AS
SELECT btrim(e."fabricante" || ' ' || e."modelo") AS nome_antigo,
       e."faces" AS faces,
       e."linhas" AS linhas,
       e."colunas" AS colunas,
       min(e."id") AS primeira_estante,
       NULL::integer AS id_formato
  FROM "infra"."estante" e
 GROUP BY 1, 2, 3, 4;

DO $formatos$
DECLARE
  v_combinacao record;
  v_medidas text;
  v_sufixo text;
  v_nome text;
  v_tentativa integer;
  v_id integer;
  v_mesmas_medidas boolean;
BEGIN
  FOR v_combinacao IN SELECT * FROM formato_da_combinacao ORDER BY primeira_estante LOOP
    v_medidas := format('%s %s, %s x %s', v_combinacao.faces,
                        CASE WHEN v_combinacao.faces = 1 THEN 'face' ELSE 'faces' END,
                        v_combinacao.linhas, v_combinacao.colunas);
    v_nome := btrim(left(v_combinacao.nome_antigo, 60));
    v_tentativa := 0;

    LOOP
      IF v_nome <> '' THEN
        SELECT f."id", (f."faces", f."linhas", f."colunas") = (v_combinacao.faces, v_combinacao.linhas, v_combinacao.colunas)
          INTO v_id, v_mesmas_medidas
          FROM "infra"."formato" f
         WHERE lower(f."nome") = lower(v_nome)
           AND f."ativo";

        IF NOT FOUND THEN
          INSERT INTO "infra"."formato" ("nome", "faces", "linhas", "colunas")
          VALUES (v_nome, v_combinacao.faces, v_combinacao.linhas, v_combinacao.colunas)
          RETURNING "id" INTO v_id;
          EXIT;
        END IF;

        -- o mesmo nome com as mesmas medidas e o mesmo formato
        EXIT WHEN v_mesmas_medidas;
      END IF;

      v_tentativa := v_tentativa + 1;
      v_sufixo := format(' (%s%s)', v_medidas, CASE WHEN v_tentativa > 1 THEN ', ' || v_tentativa END);
      v_nome := btrim(rtrim(left(v_combinacao.nome_antigo, 60 - length(v_sufixo))) || v_sufixo);
    END LOOP;

    UPDATE formato_da_combinacao
       SET id_formato = v_id
     WHERE primeira_estante = v_combinacao.primeira_estante;
  END LOOP;
END;
$formatos$;

-- ---------------------------------------------------------------------------
-- 4. A estante aponta para o formato
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "infra"."estante" ADD COLUMN "id_formato" INTEGER;

UPDATE "infra"."estante" AS e
   SET "id_formato" = c.id_formato
  FROM formato_da_combinacao AS c
 WHERE c.nome_antigo = btrim(e."fabricante" || ' ' || e."modelo")
   AND c.faces = e."faces"
   AND c.linhas = e."linhas"
   AND c.colunas = e."colunas";

DROP TABLE formato_da_combinacao;

-- Nenhuma estante sem formato, e o formato de cada uma com as medidas que ela tinha
DO $estantes$
DECLARE
  v_falhas text;
BEGIN
  SELECT string_agg(falha, E'\n' ORDER BY falha)
    INTO v_falhas
    FROM (
      SELECT format('estante %s (%s): sem formato', e."id", e."numero_visivel") AS falha
        FROM "infra"."estante" e
       WHERE e."id_formato" IS NULL
      UNION ALL
      SELECT format('estante %s (%s): %s faces, %s linhas e %s colunas, e o formato %s (%s) tem %s, %s e %s',
                    e."id", e."numero_visivel", e."faces", e."linhas", e."colunas",
                    f."id", f."nome", f."faces", f."linhas", f."colunas")
        FROM "infra"."estante" e
        JOIN "infra"."formato" f ON f."id" = e."id_formato"
       WHERE (f."faces", f."linhas", f."colunas") <> (e."faces", e."linhas", e."colunas")
    ) AS falhas;

  IF v_falhas IS NOT NULL THEN
    RAISE EXCEPTION E'As estantes nao fecharam com os formatos:\n%', v_falhas;
  END IF;
END;
$estantes$;

ALTER TABLE "infra"."estante" ALTER COLUMN "id_formato" SET NOT NULL;

-- CreateIndex
CREATE INDEX "estante_id_formato_idx" ON "infra"."estante"("id_formato");

-- AddForeignKey
ALTER TABLE "infra"."estante" ADD CONSTRAINT "estante_id_formato_fkey" FOREIGN KEY ("id_formato") REFERENCES "infra"."formato"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 5. A posicao cabe nas medidas do formato da estante
--
-- O mesmo trigger de antes (o mesmo prefixo TOPOLOGIA e o codigo escrito em todo INSERT e em toda
-- mudanca de posicao ou de codigo), lendo as medidas do formato da estante. O trigger em si nao muda.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "infra"."caixa_dentro_da_topologia"()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_formato record;
BEGIN
  SELECT f."faces", f."linhas", f."colunas"
    INTO v_formato
    FROM "infra"."estante" e
    JOIN "infra"."formato" f ON f."id" = e."id_formato"
   WHERE e."id" = NEW."id_estante";

  IF NOT FOUND THEN
    -- Estante inexistente e problema da FK, nao deste trigger.
    RETURN NEW;
  END IF;

  IF NEW."face"   > v_formato."faces"
  OR NEW."linha"  > v_formato."linhas"
  OR NEW."coluna" > v_formato."colunas" THEN
    RAISE EXCEPTION
      'TOPOLOGIA: a posicao face % linha % coluna % nao existe na estante % (% faces, % linhas, % colunas)',
      NEW."face", NEW."linha", NEW."coluna", NEW."id_estante",
      v_formato."faces", v_formato."linhas", v_formato."colunas"
      USING ERRCODE = 'check_violation';
  END IF;

  NEW."codigo" := "infra"."codigo_da_posicao"(NEW."face", NEW."linha", NEW."coluna", v_formato."colunas");

  IF NEW."codigo" IS NULL THEN
    RAISE EXCEPTION
      'TOPOLOGIA: a estante % tem colunas demais para as 26 letras do endereco',
      NEW."id_estante"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Trocar o formato da estante reescreve as caixas dela
--
-- O codigo vazio faz o trigger da caixa (5) rodar em cada caixa ativa da estante: ele escreve o
-- codigo da posicao pelas colunas do formato novo e recusa (TOPOLOGIA) a caixa que ficou fora, o que
-- desfaz a troca inteira.
--
-- A caixa liberada (ativa = false) guarda o codigo que tinha quando saiu e nao e reescrita: e
-- historico, e pode ate ficar fora das medidas novas.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "infra"."estante_reescreve_as_caixas"()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  UPDATE "infra"."caixa"
     SET "codigo" = ''
   WHERE "id_estante" = NEW."id"
     AND "ativa";

  RETURN NULL;
END;
$fn$;

CREATE TRIGGER "estante_reescreve_as_caixas"
  AFTER UPDATE OF "id_formato"
  ON "infra"."estante"
  FOR EACH ROW
  WHEN (OLD."id_formato" IS DISTINCT FROM NEW."id_formato")
  EXECUTE FUNCTION "infra"."estante_reescreve_as_caixas"();

-- ---------------------------------------------------------------------------
-- 7. Mudar as medidas do formato reescreve as caixas de todas as estantes dele
--
-- O mesmo de (6), nas caixas ativas de cada estante que aponta para o formato. Aqui tambem a caixa
-- liberada (ativa = false) guarda o codigo que tinha quando saiu e nao e reescrita: e historico, e
-- pode ate ficar fora das medidas novas.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "infra"."formato_reescreve_as_caixas"()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  UPDATE "infra"."caixa" AS c
     SET "codigo" = ''
    FROM "infra"."estante" AS e
   WHERE e."id" = c."id_estante"
     AND e."id_formato" = NEW."id"
     AND c."ativa";

  RETURN NULL;
END;
$fn$;

CREATE TRIGGER "formato_reescreve_as_caixas"
  AFTER UPDATE OF "faces", "linhas", "colunas"
  ON "infra"."formato"
  FOR EACH ROW
  WHEN (OLD."faces" IS DISTINCT FROM NEW."faces"
     OR OLD."linhas" IS DISTINCT FROM NEW."linhas"
     OR OLD."colunas" IS DISTINCT FROM NEW."colunas")
  EXECUTE FUNCTION "infra"."formato_reescreve_as_caixas"();

-- ---------------------------------------------------------------------------
-- 8. Saem as colunas copiadas: as medidas sao as do formato, e a capacidade sai delas
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "infra"."estante" DROP CONSTRAINT "estante_capacidade_derivada",
DROP CONSTRAINT "estante_topologia_positiva",
DROP COLUMN "fabricante",
DROP COLUMN "modelo",
DROP COLUMN "faces",
DROP COLUMN "linhas",
DROP COLUMN "colunas",
DROP COLUMN "capacidade";

-- ---------------------------------------------------------------------------
-- 9. Conferencia
--
-- Toda estante com formato, e toda caixa ativa dentro das medidas do formato da sua estante, com o
-- codigo da posicao pela formula do trigger. Se algo falhar, a migration para listando tudo, e nada
-- muda.
-- ---------------------------------------------------------------------------

DO $confere$
DECLARE
  v_falhas text;
BEGIN
  SELECT string_agg(falha, E'\n' ORDER BY falha)
    INTO v_falhas
    FROM (
      SELECT format('estante %s (%s): sem formato', e."id", e."numero_visivel") AS falha
        FROM "infra"."estante" e
        LEFT JOIN "infra"."formato" f ON f."id" = e."id_formato"
       WHERE f."id" IS NULL

      UNION ALL
      SELECT format('caixa %s (%s): face %s, linha %s e coluna %s, fora do formato %s (%s faces, %s linhas, %s colunas)',
                    c."id", c."codigo", c."face", c."linha", c."coluna",
                    f."nome", f."faces", f."linhas", f."colunas")
        FROM "infra"."caixa" c
        JOIN "infra"."estante" e ON e."id" = c."id_estante"
        JOIN "infra"."formato" f ON f."id" = e."id_formato"
       WHERE c."ativa"
         AND (c."face" > f."faces" OR c."linha" > f."linhas" OR c."coluna" > f."colunas")

      UNION ALL
      SELECT format('caixa %s: codigo %s, e a posicao da %s', c."id", c."codigo",
                    "infra"."codigo_da_posicao"(c."face", c."linha", c."coluna", f."colunas"))
        FROM "infra"."caixa" c
        JOIN "infra"."estante" e ON e."id" = c."id_estante"
        JOIN "infra"."formato" f ON f."id" = e."id_formato"
       WHERE c."ativa"
         AND c."codigo" IS DISTINCT FROM "infra"."codigo_da_posicao"(c."face", c."linha", c."coluna", f."colunas")
    ) AS falhas;

  IF v_falhas IS NOT NULL THEN
    RAISE EXCEPTION E'A estante com formato nao fechou:\n%', v_falhas;
  END IF;
END;
$confere$;
