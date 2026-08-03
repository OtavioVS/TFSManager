# Changelog

Todas as mudanças relevantes deste projeto serão registradas neste arquivo.

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
