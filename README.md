# Servico de apontamento Azure DevOps para Claude CLI

Este workspace contem um CLI construido pelo Codex para apontar horas e mover cards no Azure DevOps/TFS. O Claude CLI fica fora deste projeto: ele interpreta a conversa com o usuario e chama este servico usando JSON ou flags estruturadas.

Documento principal:

- [docs/azure-devops-claude-time-service.md](docs/azure-devops-claude-time-service.md)

## MVP implementado

- Entrada estruturada por `--command-json` ou flags.
- Sem chamada direta para APIs de modelo dentro do servico.
- REST API para Azure DevOps Services ou TFS/Azure DevOps Server.
- `dry-run` como comportamento padrao.
- `--apply` para gravar de verdade.
- Validacao de horas por comando, limite diario, pessoa, estado/coluna e responsavel do card.
- Limite diario validado contra os apontamentos reais do Time Box antes de qualquer gravacao.
- Auditoria JSONL em `AUDIT_LOG_PATH`, com segredos mascarados.
- Integracao opcional com PLUGIN-TIMEBOX para criar apontamentos em `/api/v1/appointment`.

## Modo facil (interface interativa)

Para quem nao quer decorar comando, use a interface com menu:

- **Windows:** dois cliques em `apontar.cmd` (ou rode `apontar` no terminal).
- Tambem da: `powershell -ExecutionPolicy Bypass -File apontar.ps1`.

Na **primeira vez** ela faz o setup sozinha: pergunta a URL da organizacao, o projeto, seu **PAT** (token) e seu nome/e-mail do Azure DevOps. Depois e so usar o menu:

```text
  [1] Lancar a sprint      tudo que falta, e fecha os cards
  [2] Apontar um card      horas num card so
  [3] Ver meus cards
  [4] Visao mensal         horas por dia e limite de 8h
  [5] Criar tarefas        cards filhos de uma user story
  [6] Configuracao
  [7] Time Box Control
  [8] Ajuda
  [0] Sair
```

A opcao **[1]** e o caminho normal: Enter na pergunta da sprint (ele acha a atual sozinho),
escolhe `Closed`, confere a simulacao e confirma.

Na **[2]**, se voce tiver o `claude` CLI instalado da pra escrever *"4h de ontem e move pra
Active"*; sem ele — ou apertando Enter — o programa pergunta campo a campo. E o mesmo caminho,
sem escolher "modo". Trocar identidade so aparece no menu quando ha mais de uma cadastrada
em `config/identities.json`.

No **modo inteligente** voce passa o ID do card e escreve em portugues (ex.: *"2h de ontem, move pra Active"*); o **Haiku** interpreta para horas/data/coluna, o script simula e so grava depois do seu `s`. Esse modo precisa do **`claude` CLI** instalado e autenticado. O **modo formulario** funciona sem o `claude` CLI.

