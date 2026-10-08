# Nidus - back-end

API e regras de negócio do Nidus, o sistema de controle de produção de roedores do
CPMR/UFSC (Centro de Produção e Manutenção de Roedores da Universidade Federal de
Santa Catarina).

Projeto Integrador: Sistema Web - SATC, Engenharia de Software, fase 4, 2026.2.
Repositório irmão: [nidus-front-end](https://github.com/Jota-Pais/nidus-front-end).

## Escopo

O Nidus é o equivalente, na nossa stack, do sistema que o próprio cliente montou
(`Malcoringa/Sistema-CPMR-UFSC`, branch `master`). A referência de requisitos é
a spec dele, o `instructions.md` v2.7, de 18/09/2026. Se o sistema do cliente não
tem, a gente não faz.

O que mora aqui:

- **Kanban** - um quadro por espécie, cinco colunas (`livres`, `pre_reserva`,
  `estoque`, `reserva`, `enviado`). Mover uma caixa que tem animais comprometidos
  só passa com confirmação
- **Estantes** - a grade das duas faces, com a posição vazia como `caixa: null`.
  O endereço segue a etiqueta do cliente: face, linha e letra (`F1A`, `T2K`)
- **Ficha da caixa** - casal (cruzamento AB, BC, CD, DE, EA), do 1º ao 5º parto,
  com parto, eutanásia de seleção e desmame. As datas previstas saem sozinhas:
  parto = acasalamento + 23 dias, desmame = parto + 22, próximo acasalamento =
  parto real + 6
- **Solicitações** - o pedido do pesquisador, sempre num projeto CEUA vigente
- **Busca de atendimento** - dado um pedido, quais caixas atendem: primeiro o que
  já desmamou, depois o que já nasceu, por último o parto previsto, sempre pela
  idade mais próxima. O que faltar vira casais novos a formar
- **Alocação** - cada caixa aceita vira compromisso, e a soma dos compromissos de
  um parto nunca passa do que ele tem

Os parâmetros biológicos (gestação, aleitamento, tolerância de idade, pares
genéticos) estão no banco, não no código.

## Começar

```bash
npm install
cp .env.example .env     # preencha DATABASE_URL com a string da Neon
npm run db:generate      # gera o Prisma Client
npm run dev              # http://localhost:3333/saude
```

O banco é um só, na Neon, o mesmo de produção. Desenvolver precisa de internet,
e o que você grava rodando local aparece para o cliente.

| Script | O que faz |
|---|---|
| `npm run dev` | API com recarga automática (`tsx watch`) |
| `npm test` | Vitest. Nenhum teste abre conexão com o banco |
| `npm run typecheck` | `tsc` sem emitir |
| `npm run build` | Gera o Prisma Client e compila para `dist/` |
| `npm start` | Roda o build, é o comando da Render |
| `npm run db:deploy` | Aplica migrations pendentes. Nunca dropa nada |
| `npm run db:massa` | Grava a massa de demonstração (não faz nada se ela já estiver no banco) |

## Stack

Node 24 e TypeScript em ESM, Express 5, PostgreSQL na Neon, Prisma 7, Zod 4 na
entrada de cada rota, Vitest + supertest. Deploy na Render.

`prisma` e `@prisma/client` estão pregados na mesma versão exata, sem `^`. Suba os
dois juntos ou nenhum.

## Estrutura

```
prisma/schema.prisma   o banco: models e migrations
src/
  app.ts               monta o Express (é o que o teste usa)
  server.ts            sobe a porta e encerra limpo no SIGTERM
  shared/              prisma, erros, tradução dos códigos do banco, autorização
  modules/
    infra/             estantes, grade, kanban e ficha
    reproducao/        casais e partos
    demanda/           projetos CEUA, solicitações e alocação
    motor/             busca de atendimento
    catalogo/          espécies, linhagens e parâmetros
    login/             sessão
```

Validação é `parse` do Zod direto na rota: `ZodError` vira `400 VALIDACAO`.
Regra de negócio violada sai como 409 pelo `erroDeRegra` de `shared/erros.ts`, no
envelope `{ "erro": { "codigo", "mensagem" } }`. O `char(1)` do banco nunca cruza
a rede: o banco guarda `R`, a API responde `livres` (`shared/traducao.ts`).

Mudança de schema passa pelo responsável pelo banco. `prisma migrate dev` pode
recriar o schema quando o histórico diverge, e o banco é o de produção.

## Deploy na Render

Web Service no plano free, a partir do GitHub, descrito no `render.yaml`. Push em
`main` publica sozinho.

| Campo | Valor |
|---|---|
| Serviço | `nidus-cpmr-api` → https://nidus-cpmr-api.onrender.com (é a URL do `vercel.json` do front) |
| Região | Ohio, a mesma da Neon |
| Build | `npm ci --include=dev && npm run build && npm run db:deploy` |
| Start | `npm start` |
| Health check | `/saude` |
| Variáveis | `NODE_ENV=production`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `CORS_ORIGEM` |

- `--include=dev` é obrigatório: sem ele faltam os `@types/*` e o `tsc` para.
- O free tier dorme depois de uns 15 minutos parado e leva até um minuto para
  acordar. Abra o sistema antes de qualquer apresentação.
- A sessão vive em memória: quando a instância reinicia, todo mundo loga de novo.

## Equipe

| Integrante | Papel |
|---|---|
| Arthur Serafim Santin | Líder, Scrum Master e QA |
| João Carlos País | Banco de dados |
| Miguel Guerra | Back-end |
| Gabriel Ugione | Front-end e UX/UI |
