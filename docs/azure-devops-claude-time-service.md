# Servico de apontamento de horas e movimentacao de cards

## Objetivo

Criar um CLI local para receber comandos estruturados do Claude CLI, registrar horas em um work item do Azure DevOps/TFS e mover o card para estado ou coluna configurada.

Exemplo de comando que o Claude CLI deve executar depois de interpretar a conversa:

```powershell
npm start -- --dry-run --work-item-id 12345 --person Max --hours 2 --state Active
```

## Papeis

- Codex: construir e manter este servico, validacoes, testes e documentacao.
- Claude CLI: operar a conversa com o usuario e chamar este CLI com JSON ou flags estruturadas.
- Este servico: validar politica, consultar o Azure DevOps/TFS, planejar/aplicar alteracoes e registrar auditoria.
- Azure DevOps/TFS: sistema oficial dos cards, horas, estados e historico.

Este projeto nao chama APIs de modelo. Nao existe chave de modelo, modelo configurado nem parser LLM interno. A interpretacao em linguagem natural fica no Claude CLI.

## Fontes oficiais usadas

- Azure DevOps CLI: https://learn.microsoft.com/en-us/azure/devops/cli/?view=azure-devops
- `az boards work-item`: https://learn.microsoft.com/en-us/cli/azure/boards/work-item?view=azure-cli-latest
- Azure DevOps REST API, update work item: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-rest-7.1
- Campos numericos de trabalho: https://learn.microsoft.com/en-us/azure/devops/boards/queries/query-numeric?view=azure-devops

## Compatibilidade TFS/Azure DevOps

Antes de operar, confirmar qual ambiente sera usado:

- Azure DevOps Services, nuvem em `https://dev.azure.com/...`: usar `AZDO_ORG_URL`.
- Azure DevOps Server/TFS on-premises: usar `AZDO_COLLECTION_URL`, por exemplo `https://servidor/tfs/{collection}`.
- `tf.exe` ajuda em operacoes de TFVC/codigo, mas nao e a base ideal para atualizar Boards/work items neste servico.

Configuracao que precisa ser descoberta no ambiente real:

- URL da organizacao ou collection.
- Nome do projeto.
- Tipo de processo: Scrum, Agile, CMMI ou processo customizado.
- Campos disponiveis no tipo de card que sera apontado.
- Estados e colunas validas do board do time.

## Arquitetura

```text
Usuario
  |
  v
Claude CLI
  interpreta a conversa e monta comando estruturado
  |
  v
azdo-time-service CLI
  valida, consulta, planeja, aplica e audita
  |
  v
Azure DevOps/TFS REST API
```

Componentes implementados:

- `src/cli.js`: entrada principal, flags, `dry-run`, `--apply` e auditoria.
- `src/work-items/command.js`: normalizacao do comando estruturado.
- `src/work-items/policy.js`: validacoes de negocio e identidade.
- `src/work-items/service.js`: planejamento e patch JSON do work item.
- `src/azure-devops/client.js`: cliente REST Azure DevOps/TFS.
- `src/audit/jsonlAuditLog.js`: auditoria JSONL com segredos mascarados.
- `src/config/env.js`: leitura de `.env`, identidades e configuracao.

## Contrato para o Claude CLI

O Claude CLI pode chamar o servico de duas formas.

Forma recomendada com flags:

```powershell
npm start -- --dry-run --work-item-id 12345 --person Max --hours 2 --state Active --comment "Apontamento automatizado: +2h para Max."
```

Forma alternativa com JSON:

```json
{
  "workItemId": 12345,
  "personName": "Max",
  "completedWorkDelta": 2,
  "remainingWorkDelta": -2,
  "targetState": "Active",
  "targetBoardColumn": null,
  "comment": "Apontamento automatizado: +2h para Max.",
  "confidence": 1,
  "needsConfirmation": false,
  "missingFields": []
}
```

Regras para o Claude CLI:

- Primeiro executar `--dry-run`.
- Usar `--apply` somente depois de confirmacao explicita do usuario.
- Nao inventar card, pessoa, horas, estado ou coluna.
- Se faltar dado, pedir ao usuario em vez de chamar `--apply`.
- Para `30m`, usar `--hours 0.5`; para `1h30`, usar `--hours 1.5`.
- Se o usuario nao disser `remainingWorkDelta`, pode omitir `--remaining-delta`; o servico reduz `Remaining Work` pelo valor de `--hours` quando o campo existir.

