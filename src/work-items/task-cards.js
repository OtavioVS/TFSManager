const STORY_TITLE = "System.Title";
const STORY_DESCRIPTION = "System.Description";
const WORK_ITEM_TYPE = "System.WorkItemType";
const ASSIGNED_TO = "System.AssignedTo";
const ACTIVITY = "Microsoft.VSTS.Common.Activity";
const TASK_WORK_ITEM_TYPE = "Task";
const AREA_PATH = "System.AreaPath";
const ITERATION_PATH = "System.IterationPath";
const STORY_TYPES = new Set([
  "user story",
  "product backlog item",
  "backlog item",
  "requirement",
  "historia de usuario",
  "item de backlog do produto",
  "requisito"
]);

const PHASES = {
  develop: {
    key: "develop",
    label: "Desenvolvimento",
    activity: "Development",
    aliases: ["develop", "development", "desenvolvimento", "dev"],
    objective: "Implementar a solução descrita na user story e deixá-la pronta para validação.",
    activities: [
      "Detalhar a solução técnica e os critérios de aceite.",
      "Implementar o código e as configurações necessárias.",
      "Executar testes automatizados e corrigir as falhas encontradas."
    ]
  },
  homologation: {
    key: "homologation",
    label: "Homologação",
    activity: "Homologation",
    aliases: ["homologation", "homologacao", "homolog", "qa", "validation"],
    objective: "Validar a entrega em ambiente de homologação com base nos critérios de aceite.",
    activities: [
      "Preparar os dados e o ambiente necessários para o teste.",
      "Executar os cenários de aceite da user story.",
      "Registrar evidências e corrigir ou encaminhar inconsistências."
    ]
  },
  deployment: {
    key: "deployment",
    label: "Implantação",
    activity: "Deployment",
    aliases: ["deployment", "deploy", "implantacao", "implantação", "release"],
    objective: "Publicar a solução em produção com segurança e confirmar seu funcionamento.",
    activities: [
      "Confirmar pré-requisitos, dependências e plano de implantação.",
      "Publicar a alteração e acompanhar a execução.",
      "Executar a validação pós-implantação e registrar o resultado."
    ]
  }
};

export const DEFAULT_TASK_PHASES = ["develop", "homologation", "deployment"];

export function normalizeTaskPhases(value) {
  const values = value === undefined || value === null || value === "" ? DEFAULT_TASK_PHASES : value;
  const list = Array.isArray(values) ? values : String(values).split(",");
  const phases = [];

  for (const item of list) {
    const normalized = normalizeText(item);
    if (!normalized) {
      continue;
    }

    const phase = Object.values(PHASES).find(
      (candidate) => candidate.key === normalized || candidate.aliases.includes(normalized)
    );
    if (!phase) {
      throw new Error(
        `Fase invalida: ${item}. Use develop, homologation ou deployment.`
      );
    }
    if (!phases.includes(phase.key)) {
      phases.push(phase.key);
    }
  }

  if (phases.length === 0) {
    throw new Error("Informe pelo menos uma fase para criar as tarefas.");
  }

  return phases;
}

export function buildTaskCards(userStory, phases, options = {}) {
  const normalizedPhases = normalizeTaskPhases(phases);
  const fields = userStory.fields || {};
  const storyTitle = String(fields[STORY_TITLE] || "").trim();
  if (!storyTitle) {
    throw new Error(`User story ${userStory.id || "(sem id)"} sem título.`);
  }

  const storyDescription = cleanDescription(fields[STORY_DESCRIPTION]);
  const inheritedFields = inheritedFieldOperations(fields);
  const assignedTo = options.assignedTo || assignedToValue(fields[ASSIGNED_TO]);
  const workItemType = normalizeTaskWorkItemType(options.workItemType);
  const taskSpecifications = decomposeUserStory({
    storyTitle,
    storyDescription
  });
  const tasks = [];

  if (normalizedPhases.includes("develop")) {
    for (const specification of taskSpecifications) {
      tasks.push(
        createTaskCard({
          userStory,
          storyTitle,
          storyDescription,
          storyId: userStory.id,
          phase: PHASES.develop,
          specification,
          workItemType,
          inheritedFields,
          assignedTo,
          parentUrl: options.parentUrl
        })
      );
    }
  }

  if (normalizedPhases.includes("homologation")) {
    for (const specification of buildHomologationSpecifications(storyDescription)) {
      tasks.push(createTaskCard({
        userStory,
        storyTitle,
        storyDescription,
        storyId: userStory.id,
        phase: PHASES.homologation,
        specification,
        workItemType,
        inheritedFields,
        assignedTo,
        parentUrl: options.parentUrl
      }));
    }
  }

  if (normalizedPhases.includes("deployment")) {
    for (const specification of buildDeploymentSpecifications(storyDescription)) {
      tasks.push(createTaskCard({
        userStory,
        storyTitle,
        storyDescription,
        storyId: userStory.id,
        phase: PHASES.deployment,
        specification,
        workItemType,
        inheritedFields,
        assignedTo,
        parentUrl: options.parentUrl
      }));
    }
  }

  return tasks;
}

