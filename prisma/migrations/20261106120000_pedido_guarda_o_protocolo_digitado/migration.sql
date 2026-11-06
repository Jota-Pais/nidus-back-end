-- O pedido deixa de depender do projeto cadastrado: guarda o protocolo CEUA que a pessoa
-- digitou, e o projeto passa a ser opcional. Cadastrar cada projeto a mao antes do pedido
-- nao cabe na rotina do bioterio; a equipe tecnica confere o protocolo ao analisar.
--
-- Nao apaga nada: os pedidos que ja existem copiam o numero do projeto a que apontam, e a
-- chave estrangeira para etica.projeto continua.

ALTER TABLE "demanda"."solicitacao" ADD COLUMN "protocolo_ceua" VARCHAR(30);

UPDATE "demanda"."solicitacao" AS s
SET "protocolo_ceua" = p."numero"
FROM "etica"."projeto" AS p
WHERE p."id" = s."id_projeto";

ALTER TABLE "demanda"."solicitacao" ALTER COLUMN "protocolo_ceua" SET NOT NULL;

ALTER TABLE "demanda"."solicitacao" ALTER COLUMN "id_projeto" DROP NOT NULL;
