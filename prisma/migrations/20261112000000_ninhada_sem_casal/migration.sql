-- Ninhada sem casal conhecido, para o cadastro inicial da colonia que o cliente ja tem: a caixa de
-- estoque com ratos de idade conhecida e casal desconhecido. Os animais continuam vindo de um parto
-- (colonia.animal.id_parto), e a ninhada deles e um parto sem casal, sem ordem e sem acasalamento,
-- com o nascimento informado. A trilha ganha a ocorrencia 'entrada', que poe esses animais na caixa.
--
-- Para isso a linhagem passa a morar no parto: e dela que o animal tira a linhagem e a especie,
-- tenha a ninhada casal ou nao. Na ninhada com casal, a FK composta (id_casal, id_linhagem) cobra
-- que ela e a do casal, que nunca muda.
--
-- Uma migration so, sem BEGIN/COMMIT: o Prisma manda o arquivo inteiro de uma vez e o Postgres roda
-- tudo numa transacao implicita. Qualquer erro desfaz tudo. Antes de tentar de novo:
-- `prisma migrate resolve --rolled-back 20261112000000_ninhada_sem_casal`.
--
-- A base do DDL e o `prisma migrate diff` do schema.prisma, reordenado a mao: a coluna nova entra
-- nula, e preenchida pelo casal e so depois fica NOT NULL.

-- ---------------------------------------------------------------------------
-- 1. A linhagem da ninhada no parto
-- ---------------------------------------------------------------------------

ALTER TABLE "reproducao"."parto" ADD COLUMN "id_linhagem" INTEGER;

-- Todo parto que existe hoje tem casal: a linhagem e a dele
UPDATE "reproducao"."parto" p
   SET "id_linhagem" = c."id_linhagem"
  FROM "reproducao"."casal" c
 WHERE c."id" = p."id_casal";

ALTER TABLE "reproducao"."parto" ALTER COLUMN "id_linhagem" SET NOT NULL;

-- CreateIndex: o alvo da FK composta
CREATE UNIQUE INDEX "casal_id_id_linhagem_key" ON "reproducao"."casal"("id", "id_linhagem");

-- A FK simples para o casal vira a composta, que tambem confere a existencia do casal. Com
-- id_casal nulo (MATCH SIMPLE), ela nao confere nada: a ninhada sem casal so tem a da linhagem
ALTER TABLE "reproducao"."parto" DROP CONSTRAINT "parto_id_casal_fkey";

-- AddForeignKey
ALTER TABLE "reproducao"."parto" ADD CONSTRAINT "parto_id_casal_id_linhagem_fkey" FOREIGN KEY ("id_casal", "id_linhagem") REFERENCES "reproducao"."casal"("id", "id_linhagem") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reproducao"."parto" ADD CONSTRAINT "parto_id_linhagem_fkey" FOREIGN KEY ("id_linhagem") REFERENCES "catalogo"."linhagem"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 2. A ninhada sem casal
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "reproducao"."parto" ALTER COLUMN "id_casal" DROP NOT NULL,
ALTER COLUMN "ordem" DROP NOT NULL,
ALTER COLUMN "dt_acasalamento" DROP NOT NULL;

-- Sem casal: sem ordem, sem acasalamento e com o nascimento. Com casal, como sempre foi: ordem e
-- acasalamento obrigatorios.
--
-- Os CHECKs que ja existem continuam valendo e nao precisam mudar, porque comparacao com nulo nao
-- recusa: parto_ordem_ciclo (1 a 5) so olha a ordem que existe; parto_datas_em_ordem compara o
-- nascimento e o "sem ninhada" com o acasalamento so quando ha acasalamento, e continua cobrando o
-- desmame depois do nascimento e o "sem ninhada" so sem nascimento (logo, nunca na ninhada sem
-- casal). O unique (id_casal, ordem) nao junta linhas com nulo: cada ninhada sem casal e uma.
ALTER TABLE "reproducao"."parto"
  ADD CONSTRAINT "parto_ninhada_sem_casal" CHECK (
    CASE WHEN "id_casal" IS NULL
      THEN "ordem" IS NULL AND "dt_acasalamento" IS NULL AND "dt_parto_real" IS NOT NULL
      ELSE "ordem" IS NOT NULL AND "dt_acasalamento" IS NOT NULL
    END
  );

-- A entrada: os animais do cadastro inicial chegando numa caixa, de uma ninhada
ALTER TABLE "colonia"."ocorrencia" DROP CONSTRAINT "ocorrencia_tipo_dominio";

ALTER TABLE "colonia"."ocorrencia"
  ADD CONSTRAINT "ocorrencia_tipo_dominio" CHECK (
    "tipo" IN ('nascimento', 'entrada', 'baixa', 'mudanca', 'reserva', 'reserva_desfeita', 'entrega', 'correcao', 'anulacao')
  ),
  ADD CONSTRAINT "ocorrencia_entrada_tem_destino" CHECK (
    "tipo" <> 'entrada' OR ("id_caixa_destino" IS NOT NULL AND "id_parto" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 3. As funcoes que liam a linhagem pelo casal
--
-- Mesma assinatura e mesmo texto das de 20261108200000_colonia_por_animal; muda so de onde vem a
-- linhagem (o parto) e a caixa do casal, que a ninhada sem casal nao tem. Os triggers que as
-- chamam continuam os mesmos.
-- ---------------------------------------------------------------------------

-- Onde um animal vivo pode estar: em caixa ativa da especie dele; na caixa de estoque, so do sexo
-- e da linhagem dela; na caixa de casal, so filhote do proprio casal. A ninhada sem casal nao tem
-- caixa de casal e por isso nunca fica numa: a comparacao e IS DISTINCT FROM, porque com '<>' o
-- nulo deixaria passar.
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

  RETURN NULL;
END;
$fn$;

-- O pedido coerente com os seus animais (a regra inteira esta em 20261108200000_colonia_por_animal):
-- todo animal do pedido e da linhagem dele, agora lida no parto.
CREATE OR REPLACE FUNCTION "demanda"."pedido_recusado"(
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
         count(*) FILTER (WHERE p.id_linhagem <> p_id_linhagem)
    INTO v_vivos_m, v_vivos_f, v_entregues_m, v_entregues_f, v_outra_linhagem
    FROM "colonia"."animal" a
    JOIN "reproducao"."parto" p ON p.id = a.id_parto
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

-- O animal coerente (a regra inteira esta em 20261108200000_colonia_por_animal). A linhagem e o
-- nascimento vem do parto, com casal ou sem. O animal entra vivo pelo nascimento, pela entrada do
-- cadastro inicial ou pelo animal a mais da correcao, sempre de parto que ja nasceu.
CREATE OR REPLACE FUNCTION "colonia"."animal_coerente"()
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

  SELECT p.dt_parto_real, p.id_linhagem
    INTO v_dt_parto_real, v_id_linhagem
    FROM "reproducao"."parto" p
   WHERE p.id = NEW.id_parto;

  IF NOT FOUND THEN
    -- parto inexistente e problema da FK
    RETURN NEW;
  END IF;

  -- A vida do animal
  IF TG_OP = 'INSERT' THEN
    IF NEW.situacao <> 'vivo' THEN
      RAISE EXCEPTION 'ANIMAL_SITUACAO: todo animal entra vivo'
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
