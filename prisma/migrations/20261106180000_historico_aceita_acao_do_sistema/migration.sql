-- A recusa do pedido sem resposta em 14 dias e feita pelo proprio sistema, sem ninguem da
-- equipe por tras. O historico passa a aceitar registro sem usuario, e a tela mostra
-- "Sistema" no lugar do nome. Nao se cria conta "Sistema": ela precisaria de perfil e
-- e-mail, apareceria em Usuarios e daria para tentar entrar com ela.

ALTER TABLE "auditoria"."historico" ALTER COLUMN "id_usuario" DROP NOT NULL;

-- As recusas automaticas gravadas antes desta migration levaram o id de quem fez o pedido,
-- e na tela parecia que o pesquisador tinha recusado o proprio pedido.
UPDATE "auditoria"."historico"
SET "id_usuario" = NULL
WHERE "entidade" = 'solicitacao'
  AND "acao" = 'recusa'
  AND "dados"->>'motivo' = 'Recusado automaticamente: o CPMR nao respondeu em 14 dias.';
