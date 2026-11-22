CREATE TABLE "reproducao"."viuva" (
    "id" SERIAL NOT NULL,
    "id_caixa" INTEGER NOT NULL,
    "id_casal" INTEGER NOT NULL,
    "id_linhagem" INTEGER NOT NULL,
    "dt_viuvez" DATE NOT NULL,
    "id_usuario" INTEGER,
    "dt_criacao" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dt_manutencao" TIMESTAMPTZ(6),

    CONSTRAINT "viuva_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "viuva_id_casal_key" ON "reproducao"."viuva"("id_casal");

CREATE INDEX "viuva_id_caixa_idx" ON "reproducao"."viuva"("id_caixa");

ALTER TABLE "reproducao"."viuva" ADD CONSTRAINT "viuva_id_caixa_fkey" FOREIGN KEY ("id_caixa") REFERENCES "infra"."caixa"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "reproducao"."viuva" ADD CONSTRAINT "viuva_id_casal_id_linhagem_fkey" FOREIGN KEY ("id_casal", "id_linhagem") REFERENCES "reproducao"."casal"("id", "id_linhagem") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "reproducao"."viuva" ADD CONSTRAINT "viuva_id_linhagem_fkey" FOREIGN KEY ("id_linhagem") REFERENCES "catalogo"."linhagem"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "reproducao"."viuva" ADD CONSTRAINT "viuva_id_usuario_fkey" FOREIGN KEY ("id_usuario") REFERENCES "login"."usuario"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Escrito a mao: o Prisma nao gera CHECK nem trigger.
ALTER TABLE "infra"."caixa" DROP CONSTRAINT "caixa_tipo_dominio",
DROP CONSTRAINT "caixa_estoque_completo";

ALTER TABLE "infra"."caixa"
  ADD CONSTRAINT "caixa_tipo_dominio" CHECK ("tipo" IN ('casal', 'estoque', 'viuvas')),
  ADD CONSTRAINT "caixa_estoque_completo" CHECK (
    CASE "tipo"
      WHEN 'estoque' THEN "sexo" IN ('M', 'F') AND "id_linhagem" IS NOT NULL
      WHEN 'viuvas' THEN "sexo" IS NULL AND "id_linhagem" IS NOT NULL
      ELSE "sexo" IS NULL AND "id_linhagem" IS NULL
    END
  );

CREATE FUNCTION "reproducao"."viuva_coerente"()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_caixa record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.id_caixa = OLD.id_caixa AND NEW.id_linhagem = OLD.id_linhagem THEN
    RETURN NEW;
  END IF;

  SELECT c.codigo, c.ativa, c.tipo, c.id_linhagem
    INTO v_caixa
    FROM "infra"."caixa" c
   WHERE c.id = NEW.id_caixa
     FOR SHARE OF c;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_caixa.tipo <> 'viuvas' THEN
    RAISE EXCEPTION 'VIUVA_CAIXA: a caixa % nao e uma caixa de viuvas', v_caixa.codigo
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT v_caixa.ativa THEN
    RAISE EXCEPTION 'VIUVA_CAIXA: a caixa % ja foi liberada', v_caixa.codigo
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_caixa.id_linhagem IS DISTINCT FROM NEW.id_linhagem THEN
    RAISE EXCEPTION 'VIUVA_CAIXA: a caixa de viuvas % e de outra linhagem', v_caixa.codigo
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER "viuva_coerente"
  BEFORE INSERT OR UPDATE OF "id_caixa", "id_linhagem"
  ON "reproducao"."viuva"
  FOR EACH ROW
  EXECUTE FUNCTION "reproducao"."viuva_coerente"();

CREATE OR REPLACE FUNCTION "colonia"."lugar_recusado"(p_id_parto integer, p_sexo char(1), p_id_caixa integer)
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_parto record;
  v_caixa record;
BEGIN
  SELECT cs.id_caixa AS id_caixa_do_casal, p.id_linhagem, l.id_especie, l.nome AS linhagem
    INTO v_parto
    FROM "reproducao"."parto" p
    JOIN "catalogo"."linhagem" l ON l.id = p.id_linhagem
    LEFT JOIN "reproducao"."casal" cs ON cs.id = p.id_casal
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

  IF v_caixa.tipo = 'casal' AND v_parto.id_caixa_do_casal IS DISTINCT FROM p_id_caixa THEN
    RETURN format('a caixa de casal %s so guarda a ninhada do proprio casal', v_caixa.codigo);
  END IF;

  IF v_caixa.tipo = 'viuvas' THEN
    RETURN format('a caixa de viuvas %s nao recebe animais', v_caixa.codigo);
  END IF;

  RETURN NULL;
END;
$fn$;