## Campos do Azure DevOps

Campos principais:

- `System.Id`: ID do work item.
- `System.AssignedTo`: responsavel pelo card.
- `System.State`: estado de workflow.
- `System.BoardColumn`: coluna do board, quando disponivel.
- `System.BoardColumnDone`: marcador de done dentro da coluna.
- `Microsoft.VSTS.Scheduling.CompletedWork`: trabalho concluido.
- `Microsoft.VSTS.Scheduling.RemainingWork`: trabalho restante.
- `System.History`: comentario/historico.

Observacoes:

- `Completed Work` e usado como quantidade de trabalho gasto; normalmente horas, mas o Azure DevOps nao impoe unidade.
- Em processo Scrum, pode haver somente `Remaining Work` por padrao. `Completed Work` depende do processo/campos do projeto.
- Coluna Kanban depende da configuracao do board/time. Se `System.BoardColumn` falhar, usar `System.State` e registrar o motivo.

## Configuracao

Variaveis em `.env`:

```text
AZDO_ORG_URL=https://dev.azure.com/ORG
AZDO_COLLECTION_URL=
AZDO_PROJECT=PROJETO
AZDO_PAT=
AZDO_API_VERSION=7.1
AZDO_ALLOWED_STATES=New,Active,Resolved,Closed
AZDO_ALLOWED_BOARD_COLUMNS=New,Doing,Code Review,Done
AZDO_IDENTITIES_PATH=config/identities.json
AZDO_REQUIRE_ASSIGNED_TO_MATCH=true
MAX_HOURS_PER_COMMAND=8
MAX_HOURS_PER_DAY=8
REQUIRE_CONFIRMATION=false
AUDIT_LOG_PATH=logs/audit.jsonl
```

Identidades em `config/identities.json`:

```json
{
  "Max": {
    "displayName": "Max",
    "azureDevOpsEmail": "max@empresa.com",
    "aliases": ["max", "eu", "meu nome", "pra mim"]
  }
}
```

## Operacao segura

Fluxo recomendado:

1. Usuario pede ao Claude CLI: `lanca 2h no card 12345 e move para Active`.
2. Claude CLI chama este servico com `--dry-run`.
3. Servico consulta o card e mostra plano antes/depois.
4. Usuario confirma.
5. Claude CLI chama o mesmo comando com `--apply`.
6. Servico aplica patch com `op: test` em `/rev` para evitar sobrescrever alteracao concorrente.
7. Servico grava auditoria JSONL.

Regras obrigatorias:

- Nao versionar `.env`, PAT ou logs com dados sensiveis.
- Manter PAT com permissao minima: Work Items Read & Write.
- Confirmar operacoes ambiguas.
- Limitar horas por comando e o total diario por pessoa/data. Com Time Box ligado,
  consultar os appointments reais e falhar fechado se a API nao responder.
- Usar allowlist para estados e colunas.
- Evitar `bypassRules=true`.

## Atualizacao via REST API

Endpoint usado:

```http
PATCH https://dev.azure.com/{organization}/{project}/_apis/wit/workitems/{id}?api-version=7.1
Content-Type: application/json-patch+json
```

Payload planejado pelo servico:

```json
[
  { "op": "test", "path": "/rev", "value": 12 },
  { "op": "add", "path": "/fields/Microsoft.VSTS.Scheduling.CompletedWork", "value": 5 },
  { "op": "add", "path": "/fields/Microsoft.VSTS.Scheduling.RemainingWork", "value": 3 },
  { "op": "add", "path": "/fields/System.State", "value": "Active" },
  { "op": "add", "path": "/fields/System.History", "value": "Apontamento automatizado: +2h para Max." }
]
```

## Erros esperados

| Caso | Resposta |
| --- | --- |
| Card inexistente | Informar que o ID nao foi encontrado. |
| Campo `Completed Work` ausente | Informar que o processo nao tem esse campo e sugerir usar `Remaining Work` ou campo customizado. |
| Status invalido | Listar estados permitidos configurados. |
| Coluna invalida | Listar colunas permitidas configuradas. |
| Card de outro responsavel | Pedir confirmacao ou bloquear, conforme politica. |
| Revisao mudou | Recarregar o card e pedir nova confirmacao se os campos afetados mudaram. |

