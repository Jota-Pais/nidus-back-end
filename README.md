# Nidus - back-end

API e regras de negócio do Nidus, sistema de gestão de produção e manutenção de
roedores do CPMR/UFSC (Centro de Produção e Manutenção de Roedores da
Universidade Federal de Santa Catarina).

Projeto Integrador: Sistema Web - SATC, Engenharia de Software, fase 4, 2026.2.

Repositório irmão: [nidus-front-end](https://github.com/Jota-Pais/nidus-front-end).

## O que tem aqui

Toda a regra de negócio e a persistência. O front apresenta e coleta, não decide
nada (RNF-01).

- Cadeia temporal - parto e desmame previstos saem do acasalamento, ninguém
  digita; confirmar um parto real recalcula a cadeia à frente (RN-05)
- Viabilidade de prazo - pedido de idade X para a data T só passa se
  `T ≥ hoje + gestação + aleitamento + X` (RN-06)
- Motor de varredura - dado um pedido, quais caixas atendem, com qual grau de
  certeza, e o que falta produzir (RF-MOT-01 a RF-MOT-09)
- Um animal, um compromisso - a soma dos compromissos de um parto nunca passa da
  disponibilidade. É a invariante que o sistema existe pra garantir (RN-09)
- Cruzamento rotacional - grupos A-E, só os pares AB, BC, CD, DE, EA (RN-02)
- Vida útil do casal - encerra no 5º parto confirmado (RN-04)
- Estado da caixa - `em_reproducao` → `parcialmente_comprometida` →
  `totalmente_comprometida` → `preparada_para_envio` → `expedida`, um quadro por
  espécie, segregação aplicada no servidor (RF-CIC-01)
- RBAC - pesquisador, técnico e gestor, decidido no servidor (RF-ACS-02)

Nenhum parâmetro biológico é constante de código: gestação, aleitamento,
tolerância de idade e pares genéticos são dados administráveis (RNF-05).

## Documentos

Requisito e modelagem não moram no código. `contrato-api.md` e
`decisoes-de-stack.md` são idênticos nos dois repositórios - mudou de um lado,
muda do outro no mesmo PR.

| Arquivo | O que é |
|---|---|
| `docs/requisitos.md` | O quê: RF, RN, RNF, pendências (PEN-) e conflitos (CONF-), todos com ID |
| `docs/modelo-de-dados.md` | O modelo lógico: MVP em 14 tabelas e 6 schemas, e o modelo alvo |
| `docs/contrato-api.md` | Como front e back conversam: rotas, campos, envelope de erro |
| `docs/decisoes-de-stack.md` | O que já está decidido e não se rediscute sem a equipe |

## Stack

| Camada | Escolha |
|---|---|
| Runtime | Node ≥ 22, TypeScript em ESM |
| HTTP | Express 5 |
| Banco | PostgreSQL na Neon - o mesmo serviço em dev e produção, sem Docker |
| ORM e migrations | Prisma 7, migrate-first |
| Validação | Zod 4 no limite de cada rota, tipo inferido do schema (`z.infer`) |
| Testes | Vitest + supertest |
| Deploy | Render (API) e Vercel (front) |

Cuidado com uma coisa: `prisma` e `@prisma/client` estão pregados na mesma versão
exata, sem `^`, de propósito. A tag `latest` do CLI às vezes está num release
candidate à frente do client estável, e o par desalinhado quebra a geração. Suba
os dois juntos ou nenhum.

## Começar

```bash
npm install
cp .env.example .env     # preencha DATABASE_URL com a string da Neon
npm run db:deploy        # aplica as migrations pendentes
npm run dev              # http://localhost:3333/saude
```

Precisa de internet pra desenvolver: não temos Postgres local nem container, é o
custo de não ter Docker.

## Scripts

| Script | O que faz |
|---|---|
| `npm run dev` | Sobe a API com recarga automática (`tsx watch`) |
| `npm test` | Roda a suíte no Vitest |
| `npm run test:watch` | Vitest em modo interativo |
| `npm run typecheck` | `tsc` sem emitir - checa `src/` e os arquivos de configuração |
| `npm run build` | Gera o Prisma Client e compila pra `dist/` |
| `npm start` | Roda o build (`dist/server.js`), é o comando da Render |
| `npm run db:deploy` | Aplica migrations pendentes. Nunca dropa nada |
| `npm run db:generate` | Regera o Prisma Client depois de alterar o schema |
| `npm run db:studio` | Abre o Prisma Studio no banco |

## Estrutura

```
prisma/
  schema.prisma        fonte da verdade do banco: models e migrations
prisma.config.ts       URL do banco pra CLI - o Prisma 7 tirou do schema
src/
  server.ts            lê o ambiente, sobe a porta, encerra limpo no SIGTERM
  app.ts               monta o Express sem subir servidor (é o que o teste usa)
  env.ts               Zod no boot: configuração errada não deixa o processo subir
  shared/
    prisma.ts          instância única do client, via driver adapter
    erros.ts           erros de domínio no formato do contrato
    middlewares/
      erro.ts          tratador central + rota inexistente
  modules/             um módulo por área, espelhando os schemas do banco
    infra/  catalogo/  reproducao/  login/  etica/  demanda/  motor/
```

Cada módulo carrega junto o que é dele - rota, schema Zod, serviço e teste:

```
modules/reproducao/
  reproducao.routes.ts    rotas e parse do Zod
  reproducao.schema.ts    esquemas Zod + tipos por z.infer
  reproducao.service.ts   regra que precisa consultar o banco
  reproducao.test.ts      teste do serviço
```

Router novo entra em `app.ts`, sempre sob `/api`.

## Convenções

Tudo sob `/api`. A única exceção é `GET /saude`, o healthcheck que a Render
consulta e pelo qual o front detecta que a instância está acordando.

Validação é `parse` direto na rota. O Express 5 encaminha promise rejeitada pro
tratador de erros sozinho - não precisa de `try/catch` nem de wrapper, e o
`ZodError` já vira `400 VALIDACAO` com a lista de campos:

```ts
const corpo = criarCasalSchema.parse(req.body)     // ZodError -> 400, automático
const casal = await casalService.formar(corpo)     // ErroDeRegra -> 409
res.status(201).json(casal)
```

Cada regra mora num lugar só. Não duplique a mesma checagem em duas camadas:

| Camada | Responsabilidade | Exemplo |
|---|---|---|
| Zod | Forma, tipo, formato e regra entre campos | `idadeAlvoDias` inteiro ≥ 21 |
| Serviço | Regra que precisa consultar o banco | Timeline reversa, cota disponível |
| Postgres | Invariante que nunca pode ser violada | `CHECK` dos pares AB/BC/CD/DE/EA |

Erro sai sempre no envelope do contrato, com código estável - o front decide por
`codigo`, nunca pelo texto:

```json
{ "erro": { "codigo": "PRAZO_INVIAVEL", "mensagem": "…", "requisito": "RN-06" } }
```

Use `erroDeRegra`, `naoEncontrado`, `semPermissao` e `naoAutenticado` de
`shared/erros.ts`. Um `throw new Error` solto vira 500 e a gente lê como bug, não
como regra.

O `char(1)` do banco nunca cruza a rede. O banco guarda `'R'`, a API responde
`"em_reproducao"`. Quem traduz é o back (`contrato-api.md`, seção 1.1).

## Banco e migrations

`schema.prisma` é a fonte da verdade e o Prisma gera as migrations. Temos um
banco oficial na Neon, sem branch por pessoa.

| Quem | Comando | Efeito |
|---|---|---|
| Responsável pelo banco | `npx prisma migrate dev` | Cria a migration. Único comando que pode resetar o banco |
| Todos os demais | `npm run db:deploy` | Só aplica o pendente, em ordem. Nunca dropa nada |

Alteração de schema se pede ao responsável pelo banco, não se faz direto: o
`migrate dev` dropa e recria o schema quando o histórico diverge, e leva junto a
massa de teste de quem estiver usando o banco na hora.

O desenho lógico das tabelas mora em `docs/modelo-de-dados.md`. O schema segue
aquele documento: mudança de modelo se discute lá antes de virar migration.

## Deploy na Render

Web Service no plano free, a partir do GitHub. O `render.yaml` na raiz é um
Blueprint com estes mesmos valores: New → Blueprint apontando pro repositório
cria o serviço e só pede os três segredos. Criar pelo painel também funciona,
preenchendo o que está abaixo.

| Campo | Valor |
|---|---|
| Nome do serviço | `nidus-cpmr-api` → `https://nidus-cpmr-api.onrender.com`. É a URL fixa no `vercel.json` do front; `nidus-api` já está em uso por outro serviço na Render |
| Runtime | Node 24 (`.node-version` na raiz). Sem o arquivo, o `engines` `>=22` faria a Render resolver pro Node mais novo que existir, que muda de major sozinho |
| Região | Ohio, a mesma do banco na Neon (`us-east-2`) |
| Build command | `npm ci --include=dev && npm run build && npm run db:deploy` |
| Start command | `npm start` |
| Health check path | `/saude` |
| Variáveis | `NODE_ENV=production`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `CORS_ORIGEM` (a `PORT` a Render injeta) |

Três detalhes que derrubam o deploy se passarem batido:

- `--include=dev` não é opcional. Com `NODE_ENV=production` o `npm ci` omite as
  devDependencies. `prisma` e `typescript` até sobrevivem (o `@prisma/client` os
  declara como peer opcionais), mas os `@types/*` de express, cors, cookie-parser
  e bcryptjs não, e o `tsc` para em TS7016.
- As duas URLs do banco são necessárias no build, não só a pooled. O
  `prisma generate` carrega o `prisma.config.ts`, que exige
  `DATABASE_URL_UNPOOLED`, e o `db:deploy` usa essa conexão direta pra aplicar
  migrations pendentes. Nunca `migrate dev` na Render.
- `CORS_ORIGEM` é a URL de produção do front na Vercel. O boot reduz o valor à
  origem (`new URL(v).origin`), então barra final ou path sobrando não quebram
  nada. Preview deploy da Vercel tem outra URL e não passa no CORS, e tudo bem.

No arranjo atual o navegador não fala com a Render diretamente: o `vercel.json`
do front reescreve `/api/*` e `/saude` pra esta API, e o cookie de sessão fica de
primeira parte (Safari e Chrome anônimo descartam cookie de terceiro). O
`SameSite=None` e o CORS continuam configurados pro arranjo direto também
funcionar. Tem mais detalhe no README do `nidus-front-end`, em "Deploy na
Vercel".

Dois riscos que a gente aceitou:

- O free tier dorme depois de ~15 min parado e leva de 30s a 1min pra acordar
  (`docs/decisoes-de-stack.md` §1.3). Abra o sistema alguns minutos antes de
  qualquer apresentação.
- A sessão vive em memória (`modules/login/sessao.ts` explica a escolha). Quando
  a instância dorme ou reinicia, todo mundo loga de novo.

## Sobre o andamento

Aqui está estrutura e convenção, não o que já ficou pronto. Quem responde isso é
o Kanban do Trello e o histórico de commits - cada pasta de `src/modules/` vai
sendo preenchida conforme a área avança, e módulo que só tem `.gitkeep` é módulo
que ainda não começou.

Tem um ponto que não se resolve escrevendo código: os itens CONF- e PEN- de
`docs/requisitos.md` são perguntas ao cliente, e alguns travam regra de negócio
inteira. Enquanto estiverem abertos, a escolha entra como parâmetro administrável
(RNF-05) num lugar só, nunca como constante espalhada.

## Equipe

| Integrante | Papel |
|---|---|
| Arthur Serafim Santin | Líder, Scrum Master e QA |
| João Carlos País | Banco de dados |
| Miguel Guerra | Back-end |
| Gabriel Ugione | Front-end e UX/UI |