export class TaskCardService {
  constructor({ azureDevOpsClient }) {
    this.azureDevOpsClient = azureDevOpsClient;
  }

  async plan({ userStoryId, phases, workItemType = TASK_WORK_ITEM_TYPE, assignedTo = null }) {
    const normalizedId = normalizeId(userStoryId);
    if (!normalizedId) {
      return {
        ok: false,
        stage: "task-card-validation",
        errors: ["userStoryId ausente ou invalido."]
      };
    }
    const normalizedWorkItemType = normalizeTaskWorkItemType(workItemType);

    const userStory = await this.azureDevOpsClient.getWorkItem(normalizedId, [
      STORY_TITLE,
      STORY_DESCRIPTION,
      WORK_ITEM_TYPE,
      ASSIGNED_TO,
      AREA_PATH,
      ITERATION_PATH
    ]);
    const storyType = normalizeText(userStory.fields?.[WORK_ITEM_TYPE]);
    if (storyType && !STORY_TYPES.has(storyType)) {
      return {
        ok: false,
        stage: "task-card-validation",
        errors: [
          `O work item ${normalizedId} e do tipo ${userStory.fields[WORK_ITEM_TYPE]}, nao de user story.`
        ],
        userStory: summarizeUserStory(userStory)
      };
    }
    const selectedPhases = normalizeTaskPhases(phases);
    const tasks = buildTaskCards(userStory, phases, {
      workItemType: normalizedWorkItemType,
      assignedTo,
      parentUrl:
        userStory.url ||
        String(this.azureDevOpsClient.buildWorkItemUrl(normalizedId))
    });

    return {
      ok: true,
      stage: "planned",
      userStory: summarizeUserStory(userStory),
      phases: selectedPhases,
      tasks
    };
  }

  async apply(input) {
    const plan = await this.plan(input);
    if (!plan.ok) {
      return plan;
    }

    const created = [];
    for (const task of plan.tasks) {
      let workItem;
      try {
        workItem = await this.azureDevOpsClient.createWorkItem(task.workItemType, task.operations);
      } catch (error) {
        return {
          ...plan,
          ok: false,
          stage: "partial-apply-failure",
          created,
          error: `Falha ao criar a fase ${task.phaseLabel}: ${error.message}`
        };
      }
      created.push({
        phase: task.phase,
        phaseLabel: task.phaseLabel,
        activity: task.activity,
        id: workItem.id,
        title: task.title,
        url: workItem.url || null
      });
    }

    return {
      ...plan,
      stage: "applied",
      created
    };
  }
}

export function buildTaskDescription({ storyTitle, storyDescription, storyId, phase, specification }) {
  const task = specification || {
    title: `Executar ${phase.label.toLowerCase()}: ${storyTitle}`,
    objective: phase.objective,
    activities: phase.activities,
    completionCriteria: ["Implementar, validar e registrar o resultado da atividade."]
  };
  const evidence = task.evidence ? [`Trecho relacionado: ${task.evidence}`, ""] : [];

  return [
    `Fase de execução: ${phase.label}`,
    "",
    `Objetivo: ${task.objective}`,
    "",
    "Escopo:",
    ...task.activities.map((activity) => `- ${activity}`),
    "",
    "Critérios de conclusão:",
    ...task.completionCriteria.map((criterion) => `- ${criterion}`),
    "",
    ...evidence,
    `Contexto: user story #${storyId || "?"} - ${storyTitle}`
  ].join("\n");
}