## Comandos

```powershell
npm test
npm start -- --help
npm start -- --dry-run --work-item-id 12345 --person Max --hours 2 --state Active
npm start -- --apply --work-item-id 12345 --person Max --hours 2 --state Active
```

## Estrutura atual

```text
src/
  audit/
  azure-devops/
  config/
  work-items/
tests/
  audit.test.js
  azureDevOpsClient.test.js
  command.test.js
  policy.test.js
  service.test.js
```

## Evolucoes recomendadas

- Criar endpoint HTTP se o Claude CLI precisar operar via servidor em vez de processo local.
- Descobrir estados/colunas direto do board em vez de usar apenas allowlist no `.env`.
- Evoluir auditoria para SQLite ou banco corporativo se precisar de busca/relatorios.
- Adicionar testes de contrato contra mocks mais completos da API Azure DevOps.
## Integracao PLUGIN-TIMEBOX

Quando `TIMEBOX_ENABLED=true`, o servico cria tambem o apontamento no backend do PLUGIN-TIMEBOX:

1. Consulta o dia em `GET /api/v1/appointment/search`.
2. Bloqueia se o total existente mais o novo lancamento passar de 8h.
3. Monta o plano Timebox no dry-run com `workItem` e `appointment`.
4. No apply, atualiza primeiro o Azure DevOps/TFS.
5. Confere novamente o limite imediatamente antes do POST.
6. Depois sincroniza o work item em `PUT /api/v1/work-item`.
7. Por fim cria o apontamento em `POST /api/v1/appointment`.

O preenchimento de sprint usa a mesma consulta para reservar apenas o saldo livre de cada dia.
Quando um card nao possui `RemainingWork`, esse saldo livre e dividido pelo total de cards da
sprint selecionada e usado como estimativa automatica; valores de `RemainingWork` existentes,
inclusive zero, continuam prevalecendo.
`--month AAAA-MM` fornece a visao mensal do usuario e destaca dias incompletos ou acima do limite.
Para um board Kanban mensal, `--fill-month --month AAAA-MM` usa todos os dias uteis do mes e
seleciona, por padrao, a iteracao mensal `AAAA Mmm` (por exemplo, `2026 M08`). `--sprint`
sobrescreve o nome da iteracao quando necessario. O saldo diario considera tambem horas do Time
Box registradas em outras sprints no mesmo periodo.

Payload do apontamento:

```json
{
  "workItemId": 12345,
  "userId": "guid-do-usuario",
  "workedWeek": "2026-26",
  "workedAt": "2026-06-25",
  "workedMinutes": 120,
  "comment": "comentario"
}
```

Variaveis relevantes:

```text
TIMEBOX_ENABLED=true
TIMEBOX_API_URL=http://localhost:5256/api
TIMEBOX_USER_ID=<guid-do-usuario-timebox>
TIMEBOX_AUTH_TOKEN=<jwt-timebox-opcional>
TIMEBOX_ORGANIZATION_ID=<guid-da-organizacao>
TIMEBOX_USER_NAME=<email/login-azure-devops>
TIMEBOX_USER_DISPLAY_NAME=<nome-exibicao>
TIMEBOX_APP_TOKEN=<app-token-do-plugin>
AZDO_DEMAND_NUMBER_FIELD=Custom.bef8a8bc-fe87-48b5-b28e-50656841f0eb
```

Se `TIMEBOX_AUTH_TOKEN` estiver vazio, o servico chama `PUT /api/v1/user` para sincronizar o
usuario e obter o JWT usado nas chamadas protegidas. O backend hospedado atual rejeita tokens
expirados e tokens locais sem assinatura valida. O CLI detecta a expiracao antes de alterar o
Azure; se o app token aninhado ainda estiver valido, tenta renovar, caso contrario pede que o
usuario cole um token novo da extensao. Falhas que ocorrerem depois da atualizacao do Azure
continuam retornando `stage: "applied-with-timebox-error"` para deixar a falha parcial auditada.
