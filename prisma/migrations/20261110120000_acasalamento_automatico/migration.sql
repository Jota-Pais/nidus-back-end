-- O acasalamento seguinte passa a abrir sozinho no nascimento, 6 dias depois do parto real (a
-- regra do cliente, INTERVALO_ACASALAMENTO_DIAS em shared/parametros.ts), e o registro manual
-- saiu. Os casais ativos que ja tinham o ultimo parto nascido, com menos de 5 partos, ficariam
-- sem parto pendente e sem como abrir o seguinte: ganham aqui o acasalamento que o codigo novo
-- teria aberto, com a linha do historico como acao do sistema (sem usuario) e o mesmo texto que
-- reproducao.service.ts grava (descricaoDoAcasalamentoAutomatico).
--
-- So dados: nenhuma tabela muda. O CHECK parto_ordem_ciclo (1 a 5) e o parto_datas_em_ordem
-- continuam valendo para as linhas novas.

WITH ultimo AS (
  SELECT DISTINCT ON (p."id_casal") p."id_casal", p."ordem", p."dt_parto_real"
    FROM "reproducao"."parto" p
    JOIN "reproducao"."casal" c ON c."id" = p."id_casal"
   WHERE c."ativo"
   ORDER BY p."id_casal", p."ordem" DESC
),
aberto AS (
  INSERT INTO "reproducao"."parto" ("id_casal", "ordem", "dt_acasalamento")
  SELECT u."id_casal", u."ordem" + 1, u."dt_parto_real" + 6
    FROM ultimo u
   WHERE u."dt_parto_real" IS NOT NULL
     AND u."ordem" < 5
  RETURNING "id", "id_casal", "ordem", "dt_acasalamento"
)
INSERT INTO "auditoria"."historico" ("id_usuario", "entidade", "id_entidade", "acao", "descricao", "dados")
SELECT NULL,
       'parto',
       a."id",
       'acasalamento',
       format(
         'Acasalamento do %sº parto do casal %s em %s, aberto sozinho 6 dias depois do %sº parto',
         a."ordem",
         trim(c."identificacao"),
         to_char(a."dt_acasalamento", 'YYYY-MM-DD'),
         a."ordem" - 1
       ),
       jsonb_build_object('dtAcasalamento', to_char(a."dt_acasalamento", 'YYYY-MM-DD'), 'automatico', true)
  FROM aberto a
  JOIN "reproducao"."casal" c ON c."id" = a."id_casal";