function createTaskCard({
  userStory,
  storyTitle,
  storyDescription,
  storyId,
  phase,
  specification,
  workItemType,
  inheritedFields,
  assignedTo,
  parentUrl
}) {
  const title = `[${phase.label}] ${specification.title}`;
  const description = buildTaskDescription({
    storyTitle,
    storyDescription,
    storyId,
    phase,
    specification
  });
  const operations = [
    { op: "add", path: `/fields/${STORY_TITLE}`, value: title },
    { op: "add", path: `/fields/${ACTIVITY}`, value: phase.activity },
    { op: "add", path: `/fields/${STORY_DESCRIPTION}`, value: description },
    ...inheritedFields
  ];

  if (assignedTo) {
    operations.push({ op: "add", path: `/fields/${ASSIGNED_TO}`, value: assignedTo });
  }

  operations.push({
    op: "add",
    path: "/relations/-",
    value: {
      rel: "System.LinkTypes.Hierarchy-Reverse",
      url: buildWorkItemUrl(userStory, parentUrl),
      attributes: { comment: `Tarefa gerada para a fase de ${phase.label}.` }
    }
  });

  return {
    phase: phase.key,
    phaseLabel: phase.label,
    activity: phase.activity,
    workItemType,
    title,
    description,
    operations
  };
}

export function decomposeUserStory({ storyTitle, storyDescription }) {
  const text = cleanDescription(storyDescription);
  const normalized = normalizeText(text);
  const specifications = [];

  if (hasAny(normalized, ["execucao", "status", "id unico", "timestamp", "ciclo de vida"])) {
    specifications.push({
      title: "Modelar o ciclo de vida das execuções",
      objective: "Representar cada cenário como uma execução independente e rastreável.",
      activities: [
        "Definir o modelo de execução, identificador, timestamp e estados.",
        "Implementar as transições entre Pendente, Em execução, Concluído e Falha.",
        "Persistir o histórico mínimo necessário para consulta e auditoria."
      ],
      completionCriteria: [
        "Cada submissão gera um ID único.",
        "Os estados são atualizados sem permitir transições inválidas.",
        "O histórico da execução pode ser consultado."
      ],
      evidence: findEvidence(text, ["execucao", "status", "id unico"])
    });
  }

  if (hasAny(normalized, ["fila", "enfileir", "fifo", "agend", "processad"])) {
    specifications.push({
      title: "Implementar fila e processamento assíncrono",
      objective: "Enfileirar múltiplos cenários e processá-los conforme a capacidade disponível.",
      activities: [
        "Criar o mecanismo de entrada e retirada de execuções da fila.",
        "Garantir processamento na ordem de submissão, respeitando a capacidade do ambiente.",
        "Atualizar o status da execução durante o processamento."
      ],
      completionCriteria: [
        "Múltiplas execuções podem ser submetidas sem bloquear a interface.",
        "A regra FIFO é respeitada.",
        "A capacidade máxima por ambiente é respeitada."
      ],
      evidence: findEvidence(text, ["fila", "fifo", "processad"])
    });
  }

  if (hasAny(normalized, ["submet", "input", "valid", "regra de negocio", "reprocess"])) {
    specifications.push({
      title: "Implementar submissão e validação dos cenários",
      objective: "Validar os dados antes da fila e registrar cada cenário como uma execução.",
      activities: [
        "Implementar a submissão de um ou mais cenários.",
        "Validar os inputs e as regras de negócio antes do enfileiramento.",
        "Bloquear edição após submissão e disponibilizar reprocessamento de falhas."
      ],
      completionCriteria: [
        "Inputs inválidos não entram na fila.",
        "Cada cenário submetido possui uma execução independente.",
        "Falhas podem ser identificadas para reprocessamento."
      ],
      evidence: findEvidence(text, ["submet", "valid", "input", "reprocess"])
    });
  }

  if (hasAny(normalized, ["interface", "tela", "scrapp", "status em tempo real", "filtro", "notificacao"])) {
    specifications.push({
      title: "Implementar acompanhamento das execuções no ScrApp",
      objective: "Permitir submissão e acompanhamento dos cenários pela interface do OTIM.",
      activities: [
        "Criar a tela de submissão de múltiplos cenários.",
        "Exibir fila, status, data de submissão e execução ativa.",
        "Adicionar atualização, filtros e notificação quando aplicável."
      ],
      completionCriteria: [
        "O usuário consegue submeter múltiplos cenários.",
        "O status atual de cada execução é exibido.",
        "A interface não fica bloqueada durante o processamento."
      ],
      evidence: findEvidence(text, ["interface", "tela", "scrapp", "status em tempo real"])
    });
  }

  if (hasAny(normalized, ["retry", "resilien", "falha", "log", "auditoria", "seguranca"])) {
    specifications.push({
      title: "Implementar resiliência, auditoria e segurança",
      objective: "Garantir operação controlada em falhas, rastreabilidade e acesso seguro.",
      activities: [
        "Implementar retry ou tratamento controlado para falhas de execução.",
        "Registrar logs completos para investigação e auditoria.",
        "Aplicar autenticação, autorização e proteção dos dados processados."
      ],
      completionCriteria: [
        "Falhas deixam a execução em um estado conhecido.",
        "Os logs permitem reconstruir a execução.",
        "Somente usuários autorizados acessam os cenários."
      ],
      evidence: findEvidence(text, ["retry", "falha", "log", "auditoria", "seguranca"])
    });
  }

  if (specifications.length === 0) {
    specifications.push({
      title: `Implementar: ${storyTitle}`,
      objective: "Entregar o comportamento descrito na user story.",
      activities: [
        "Detalhar a solução técnica a partir da descrição e dos critérios de aceite.",
        "Implementar o comportamento principal da user story.",
        "Executar testes automatizados e registrar as decisões relevantes."
      ],
      completionCriteria: [
        "O fluxo principal da user story funciona conforme esperado.",
        "Os critérios de aceite disponíveis foram atendidos.",
        "A alteração está coberta por testes compatíveis."
      ],
      evidence: truncate(text, 280)
    });
  }

  return specifications;
}