Sempre roda uma **simulacao** antes e so grava depois do seu `s`. O limite padrao e 8h por dia
(`MAX_HOURS_PER_DAY=8`). Com o Time Box ligado, o CLI consulta os `appointments` reais daquele
dia e falha fechado se a consulta estiver indisponivel; assim nao arrisca criar horas em
duplicidade. Pre-requisito: ter o **Node 20+** instalado (https://nodejs.org).

Para repassar a um colega: copie a pasta **sem `.env`, sem `logs/` e sem `config/identities.json`**
(os tres tem dados pessoais e ja estao no `.gitignore`), peca pra ele instalar o Node, gerar o
PAT dele e rodar `apontar.cmd`. No primeiro uso ele informa a URL da organizacao, **o projeto**,
o PAT e o nome/e-mail dele — e so. Para ligar o Time Box, use o menu `[6] -> [1] Colar token`.

Nada no codigo assume uma pessoa, projeto ou area especifica:

- A **identidade** sai de `config/identities.json` (nome/e-mail do proprio usuario).
- O **projeto** vem do `.env` (o que o colega digitou no setup).
- A **area/serie de sprints** e descoberta a partir dos cards do proprio usuario — funciona
  igual para um time de semanas pares e outro de impares.
- A **identidade do Time Box** (id, organizacao) e descoberta do Azure DevOps com o PAT do
  proprio colega; a URL do backend e a unica constante, pois e a mesma para toda a organizacao.

Ou seja: cada colega roda com a conta dele, aponta em nome dele. Nada da sua conta vai junto.

## Configuracao manual

1. Copie `.env.example` para `.env`.
2. Ajuste `AZDO_PROJECT`, `AZDO_PAT`, `AUDIT_LOG_PATH` e a URL do ambiente.
3. Para Azure DevOps Services, use `AZDO_ORG_URL=https://dev.azure.com/ORG`.
4. Para TFS/Azure DevOps Server, use `AZDO_COLLECTION_URL=https://servidor/tfs/Collection`.
5. Copie `config/identities.example.json` para `config/identities.json` e ajuste seu nome/email.

## Integracao com Time Box Control

Com a integracao ligada, cada hora lancada aqui **tambem** vira um apontamento no Time Box
Control (a extensao que roda dentro do Azure DevOps). E o unico jeito de ter lancamento **por
dia** de verdade: no TFS o `CompletedWork` e um acumulado do card, no Time Box cada dia e um
`appointment` proprio (`workedAt` + `workedMinutes`).

**Ligar:** menu `[6] Time Box Control` -> `[1] Colar token`, ou
`--timebox-token "eyJ..."`. Abra o Time Box no Azure DevOps, use F12 -> Network, selecione uma
chamada para `amstl.agendaaqui.com.br` e copie o header `Authorization` (`Bearer eyJ...`).
A identidade contida nesse token e a usada nos apontamentos.

O menu ainda oferece um modo automatico legado (`--timebox-setup`) para ambientes antigos.
O backend hospedado atual valida o token e rejeita JWT gerado localmente, portanto o caminho
suportado e colar o token emitido pela propria extensao.

Em ambos os casos, no `--apply` o fluxo passa a ser:

1. Consulta o dia em `GET /api/v1/appointment/search`.
2. Bloqueia se as horas existentes mais o novo lancamento passarem de 8h.
3. Atualiza horas/estado no Azure DevOps/TFS.
4. Confere novamente o saldo do dia, imediatamente antes do POST.
5. Sincroniza o work item via `PUT /api/v1/work-item`.
6. Cria o apontamento do dia via `POST /api/v1/appointment`.

Se o Time Box estiver ligado mas nao puder ser consultado, nada e gravado. Essa regra evita o
caso em que ja havia 8h no Time Box e o preenchimento da sprint criava mais 8h no mesmo dia.

**Sobre a validade:** os tokens expiram. `--timebox-status` faz uma consulta autenticada de
verdade e mostra a validade restante; nao considera mais um simples HTTP 404 como conexao
funcionando. Se o JWT expirar mas o app token aninhado ainda estiver valido, o cliente tenta
renovar a sessao em `PUT /api/v1/user`. Quando ambos expirarem, o CLI bloqueia **antes** de
alterar o Azure DevOps e pede um token novo, evitando que as duas fontes fiquem desalinhadas.

Opcionalmente configure `AZDO_DEMAND_NUMBER_FIELD` com o campo customizado de demanda — o CLI
ja o preenche no payload (`demandNumber`) quando presente.

## Visao mensal (`--month`)

O menu `[4] Visao mensal` consulta o Time Box e mostra todos os dias uteis do mes, total
apontado, quantidade de lancamentos, quanto falta para 8h e qualquer excesso. Pela linha de
comando:

```powershell
npm start -- --month 2026-07
```

Um dia acima do limite aparece como `EXCEDE`, mas nao e alterado automaticamente. Excluir ou
redistribuir apontamentos antigos e uma operacao destrutiva e deve ser feita conscientemente no
Time Box. A nova validacao impede que novos excessos sejam criados.

## Preencher a sprint inteira (`--fill-sprint`)

As sprints do TFS seguem o padrao `AAAA Wnn` e cobrem **duas semanas**: `2026 W24` vai de
08/06 a 19/06 (semanas 24 e 25). Este projeto nomeia so as semanas pares; outros projetos
usam so as impares. Por isso a janela **nunca** e calculada a partir do numero da semana:
ela e lida de `startDate`/`finishDate` da propria iteracao no TFS.

O modo `--fill-sprint` distribui horas pelos dias uteis da sprint. **Sem `--id`** ele pega
seus cards **New e Active** (Resolved e Closed ficam de fora) e usa o `RemainingWork` de cada
um como as horas — completando e fechando cada card. Quando esse campo nao foi preenchido, o
programa calcula a capacidade ainda livre da sprint e a divide pelo total de cards
selecionados. Exemplo: 80h livres e 4 cards resultam em 20h por card. Um `RemainingWork` igual
a zero continua sendo respeitado como zero. Para incluir outros status, passe `--status`
(ex.: `--status New,Active,Resolved`).
**Sem `--sprint`** ele detecta a sprint corrente, e **sem `--person`** usa a unica identidade
cadastrada — entao o comando completo cabe numa linha:

```powershell
npm start -- --fill-sprint --state Closed
```

A sprint corrente e descoberta pela **area dos seus proprios cards**, nao por regra de semana
par/impar: o mesmo nome de sprint (`2026 W24`) existe em varias areas do TFS com **janelas
diferentes**, e mais de uma pode cobrir a data de hoje. Ancorando na sua area sobra exatamente
uma. Para escolher outra sprint, passe o nome:

```powershell
npm start -- --fill-sprint --sprint "2026 W24" --state Closed
```

Saida (simulacao):

```text
Sprint 2026 W24: 2026-06-08 a 2026-06-19 (10 dias uteis, limite 8h/dia)

Card #1067496 | New | feito 0h / resta 20h
  2026-06-08  seg  +8h
  2026-06-09  ter  +8h
  2026-06-10  qua  +4h
  -> 20h | ao final: Closed, restante 0

Card #1067519 | New | feito 0h / resta 20h
  2026-06-10  qua  +4h (dia ja tinha 4h)
  2026-06-11  qui  +8h
  2026-06-12  sex  +8h
  -> 20h | ao final: Closed, restante 0

Total a lancar: 40h em 2 card(s).
```

Repare que os cards **compartilham o saldo do dia**: o primeiro consome 4h do dia 10 e o
segundo pega as 4h restantes, sem passar de 8h. Para escolher cards especificos use
`--id 1067496,1067519`; para limitar o total use `--hours 24` (vira um teto).

Regras aplicadas:

- Enche cada dia ate `MAX_HOURS_PER_DAY` (8h), do primeiro dia util em diante.
- **Desconta o que ja foi lancado naquele dia** e pula dias sem folga. Com a integracao ligada,
  consulta o Time Box; audit local e historico do TFS continuam como protecao conservadora.
- Em card sem `RemainingWork`, usa `horas livres da sprint / total de cards`; a simulacao
  identifica claramente quando essa estimativa automatica foi aplicada.
- Sabado e domingo ficam de fora.
- Se as horas nao couberem na sprint, aborta sem gravar nada e diz quanto sobrou.
- **Avisa quando o plano cai em dias futuros** (ver abaixo).
- Com `--state`/`--column`, **so o ultimo lancamento de cada card** muda o estado e zera o `RemainingWork`.
- Varios cards compartilham o saldo diario, na ordem em que aparecem.
- `--sprint "2026 W26"` força outra janela em vez da sprint do card.

Como sempre, roda em simulacao por padrao; use `--apply` para gravar. No `--apply` cada dia e
um PATCH separado no card e uma entrada no audit log; se um dia falhar, os anteriores ja foram
gravados e o processo para ali.

Limitacao: no TFS, `CompletedWork` e um acumulado do card, nao um lancamento por dia — a data
de cada parcela aparece no historico (`System.History`) e no audit log. Lancamento por dia de
verdade so existe via Time Box. Por isso, quando a integracao esta ligada, a contabilidade
"quanto ja tem neste dia" consulta primeiro os `appointments` do Time Box. O maior valor
conhecido entre Time Box, audit local e historico confiavel do TFS e usado para nunca liberar
mais de 8h.

## Aviso de horas futuras

Rodar `--fill-sprint` na **sprint corrente** quase sempre cai em dias que ainda nao
aconteceram: no meio da sprint, os dias restantes sao futuro. Fechar o card nessas
condicoes significa apontar trabalho que ainda nao foi feito.

Por isso todo lancamento com data posterior a hoje sai marcado:

```text
  2026-07-20  seg  +8h
  2026-07-21  ter  +8h  << FUTURO
  ...
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
ATENCAO: 68h em 9 dia(s) que ainda nao aconteceram
(hoje e 2026-07-20; o ultimo dia com trabalho feito e 2026-07-20).
Isso fecharia o card como "Closed" contando trabalho que ainda nao foi feito.
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
```

O aviso vale para **todos** os modos, nao so o `--fill-sprint`: um `--date` futuro num
apontamento avulso tambem avisa, porque a regra vive na camada de politica.

Quem preferir barrar de vez:

```text
ALLOW_FUTURE_HOURS=false
```

Aí a data futura vira erro e nada e gravado. O padrao e `true` (so avisa), porque lancar
alguns dias adiantado e legitimo em fim de sprint — o que nao pode e passar batido.

## Uso direto

Planejar sem gravar:

```powershell
npm start -- --dry-run --work-item-id 12345 --person Max --hours 2 --state Active
```

Aplicar no Azure DevOps/TFS:

```powershell
npm start -- --apply --work-item-id 12345 --person Max --hours 2 --state Active
```

## Criar tarefas filhas de uma user story

O comando `--create-tasks` lê o título, a descrição, o responsável, a área e a iteração da
user story e monta tarefas filhas para as fases de execução. A simulação é o padrão; use
`--apply` para criar os cards no Azure DevOps/TFS:

```powershell
npm start -- --create-tasks --user-story-id 12345
npm start -- --create-tasks --apply --user-story-id 12345 --phases develop,homologation
```

As fases disponíveis são `develop`, `homologation` e `deployment` (também aceitam os
aliases `desenvolvimento`, `homologação` e `implantação`). Se `--phases` não for informado,
as três fases são criadas. Cada tarefa recebe a descrição da user story, o objetivo da fase,
um escopo específico, critérios de conclusão e o vínculo hierárquico com a user story. A
descrição completa não é clonada para cada tarefa: a aplicação destrincha a história em
blocos como ciclo de vida, fila, validação, interface e resiliência. O tipo filho padrão é `Task`;
para outro tipo, use `--task-type`, e `--task-person`/`--assign-to` substitui o responsável
herdado da user story. O campo obrigatório `Activity` também é preenchido automaticamente:
`Development`, `Homologation` ou `Deployment`, conforme a fase. Este fluxo cria somente
work items do tipo `Task`.

Usar JSON estruturado, ideal para o Claude CLI:

```powershell
npm start -- --command-json '{ "workItemId": 12345, "personName": "Max", "completedWorkDelta": 2, "remainingWorkDelta": -2, "targetState": "Active", "targetBoardColumn": null, "comment": null, "confidence": 1, "needsConfirmation": false, "missingFields": [] }'
```

Rodar testes:

```powershell
npm test
```

## Operacao com Claude CLI

Instrucao operacional recomendada para o Claude CLI:

```text
Quando o usuario pedir para apontar horas ou mover card, extraia card, pessoa, horas, estado/coluna e comentario. Primeiro rode o servico em dry-run. So use --apply depois de confirmacao explicita do usuario.
```
