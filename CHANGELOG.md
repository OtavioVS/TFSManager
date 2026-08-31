# Changelog

Todas as mudanças relevantes deste projeto serão registradas neste arquivo.

## [0.2.2] - 2026-08-03

### Corrigido

- Usa o histórico atual do Azure DevOps como fonte da verdade para a validação diária.
- Usa o audit local somente quando não é possível consultar o Azure DevOps.
- Evita que horas antigas do audit local bloqueiem ou preencham novamente cards já corrigidos no Azure.
- Corrige o preenchimento mensal para considerar horas do Time Box lançadas em outras sprints.
- Evita valores `NaNh` quando o histórico do Azure DevOps é usado no planejamento.

### Adicionado

- Opção `--fill-month` e opção correspondente no menu interativo para boards Kanban mensais.
- Interface interativa redesenhada: banner com identidade/data/status do Time Box, menu agrupado
  em seções, validação com re-pergunta, tecla `v` para voltar em qualquer prompt e confirmações
  padronizadas.

## [0.2.1] - 2026-08-03

### Corrigido

- Reserva as estimativas `RemainingWork` antes de distribuir horas automaticamente entre cards sem estimativa.
- Evita ultrapassar a capacidade da sprint por mistura de estimativas explícitas e automáticas.
- Arredonda corretamente as horas exibidas em mensagens de capacidade excedida.

## [0.2.0] - 2026-08-03

### Adicionado

- Criação de tasks filhas a partir de user stories do Azure DevOps/TFS.
- Decomposição da user story em tasks individuais de desenvolvimento, homologação e implantação.
- Geração de escopo, objetivo e critérios de conclusão específicos para cada task.
- Preenchimento automático do campo `Activity` com `Development`, `Homologation` ou `Deployment`.
- Menu interativo para criar tasks a partir de uma user story.
- Auditoria e testes para o fluxo de criação e decomposição de tasks.

### Corrigido

- Rejeição de tipos de work item diferentes de `Task` no fluxo de criação.
- Reconciliação das horas do log local com os cards atuais da sprint.
- Desconsideração de horas de cards removidos ou zerados no Azure DevOps.
- Aplicação de reduções de `CompletedWork` no histórico do TFS, evitando contar horas apagadas.
- Homologação e implantação agora geram uma task por tópico, sem agrupar todas as atividades em uma única descrição.
