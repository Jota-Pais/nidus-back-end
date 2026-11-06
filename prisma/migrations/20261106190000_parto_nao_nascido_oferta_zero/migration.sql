-- RN-09 com a regra do estoque: parto que ainda nao nasceu oferece 0, e nao os 4 e 4
-- esperados. O codigo ja conta assim desde 3e30ced (estoque, busca, ficha e alocacao so
-- veem o que nasceu), e o banco passa a seguir a mesma regra.
--
-- O resto do trigger nao muda. Ele roda depois de INSERT ou UPDATE em compromisso, e o
-- codigo so insere: compromisso que ja existe em parto nao nascido fica como esta.

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

  -- desmamou -> confirmado | nasceu -> previsto | nem nasceu -> nenhum animal
  SELECT COALESCE(p."desmamado_m", p."nascido_m" - COALESCE(p."eutanasiado_m", 0), 0),
         COALESCE(p."desmamado_f", p."nascido_f" - COALESCE(p."eutanasiado_f", 0), 0)
    INTO v_oferta_m, v_oferta_f
    FROM "reproducao"."parto" p
   WHERE p."id" = NEW."id_parto";

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
