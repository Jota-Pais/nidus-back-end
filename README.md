# Nidus - back-end

API e regras de negócio do Nidus, um sistema de controle de produção de roedores. O
cliente do projeto é o CPMR/UFSC (Centro de Produção e Manutenção de Roedores da
Universidade Federal de Santa Catarina).

Projeto Integrador: Sistema Web - SATC, Engenharia de Software, fase 4, 2026.2.
Repositório irmão: [nidus-front-end](https://github.com/Jota-Pais/nidus-front-end).

## Escopo

O Nidus é o equivalente, na nossa stack, do sistema que o próprio cliente montou
(`Malcoringa/Sistema-CPMR-UFSC`, branch `master`). A referência de requisitos é
a spec dele, o `instructions.md` v2.7, de 18/09/2026. Se o sistema do cliente não
tem, a gente não faz.

O que mora aqui:

- **Visão geral** (`GET /api/visao-geral`) - a colônia por espécie e linhagem:
  casais ativos, vivos, quantos mamam, quantos estão reservados, quantos estão
  livres e a idade dos livres em quatro faixas (até 21 dias, 22 a 35, 36 a 60 e
  mais de 60). Tudo é contado nos animais; nada fica gravado. Não existe
  Pré-reserva: o animal está reservado ou não
- **Estantes** - a grade das duas faces, com a posição vazia como `caixa: null`.
  O endereço segue a etiqueta do cliente: face, linha e letra (`F1A`, `T2K`).
  Cada caixa traz a linhagem (`idLinhagem`), para a grade filtrar por ela
- **Salas, formatos e estantes** (`/api/salas`, `/api/formatos` e `/api/estantes`,
  técnico e gestor) - a sala é tabela própria e existe sem estante; renomear muda
  num lugar só. O formato guarda as medidas de um modelo de estante (1 ou 2 faces,
  linhas e colunas até 26, faces x colunas até as 26 letras do endereço), e a
  estante aponta para ele: os 4 da spec (ALESCO Modelo 1 e 2, TECNIPLAST Modelo 1
  e 2) vêm da migration. A estante muda de número, de sala e de formato, e mudar
  as medidas de um formato muda todas as estantes dele. Nas duas mudanças o banco
  reescreve o código das caixas ativas (a traseira continua as letras da frontal,
  então a letra dela muda com o número de colunas), e a mudança que deixaria caixa
  ativa fora é recusada antes, dizendo quais (`409 CAIXAS_FORA_DO_FORMATO`); a
  caixa liberada guarda o código com que saiu. O nome da sala e o do formato são únicos
  entre os ativos, sem diferenciar maiúscula (`409 SALA_DUPLICADA`,
  `409 FORMATO_DUPLICADO`), e o número da etiqueta é único na sala
  (`409 ESTANTE_DUPLICADA`). Remover é `ativa = false` (no formato, `ativo`) e vai
  para o histórico: a sala só sai sem estante ativa (`409 SALA_COM_ESTANTE`), o
  formato também (`409 FORMATO_EM_USO`), e a estante, sem caixa ativa
  (`409 ESTANTE_OCUPADA`)
- **Ficha da caixa** - casal (grupos A a E em qualquer par), do 1º ao 5º parto,
  com parto, eutanásia de seleção e desmame. As datas previstas saem sozinhas:
  parto = acasalamento + 23 dias, desmame = parto + 22. O acasalamento seguinte
  abre sozinho no nascimento, 6 dias depois do parto real (ninguém vê o casal
  acasalar; a data só prevê o parto) e se edita direto na ficha, sem motivo: a que
  vale é a última. A correção da data do nascimento leva junto o acasalamento que o
  sistema abriu, se ele ainda não deu parto nem foi editado, e o encerramento antes
  dele o desfaz. O casal que já existia antes do Nidus entra no parto em que está
  (`partoAtual` de 1 a 5 no `POST /api/casais`; sem ele, o 1º): os partos de antes
  não existem no sistema, e a ficha diz em `casal.partoInicial` em qual ele entrou.
  O engano de digitação do casal se edita depois (`PATCH /api/casais/:id`, técnico e
  gestor, casal ativo ou encerrado, sem motivo): grupos, linhagem, formação e
  `partoInicial`. A linhagem leva os partos e as caixas de estoque só com animais do
  casal; a formação, o acasalamento do 1º parto que era o dela; o parto de entrada
  renumera todos. Recusa só o que ficaria contraditório (caixa de estoque com outra
  ninhada, animal reservado para pedido de outra linhagem, mais de 5 partos, datas
  fora de ordem)
- **Animais** - cada filhote que nasce vira uma linha anônima em `colonia.animal`,
  com o parto de origem, o sexo, a caixa onde está e a situação (vivo, morto,
  entregue ou anulado). Toda contagem da ficha é contada nos animais. Morte e
  eutanásia são uma ação só, a baixa (`POST /api/caixas/:id/baixa`), em qualquer
  caixa; a seleção e a diferença do desmame são baixas do parto. Baixa lançada
  por engano se anula, uma vez só (`POST /api/ocorrencias/:id/anulacao`): cada
  sexo volta para a caixa onde estava ou, se ela não serve mais para ele, para a
  caixa de estoque indicada (`idCaixaMachos`, `idCaixaFemeas`); faltando as duas, a
  recusa pede as duas no mesmo 400. Cada ação grava uma
  ocorrência com os animais que tocou, e só `lancarOcorrencia`
  (`src/modules/colonia/ocorrencia.ts`) escreve nos animais
- **Caixas** - a caixa é só o lugar. Desmamados mudam de caixa por
  `POST /api/caixas/:id/mudanca`: da caixa do casal para o estoque, ou de estoque
  para estoque, cada sexo para uma caixa de estoque do mesmo sexo e linhagem ou
  para uma caixa nova numa posição vazia. Saem os livres primeiro e, se não
  bastarem, os reservados do pedido indicado (`idPedido`); com `soDoPedido`,
  só os reservados dele. A reserva vai junto. A caixa do casal
  encerrado com desmamados de um sexo vira de estoque no lugar
  (`POST /api/caixas/:id/estoque`). A caixa que esvazia é liberada com a data e o
  motivo do fato. A fase da caixa (a cor na grade e na ficha) não é gravada: sai
  do que a caixa tem (`faseDaCaixa`). A de casal fica pronta para o estoque se
  ainda tem desmamados; senão, mamando se tem filhotes; senão, acasalada se tem
  parto pendente. A de estoque fica em estoque. `atrasado` marca o parto
  previsto que passou sem nascimento e o filhote com mais de 22 dias sem desmame
- **Cadastro inicial do estoque** - os ratos que a colônia já tinha, de idade
  conhecida e casal desconhecido, entram numa caixa de estoque nova numa posição
  vazia (`POST /api/caixas/estoque`, com a posição como no formar casal, a
  linhagem, o sexo, a quantidade e o nascimento) ou numa caixa de estoque que já
  existe (`POST /api/caixas/:id/entrada`). Viram uma ninhada sem casal (parto sem
  casal, ordem e acasalamento), desmamada no dia do cadastro, e a trilha ganha a
  ocorrência `entrada`. Estoque é de desmamados: menos de 21 dias é recusado. Nas
  telas, a origem dessa ninhada vem com `casal` e `ordem` nulos
- **Pedidos** - o pedido do pesquisador, com o protocolo CEUA dele, sem
  depender de projeto cadastrado: machos, fêmeas e animais de qualquer sexo, com
  idade exata ou faixa de idade
- **Busca de atendimento** - dado um pedido, de onde sairiam os animais: os vivos
  livres da linhagem, por caixa e data de nascimento (dentro da caixa, só a idade
  distingue os ratos). Primeiro o que já desmamou, depois o que desmama até a
  entrega. Dentro de cada grupo, na faixa de idade, primeiro o que está dentro da faixa pedida e
  depois o que só entra pela tolerância, cada parte do mais velho para o mais
  novo; na idade exata, a mais próxima. O que faltar vira casais novos a formar
- **Reserva e entrega** - a reserva fica no animal: cada rato reservado aponta
  para o pedido, e a entrega leva exatamente esses ratos, das caixas onde estão

Os parâmetros biológicos (gestação, aleitamento, intervalo, máximo de 5 partos,
4 machos e 4 fêmeas esperados por casal, tolerância de idade) são constantes em
`src/shared/parametros.ts`, como no `settings.py` do sistema do cliente, e não vão
para o banco: nenhum trigger repete esses números.

## Pedido de animais e busca de atendimento

- **Protocolo CEUA** (`protocoloCeua` do pedido e `numero` do projeto) - vale
  um dos dois formatos que a CEUA da UFSC usa: o processo da UFSC,
  `23080.XXXXXX/AAAA-XX`, com os dois verificadores em módulo 11 e o ano até o
  atual, ou o número do Sistema CEUA, 10 dígitos sem pontuação, em que os 6
  últimos são a data do registro (DDMMAA), até hoje. O pedido e o cadastro do
  projeto usam a mesma regra (`src/modules/demanda/protocolo.ts`): o que o
  gestor cadastra, o pesquisador consegue pedir
- **Pedido** (`POST /api/pedidos`) - o pesquisador digita o nome e o
  protocolo CEUA; o e-mail é o da conta. O protocolo vale
  pelo formato: o pedido guarda o número digitado e não depende de projeto
  cadastrado, e a equipe do biotério confere com a CEUA ao analisar. Quando o
  número já está em `etica.projeto`, o pedido fica ligado ao projeto. O pedido traz machos, fêmeas e
  animais de qualquer sexo (até 9999 cada, ao menos um no total), a idade de 21 a
  300 dias como faixa `idadeMin..idadeMax` (a exata é `idadeMin = idadeMax`), a
  data de entrega (a partir de hoje, pelo dia de Brasília) e
  observações opcionais (até 500 caracteres). Protocolo fora dos dois
  formatos dá `400 VALIDACAO` com `campos.protocoloCeua`
- **Faixa aceita** (`GET /api/busca`, com `idadeMin`, `idadeMax` e `qualquer`) -
  a tolerância da seção 1.6 da spec vale nas pontas: de `faixaAceita(idadeMin).min`
  a `faixaAceita(idadeMax).max`. A idade exata aceita o mesmo de antes (28 aceita
  de 25 a 31). Na ordem da busca, no mesmo grupo de origem, o que só entra pela
  tolerância (20 ou 44 num pedido de 21 a 40) vem depois do que está dentro de
  `idadeMin..idadeMax`
- **Qualquer sexo** - machos e fêmeas saem primeiro, na ordem das caixas; o
  "qualquer" sai depois, do que sobrou em cada caixa (machos antes de fêmeas),
  sem tirar animal de quem pediu sexo. O `alocar` de cada caixa continua
  `{ m, f }`, e o `deficit` é `{ m, f, qualquer }`
- **Casais a formar** - `max(⌈dm/4⌉, ⌈df/4⌉, ⌈(dm + df + dq)/8⌉)`, com os 4 machos
  e 4 fêmeas esperados por casal. O acasalamento novo só atende entrega a partir
  de hoje + 23 dias de gestação + `idadeMin`

O status do pedido é a palavra, no banco e na API: `enviado` (aguarda a análise),
`aprovado` (aceito, aguardando os animais), `reservado`, `entregue` ou `recusado`.
Entregue e recusado são finais. Cada passo é uma rota em `/api/pedidos/:id`, só
de quem opera a colônia:

| Rota | O que faz |
|---|---|
| `POST /aprovacao` | `enviado` → `aprovado`. Não reserva nada, e quem pediu recebe o e-mail |
| `POST /alocacao` | `{ itens: [{ idCaixa, dtNascimento, machos, femeas }] }`, os lugares que a busca sugeriu. No `aprovado`, os itens cobrem o pedido inteiro (`409 PEDIDO_INCOMPLETO`), o "qualquer" vindo como macho ou fêmea, e o pedido passa a `reservado`. No `reservado` em falta, completa só até cobrir (`409 PEDIDO_EXCEDIDO`). Os animais são quaisquer vivos livres do lugar, travados com `FOR UPDATE SKIP LOCKED`: quem reserva ao mesmo tempo pega outros, e se faltarem é `409 SEM_ANIMAIS`. A idade e o desmame são conferidos na data desejada, com a regra da busca |
| `POST /devolucao` | Desfaz a reserva, com falta ou sem: os vivos voltam a ficar livres onde estão e o pedido volta a `aprovado` |
| `POST /recusa` | `{ motivo }`. Vale para `enviado`, `aprovado` e `reservado`; o reservado solta os animais antes |
| `GET /retirada` | De que caixas tirar os reservados: onde eles estão de fato, por caixa, sexo e nascimento |
| `POST /entrega` | `{ dtEntrega }`, nunca no futuro nem antes do pedido. Só o `reservado` sem falta. Cada animal precisa do desmame registrado (`409 NAO_DESMAMADO`) e da idade, na data real, dentro da faixa aceita, com a mesma tolerância da busca (`409 IDADE_FORA_DA_FAIXA`). A caixa que esvaziou é liberada com a data da entrega e fica 7 dias em Enviado |

A reserva confere só o que ela mesma reserva: os animais que marca e o teto do
próprio pedido. Quando um reservado morre, a falta é desse pedido (`reservaEmFalta`
na lista) e não trava a reserva de outro pedido na mesma ninhada ou caixa. O
pedido `enviado` sem resposta em 14 dias é recusado sozinho, sem usuário, antes de
cada `GET /api/pedidos`. Aprovação e recusa ficam em `auditoria.historico`; reserva,
reserva desfeita e entrega são fatos dos animais e ficam na trilha de ocorrências.
A tela Histórico lê as duas fontes juntas, e cada fato aparece uma vez.

## Começar

```bash
npm install
cp .env.example .env     # preencha DATABASE_URL e DATABASE_URL_UNPOOLED com as strings da Neon
npm run db:generate      # gera o Prisma Client
npm run dev              # http://localhost:3333/saude
```

O banco é um só, na Neon, o mesmo de produção. Desenvolver precisa de internet,
e o que você grava rodando local aparece para o cliente.

| Script | O que faz |
|---|---|
| `npm run dev` | API com recarga automática (`tsx watch`) |
| `npm test` | Vitest, a suíte unitária. Não abre conexão com banco nenhum |
| `npm run test:banco` | Vitest, a suíte de integração (`*.banco.test.ts`), contra o banco de `DATABASE_URL_TESTE` (abaixo) |
| `npm run typecheck` | `tsc` sem emitir |
| `npm run build` | Gera o Prisma Client e compila para `dist/` |
| `npm start` | Roda o build, é o comando da Render |
| `npm run db:deploy` | Aplica migrations pendentes. Nunca dropa nada |
| `npm run db:seed` | Carga inicial: espécies, linhagens, parâmetros, salas e uma estante de cada formato da spec, que vem da migration (não duplica nada) |
| `npm run db:usuarios` | Cria os três usuários e o projeto CEUA num banco novo. Procura cada usuário pelo e-mail: o que acha fica como está, o que não acha é criado de novo |
| `npm run db:senha -- <email> "<senha>"` | Define a senha de um usuário que já existe. É a reserva de quem já tem conta, quando o e-mail com o código não chega ou trava por código errado demais. Não cria conta |
| `npm run desempenho` | Mede o tempo de resposta das rotas de leitura (veja Desempenho) |

Os testes de serviço trocam o Prisma por um dublê e não enxergam o que o banco
cobra sozinho: os triggers da topologia da caixa, do animal e do pedido, os que
reescrevem o código das caixas quando o formato muda, e os CHECKs. A suíte de
integração roda contra um banco de verdade, já migrado, e só
quando `DATABASE_URL_TESTE` aponta para ele. Fica separada da unitária: os
arquivos `*.banco.test.ts` saem do `npm test` e entram no `npm run test:banco`
(`vitest.banco.config.ts`, um arquivo de cada vez):

- `src/shared/regras.banco.test.ts`: cada recusa dos triggers e dos CHECKs, em SQL puro;
- `src/modules/colonia/colonia.banco.test.ts`: os serviços da colônia de ponta a
  ponta (formar casal, nascer, selecionar, desmamar, mudar de caixa, baixa e
  anulação, encerrar, sem ninhada, virar estoque, correções), com a grade, a
  ficha e a visão geral lendo os mesmos animais;
- `src/modules/demanda/pedido.banco.test.ts`: os serviços do pedido (reservar,
  completar, desfazer, recusar, entregar);
- `src/modules/demanda/reserva-concorrente.banco.test.ts`: duas reservas ao mesmo
  tempo, cada uma na sua conexão (os animais travados são pulados, o pedido
  travado faz a segunda esperar);
- `src/modules/infra/formato.banco.test.ts`: a troca de formato da estante e a
  mudança de medidas do formato reescrevendo o código das caixas ativas, a recusa
  do banco à caixa que ficaria fora e os 409 dos serviços.

```bash
DATABASE_URL_TESTE="postgresql://...branch-de-teste..." npm run test:banco
```

Use um branch de teste da Neon ou um Postgres local, nunca a produção. Cada suíte
cria os próprios dados numa transação e desfaz tudo no fim; só as sequências de id
andam. Nas de serviço, o Prisma vira essa transação (`src/shared/testes/transacao.ts`,
fora do build), e duas consultas ao mesmo tempo dentro da transação de um serviço
(um `Promise.all`) falham o teste: a transação é uma conexão só. A da reserva
concorrente é a exceção: para as duas conexões verem os mesmos animais, ela grava
os próprios dados, com nomes próprios, e os apaga no começo e no fim. Sem a
variável, as suítes ficam de fora.

## Stack

Node 24 e TypeScript em ESM, Express 5, PostgreSQL na Neon, Prisma 7, Zod 4 na
entrada de cada rota, Vitest + supertest. Deploy na Render.

`prisma` e `@prisma/client` estão pregados na mesma versão exata, sem `^`. Suba os
dois juntos ou nenhum.

O `pg` fica na 8, a que o `@prisma/adapter-pg` 7 pede. O nosso código faz uma
consulta de cada vez dentro da transação (a suíte de banco barra o `Promise.all`),
mas o próprio Prisma ainda manda juntas, na mesma conexão, as consultas das relações
aninhadas de um `include` ou `select`. O pg 8 as enfileira e avisa ("Calling
client.query() when the client is already executing a query ... removed in
pg@9.0"); o pg 9 vai recusar. Não suba o `pg` para a 9 antes de o adapter do Prisma
enfileirar essas consultas.

## Estrutura

```
prisma/schema.prisma   o banco: models e migrations
src/
  app.ts               monta o Express (é o que o teste usa)
  server.ts            sobe a porta e encerra limpo no SIGTERM
  shared/              prisma, erros, tradução dos códigos do banco, autorização,
                       parâmetros biológicos, envio de e-mail
  modules/
    infra/             salas, formatos, estantes, grade, ficha e a mudanca de animais entre caixas
    reproducao/        casais e partos
    colonia/           os animais: escolha, baixa, anulacao, liberacao da caixa, a trilha e a visao geral
    demanda/           projetos CEUA e pedidos: aprovação, reserva, entrega e recusa
    motor/             busca de atendimento
    catalogo/          espécies e linhagens
    login/             sessão, primeiro acesso e senha esquecida
    usuarios/          contas e perfis (só o gestor)
    historico/         quem fez cada operação, quando e o que mudou
```

Validação é `parse` do Zod direto na rota: `ZodError` vira `400 VALIDACAO`.
Regra de negócio violada sai como 409 pelo `erroDeRegra` de `shared/erros.ts`, no
envelope `{ "erro": { "codigo", "mensagem" } }`. Os domínios do modelo por rato
guardam a palavra (`pedido.status`, `animal.situacao`, `ocorrencia.tipo`,
`caixa.tipo`). Onde o banco ainda guarda uma letra, como o perfil (`P`, `T`, `G`) e
a face da estante, ela não cruza a rede: a API responde a palavra
(`shared/traducao.ts`).

Mudança de schema passa pelo responsável pelo banco. `prisma migrate dev` pode
recriar o schema quando o histórico diverge, e o banco é o de produção.

## Login e primeiro acesso

| Rota | O que faz |
|---|---|
| `POST /api/sessao` | Login com `{ email, senha }`. Abre a sessão no cookie `nidus_sessao`, que dura 12 h |
| `GET /api/sessao` | Quem está logado |
| `DELETE /api/sessao` | Logout. A sessão some da memória |
| `POST /api/acesso/codigo` | `{ email }`: manda um código de 6 números para o e-mail, de qualquer domínio. Vale 15 minutos e responde `{ validadeEmMinutos }` |
| `POST /api/acesso/verificacao` | `{ email, codigo }`: confere o código sem gastar e responde `{ novo }`, `true` quando o e-mail ainda não tem conta |
| `POST /api/acesso/senha` | `{ email, codigo, senha, nome? }`: gasta o código, grava a senha e abre a sessão como o login. Sem conta, cria um pesquisador, e o `nome` passa a ser obrigatório |

O gestor não define a senha de ninguém: `POST /api/usuarios/:id/redefinicao-de-senha` manda à pessoa o mesmo código por e-mail, e a conta criada pelo gestor nasce sem senha e já recebe o código.

O ID-UFSC entra depois dos testes práticos. Até lá, quem não tem senha, ou
esqueceu, pede o código pela tela `/definir-senha` do front. O e-mail do código traz o
link `/definir-senha?email=...`, que abre a tela já no campo do código.

- O login compara o e-mail em minúsculas e sem espaço nas pontas, que é como o
  primeiro acesso grava. Quem tiver e-mail com maiúscula em `login.usuario` deixa
  de entrar.
- As rotas de `/api/acesso` ficam fora do login e nunca respondem 401: o front lê
  qualquer 401 como senha errada. Código errado, vencido, já usado ou de conta
  inativa dá `409 CODIGO_INVALIDO`, e cada código aceita 5 tentativas. Pedido de
  código demais dá `429 MUITAS_TENTATIVAS`: 1 por minuto e 5 por hora por e-mail,
  e no total 30 por hora e 130 por dia. O teto total cabe na cota de 300 e-mails
  por dia da Brevo contando o aviso de senha alterada, que cada pedido pode gerar
  além do código. Os números ficam em `LIMITES_DE_PEDIDO`, no `acesso.service.ts`.
- Cada e-mail aguenta 20 códigos errados em 24 h, somando todos os códigos dele
  (`TETO_DE_ERROS_POR_EMAIL`). Passado o teto, o pedido de código dá `429
  MUITAS_TENTATIVAS` sem enviar nem gravar código, e a verificação e a senha dão
  `409 CODIGO_INVALIDO`, mesmo com o código certo, até a janela andar. Vale igual
  com conta, sem conta e com conta inativa. Quem já tem conta e ficar travado
  recebe a senha pelo `db:senha`, que só define a senha de usuário existente: o
  primeiro acesso, de quem ainda não tem conta, espera a janela de 24 h.
- O pedido de código responde igual com conta, sem conta e com conta inativa, e
  as rotas de `/api/acesso` só dizem se a conta existe depois do código certo.
  Conta inativa nunca recebe código, nunca troca a senha e nunca abre sessão.
- O primeiro acesso só cria pesquisador. Quem já tem conta troca só a senha:
  perfil e nome ficam.
- Quando a senha de uma conta que já existia muda, todas as sessões abertas dela,
  em qualquer aparelho, deixam de valer, e só então abre a sessão nova. O login
  com a senha antiga que ainda estava em andamento na hora da troca também não
  fica com sessão: dá o 401 da senha errada ou, se a conferência terminar entre
  a gravação da senha nova e a revogação, um 200 com um cookie que já não vale.
  O `db:senha` roda fora da API e não derruba sessão nenhuma.
- Nessa mesma troca, a pessoa recebe por e-mail o aviso de que a senha foi
  alterada, com dia e hora e o que fazer se não foi ela. Conta nova não recebe
  aviso. A resposta não espera o envio, e a falha do aviso vai para o log sem
  desfazer a troca.
- O código fica em `login.codigo_acesso`, só como hash. Linha nenhuma se apaga:
  os limites contam por elas.

**E-mail.** O código de acesso e o aviso de senha alterada saem pela API HTTP de
envio transacional da Brevo, com o `fetch` do Node, em `src/shared/email.ts`. Em
production o envio precisa de duas variáveis, e o boot cai sem elas:

- `BREVO_API_KEY`: a chave de API, criada no painel da Brevo;
- `EMAIL_REMETENTE`: o endereço que aparece como remetente, validado na conta da
  Brevo.

Em development e test, nenhum e-mail sai: o código e o aviso aparecem no console
do servidor (`npm run dev`), e as duas variáveis podem ficar vazias. Nenhum teste
chama a Brevo.

O envio não segura a resposta. Se a Brevo recusar ou não responder em 10 s, o
erro vai para o log do servidor, sem o código e sem a chave, e a tela segue
dizendo que o código foi enviado. O envio não segue redirecionamento: um 3xx vira
erro, para a chave e o código não irem a outro endereço. O plano grátis da Brevo
manda 300 e-mails por dia.

Antes do merge no `main`, as duas variáveis entram no painel da Render. O
`render.yaml` as declara, mas num serviço que já existe a Render não pede o valor.
Sem elas, o build aplica a migration e o serviço novo não sobe: a Render mantém o
deploy anterior, e todo push seguinte falha.

**Contas de exemplo.** Os três usuários do `db:usuarios` têm e-mails de exemplo
(`gestor@ufsc.br`, `tecnico@ufsc.br` e `pesquisador@ufsc.br`), de caixas que a
equipe não controla. Com o envio ligado, quem tiver uma dessas caixas na UFSC
recebe o código, define a senha da conta e entra com o perfil dela, gestor
inclusive. O primeiro acesso só serve a conta com o e-mail real da pessoa, e
conta de exemplo recebe senha pelo `db:senha`.

Antes de ligar o envio, a saída segura é desativar as contas de exemplo que
estiverem no banco (`ativo = false`): a linha fica, e o `db:usuarios` a acha pelo
e-mail e a deixa como está. Trocar o e-mail delas pelo real não basta: o script
procura pelo e-mail, e rodar o `db:usuarios` de novo naquele banco recria a
conta de exemplo, ativa e com o e-mail genérico.

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
| Variáveis | `NODE_ENV=production`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `CORS_ORIGEM`, `BREVO_API_KEY`, `EMAIL_REMETENTE` |

- `--include=dev` é obrigatório: sem ele faltam os `@types/*` e o `tsc` para.
- O free tier dorme depois de uns 15 minutos parado e leva até um minuto para
  acordar. Abra o sistema antes de qualquer apresentação.
- A sessão vive em memória: quando a instância reinicia, todo mundo loga de novo.

## Desempenho

Limite combinado para as telas do dia a dia: p95 de até 1 s por chamada de leitura,
com 5 pessoas usando ao mesmo tempo, com a instância já acordada.

```bash
npm run desempenho
NIDUS_API=https://nidus-cpmr-api.onrender.com NIDUS_COOKIE=<valor do cookie nidus_sessao> npm run desempenho
```

O script só faz `GET` e não grava nada. Sem `NIDUS_COOKIE` ele mede apenas a `/saude`.
O cookie sai do navegador logado (DevTools, Application, Cookies, `nidus_sessao`).
Variáveis opcionais: `NIDUS_REPETICOES` (30), `NIDUS_SIMULTANEAS` (5),
`NIDUS_LIMITE_P95_MS` (1000) e `NIDUS_LINHAGEM` (3, a Wistar da carga inicial: a
linhagem da busca). Termina com código 1 se alguma rota passar do limite
ou der erro.

## Backup e restauração

O banco é o de produção, então qualquer erro de dado é erro do cliente.

1. **Restauração pela Neon.** O painel da Neon guarda o histórico do banco e restaura
   o branch para um momento anterior (Restore, no branch `main`). A janela depende do
   plano: confira no painel antes de precisar.
2. **Cópia manual** antes de cada migration e uma vez por semana, com o `pg_dump` do
   PostgreSQL instalado:

   ```bash
   pg_dump "$DATABASE_URL_UNPOOLED" -Fc -f nidus-AAAA-MM-DD.dump
   ```

   Guarde o arquivo fora do repositório (ele tem dados pessoais e hashes de senha).
3. **Restaurar uma cópia** sempre num branch novo da Neon, nunca por cima do `main`:

   ```bash
   pg_restore --no-owner --no-privileges -d "<url do branch novo>" nidus-AAAA-MM-DD.dump
   ```

   Confira os dados no branch novo e só então troque as variáveis da Render para ele.

## Equipe

| Integrante | Papel |
|---|---|
| Arthur Serafim Santin | Líder, Scrum Master e QA |
| João Carlos País | Banco de dados |
| Miguel Guerra | Back-end |
| Gabriel Ugione | Front-end e UX/UI |