function buildHomologationSpecifications(storyDescription) {
  const normalized = normalizeText(storyDescription);
  const specifications = [
    {
      title: "Executar fluxo principal em homologação",
      objective: "Validar o fluxo principal da user story com dados representativos.",
      activities: ["Executar o fluxo principal com dados representativos."],
      completionCriteria: [
        "O fluxo principal foi executado sem erro.",
        "O resultado obtido está de acordo com o esperado."
      ],
      evidence: findEvidence(storyDescription, ["fluxo", "cenarios"])
    },
    {
      title: "Validar critérios de aceite em homologação",
      objective: "Confirmar os critérios de aceite e registrar as evidências da validação.",
      activities: ["Validar os critérios de aceite e registrar evidências."],
      completionCriteria: [
        "Todos os critérios de aceite aplicáveis foram executados.",
        "As evidências foram anexadas ou referenciadas."
      ],
      evidence: findEvidence(storyDescription, ["criterio", "requisito"])
    },
    {
      title: "Validar experiência e mensagens do usuário",
      objective: "Confirmar que mensagens, estados e resultados são compreensíveis para o usuário.",
      activities: [
        "Confirmar que mensagens, estados e resultados estão compreensíveis para o usuário."
      ],
      completionCriteria: [
        "Mensagens de sucesso e erro foram verificadas.",
        "Os estados exibidos correspondem ao processamento real."
      ],
      evidence: findEvidence(storyDescription, ["interface", "mensagem", "status"])
    }
  ];

  if (hasAny(normalized, ["fila", "enfileir", "fifo"])) {
    specifications.unshift({
      title: "Validar ordem de processamento da fila",
      objective: "Confirmar que múltiplos cenários são processados na ordem esperada.",
      activities: [
        "Submeter múltiplos cenários e confirmar a ordem de processamento da fila."
      ],
      completionCriteria: [
        "Todos os cenários foram recebidos.",
        "A ordem FIFO foi respeitada."
      ],
      evidence: findEvidence(storyDescription, ["fila", "fifo"])
    });
  }
  if (hasAny(normalized, ["status", "execucao"])) {
    specifications.push({
      title: "Validar transições de status",
      objective: "Confirmar as transições de cada execução até Concluído ou Falha.",
      activities: ["Validar as transições de status até Concluído e Falha."],
      completionCriteria: [
        "Os estados Pendente, Em execução, Concluído e Falha foram validados.",
        "Uma falha fica registrada com estado conhecido."
      ],
      evidence: findEvidence(storyDescription, ["status", "execucao"])
    });
  }

  return specifications;
}

function buildDeploymentSpecifications(storyDescription) {
  const normalized = normalizeText(storyDescription);
  const specifications = [
    {
      title: "Preparar implantação em produção",
      objective: "Confirmar dependências, configurações e permissões necessárias.",
      activities: ["Confirmar dependências, configurações e permissões necessárias."],
      completionCriteria: [
        "Dependências e configurações foram conferidas.",
        "Permissões necessárias estão disponíveis."
      ],
      evidence: findEvidence(storyDescription, ["configur", "permiss", "depend"])
    },
    {
      title: "Publicar solução em produção",
      objective: "Publicar os componentes da solução seguindo o plano de implantação.",
      activities: ["Publicar os componentes da solução seguindo o plano de implantação."],
      completionCriteria: [
        "A publicação foi concluída sem erro.",
        "A versão publicada foi registrada."
      ],
      evidence: findEvidence(storyDescription, ["implant", "public", "producao"])
    },
    {
      title: "Validar publicação em produção",
      objective: "Confirmar o funcionamento da solução após a implantação.",
      activities: ["Executar smoke test e registrar o resultado da publicação."],
      completionCriteria: [
        "O smoke test foi executado.",
        "O resultado pós-implantação foi registrado."
      ],
      evidence: findEvidence(storyDescription, ["status", "resultado", "valid"])
    }
  ];

  if (hasAny(normalized, ["fila", "enfileir", "agend"])) {
    specifications.unshift({
      title: "Configurar fila em produção",
      objective: "Configurar capacidade, monitoramento e parâmetros de processamento da fila.",
      activities: [
        "Configurar capacidade, monitoramento e parâmetros de processamento da fila."
      ],
      completionCriteria: [
        "A capacidade da fila está configurada.",
        "O monitoramento está ativo."
      ],
      evidence: findEvidence(storyDescription, ["fila", "agend"])
    });
  }
  if (hasAny(normalized, ["log", "auditoria", "seguranca"])) {
    specifications.push({
      title: "Validar observabilidade e acesso",
      objective: "Confirmar logs, alertas e controles de acesso após a publicação.",
      activities: ["Confirmar logs, alertas e controles de acesso após a publicação."],
      completionCriteria: [
        "Logs e alertas foram verificados.",
        "Os controles de acesso foram validados."
      ],
      evidence: findEvidence(storyDescription, ["log", "auditoria", "seguranca"])
    });
  }

  return specifications;
}

export function summarizeUserStory(userStory) {
  const fields = userStory.fields || {};
  return {
    id: userStory.id,
    type: fields[WORK_ITEM_TYPE] || null,
    title: fields[STORY_TITLE] || null,
    description: cleanDescription(fields[STORY_DESCRIPTION]),
    assignedTo: assignedToValue(fields[ASSIGNED_TO]),
    areaPath: fields[AREA_PATH] || null,
    iterationPath: fields[ITERATION_PATH] || null
  };
}

function inheritedFieldOperations(fields) {
  return [AREA_PATH, ITERATION_PATH]
    .filter((field) => fields[field])
    .map((field) => ({ op: "add", path: `/fields/${field}`, value: fields[field] }));
}

function buildWorkItemUrl(userStory, parentUrl = null) {
  if (userStory.url) {
    return userStory.url;
  }
  if (parentUrl) {
    return parentUrl;
  }
  if (userStory.id === undefined || userStory.id === null) {
    throw new Error("A user story precisa ter um ID ou URL para receber as tarefas filhas.");
  }
  return `/_apis/wit/workItems/${userStory.id}`;
}

function assignedToValue(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return value.uniqueName || value.mail || value.email || value.displayName || null;
}

function cleanDescription(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function hasAny(text, terms) {
  return terms.some((term) => text.includes(normalizeText(term)));
}

function findEvidence(text, terms) {
  const normalizedTerms = terms.map(normalizeText);
  const sentence = cleanDescription(text)
    .split(/(?<=[.!?])\s+/)
    .find((candidate) => normalizedTerms.some((term) => normalizeText(candidate).includes(term)));
  return sentence ? truncate(sentence, 280) : "";
}

function truncate(value, maxLength) {
  const normalized = String(value || "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trim()}...`;
}

function normalizeId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeTaskWorkItemType(value) {
  const normalized = String(value || TASK_WORK_ITEM_TYPE).trim();
  if (normalizeText(normalized) !== "task") {
    throw new Error(
      `Tipo de tarefa invalido: ${normalized}. Este fluxo cria somente work items do tipo Task.`
    );
  }
  return TASK_WORK_ITEM_TYPE;
}

function normalizeText(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
