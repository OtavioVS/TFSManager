#!/usr/bin/env node
import { AzureDevOpsClient, WORK_ITEM_FIELDS } from "./azure-devops/client.js";
import { JsonlAuditLog } from "./audit/jsonlAuditLog.js";
import { sumAppliedHoursByDay } from "./audit/dailyHours.js";
import { diasEstimados, hoursByDayFromUpdates, mergeHoursByDay } from "./audit/tfsHistory.js";
import {
  findSprintWindow,
  isFutureDay,
  listBusinessDays,
  parentOfIterationPath,
  planSprintAllocation,
  resolveSprintCardHours,
  resolveCurrentSprint,
  sprintNameFromIterationPath,
  todayIso
} from "./work-items/sprint.js";
import { buildConfig, assertRuntimeConfig, loadDotEnv } from "./config/env.js";
import { commandFromFlags, normalizeCommand, parseMissingFields } from "./work-items/command.js";
import { WorkItemService } from "./work-items/service.js";
import { TimeboxClient } from "./timebox/client.js";
import { buildMonthlySummary, hoursByDayFromAppointments, monthRange } from "./timebox/summary.js";
import { decodeJwtPayload, isExpired, parseTimeboxToken, secondsUntilExpiry } from "./timebox/appToken.js";
import { mintTimeboxToken } from "./timebox/mintToken.js";
import { updateEnvFile } from "./config/envFile.js";
import { listAssignedCards } from "./work-items/list.js";
import { TaskCardService } from "./work-items/task-cards.js";

const ITERATION_PATH = "System.IterationPath";
const COMPLETED_WORK_FIELD = "Microsoft.VSTS.Scheduling.CompletedWork";
const REMAINING_WORK_FIELD = "Microsoft.VSTS.Scheduling.RemainingWork";

async function main() {
  loadDotEnv();

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.list) {
    const config = buildConfig();
    assertRuntimeConfig(config, { needsAzureDevOps: true });
    const azureDevOpsClient = new AzureDevOpsClient(config.azureDevOps);
    let timeboxClient = null;
    if (args.sprint && config.timebox.enabled) {
      await hydrateTimeboxUserConfig(config, azureDevOpsClient);
      assertRuntimeConfig(config, { needsTimebox: true });
      timeboxClient = new TimeboxClient(config.timebox);
    }
    const result = await listAssignedCards(azureDevOpsClient, config, {
      person: args.personName,
      sprint: args.sprint,
      states: args.states,
      includeClosed: args.includeClosed
    });
    printList(result);

    // Com a semana filtrada, mostra onde ainda cabe hora.
    if (args.sprint) {
      await printSprintDaySummary({ azureDevOpsClient, timeboxClient, config, args, result });
    }
    return;
  }

  if (args.configStatus) {
    await printConfigStatus(buildConfig());
    return;
  }

  if (args.timeboxStatus) {
    await printTimeboxStatus(buildConfig());
    return;
  }

  if (args.timeboxToken !== null) {
    await runTimeboxLogin(args.timeboxToken);
    return;
  }

  if (args.timeboxSetup) {
    await runTimeboxSetup();
    return;
  }

  if (args.month !== null) {
    await printMonthlyView({ config: buildConfig(), month: args.month, today: args.today });
    return;
  }

  if (args.fillSprint) {
    const config = buildConfig();
    if (args.today) {
      config.policy.today = args.today;
    }
    assertRuntimeConfig(config, { needsAzureDevOps: true });
    const azureDevOpsClient = new AzureDevOpsClient(config.azureDevOps);
    if (config.timebox.enabled) {
      await hydrateTimeboxUserConfig(config, azureDevOpsClient);
      assertRuntimeConfig(config, { needsTimebox: true });
    }

    const timeboxClient = config.timebox.enabled ? new TimeboxClient(config.timebox) : null;
    await runFillSprint({
      args,
      config,
      azureDevOpsClient,
      timeboxClient,
      service: new WorkItemService({
        azureDevOpsClient,
        timeboxClient,
        config
      })
    });
    return;
  }

  if (args.createTasks) {
    const config = buildConfig();
    assertRuntimeConfig(config, { needsAzureDevOps: true });
    const azureDevOpsClient = new AzureDevOpsClient(config.azureDevOps);
    const taskCardService = new TaskCardService({ azureDevOpsClient });
    const userStoryId = args.userStoryId || args.workItemId;
    const result = args.apply
      ? await taskCardService.apply({
          userStoryId,
          phases: args.taskPhases,
          workItemType: args.taskType,
          assignedTo: args.taskAssignee
        })
      : await taskCardService.plan({
          userStoryId,
          phases: args.taskPhases,
          workItemType: args.taskType,
          assignedTo: args.taskAssignee
        });

    new JsonlAuditLog(config.audit.logPath).append({
      at: new Date().toISOString(),
      mode: args.apply ? "apply" : "dry-run",
      input: { ...auditInput(args), createTasks: true },
      result
    });
    printResult(result, args.apply);
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (args.positionals.length > 0) {
    throw new Error("Entrada em linguagem natural foi removida. Use o Claude CLI para gerar --command-json ou flags estruturadas.");
  }

  // Sem nenhum argumento util, mostrar a ajuda e mais amigavel que estourar erro.
  if (!args.commandJson && !hasStructuredFlags(args)) {
    printHelp();
    return;
  }

  const config = buildConfig();
  if (args.today) {
    config.policy.today = args.today;
  }
  const shouldApply = args.apply === true;

  assertRuntimeConfig(config, {
    needsAzureDevOps: true
  });

  const azureDevOpsClient = new AzureDevOpsClient(config.azureDevOps);
  if (config.timebox.enabled) {
    await hydrateTimeboxUserConfig(config, azureDevOpsClient);
  }
  assertRuntimeConfig(config, {
    needsTimebox: config.timebox.enabled
  });

  const command = args.commandJson ? normalizeCommand(JSON.parse(args.commandJson)) : commandFromFlags(args);
  // Sem --date, o Time Box ja usava hoje. Tornar a data explicita antes do
  // planejamento garante que a mesma regra de 8h rode antes de alterar o Azure.
  if (!command.workDate) {
    command.workDate = args.today || todayIso();
  }

  const service = new WorkItemService({
    azureDevOpsClient,
    timeboxClient: config.timebox.enabled ? new TimeboxClient(config.timebox) : null,
    config
  });
  const result = shouldApply ? await service.apply(command) : await service.plan(command);
  new JsonlAuditLog(config.audit.logPath).append({
    at: new Date().toISOString(),
    mode: shouldApply ? "apply" : "dry-run",
    input: auditInput(args),
    command,
    result
  });

  printResult(result, shouldApply);

  if (!result.ok) {
    process.exitCode = 1;
  }
}

// Distribui horas pelos dias uteis da sprint, para um ou varios cards, respeitando
// o limite diario e o que ja foi lancado em cada dia. Opcionalmente conclui os cards.
//
// Sem --id, pega todos os cards abertos da pessoa na sprint. Usa o RemainingWork
// quando informado; quando ausente, divide as horas livres pelo total de cards.
async function runFillSprint({ args, config, azureDevOpsClient, timeboxClient, service }) {
  const personName = args.personName || defaultPersonName(config);
  if (!personName) {
    throw new Error("Informe --person (ou deixe uma unica identidade em config/identities.json).");
  }
  args.personName = personName;

  const nodes = await azureDevOpsClient.getIterationNodes();
  let sprintName = isCurrentSprintAlias(args.sprint) ? null : args.sprint;
  let parentPath = null;

  // Sem sprint explicita, descobre a corrente pelos cards do proprio usuario:
  // a area onde ele trabalha define a serie de sprints usada pelo projeto.
  if (!sprintName && !args.workItemId) {
    const todosOsCards = await listAssignedCards(azureDevOpsClient, config, { person: personName });
    const atual = resolveCurrentSprint({
      rootNode: nodes,
      iterationPaths: todosOsCards.rows.map((row) => row.iterationPath),
      today: args.today || todayIso()
    });

    if (!atual.sprint) {
      throw new Error("Nao consegui descobrir a sprint corrente; informe --sprint explicitamente.");
    }

    sprintName = atual.sprint.name;
    parentPath = atual.parentPath;
    console.log(`Sprint corrente detectada: ${sprintName}${parentPath ? ` (area ${parentPath})` : ""}\n`);
    args.sprint = sprintName;
  }

  avisarTokenTimeboxExpirado(config);

  const { cards, ignoredByState } = await resolveSprintCards({ args, config, azureDevOpsClient });
  if (cards.length === 0) {
    const filtro = args.states ? `status ${args.states}` : "New/Active com horas faltando";
    throw new Error(
      `Nenhum card de ${personName} (${filtro}) na sprint ${sprintName || "informada"}.` +
        (ignoredByState > 0 ? ` ${ignoredByState} card(s) ja estao Resolved/Closed.` : "")
    );
  }

  sprintName = sprintName || sprintNameFromIterationPath(cards[0].iterationPath);
  if (!sprintName) {
    throw new Error(`Card ${cards[0].id} sem IterationPath; use --sprint para informar a sprint.`);
  }
  parentPath = parentPath || parentOfIterationPath(cards[0].iterationPath);

  const window = findSprintWindow(nodes, sprintName, { parentPath });
  if (!window) {
    throw new Error(`Sprint "${sprintName}" nao encontrada ou sem datas de inicio/fim no TFS.`);
  }

  const days = listBusinessDays(window.startDate, window.finishDate);
  const maxHoursPerDay = config.policy.maxHoursPerDay;
  // Orcamento de horas ja ocupadas por dia; vai crescendo conforme cada card e alocado,
  // para que dois cards nao disputem o mesmo dia. O Time Box e a fonte com a data real;
  // audit e historico do TFS continuam como protecao para nunca subestimar.
  const sprintCardsForAudit = await listAssignedCards(azureDevOpsClient, config, {
    person: args.personName,
    sprint: sprintName,
    includeClosed: true
  });
  const doAudit = sumAppliedHoursByDay(config.audit.logPath, {
    personName: args.personName,
    workItems: sprintCardsForAudit.rows.map((row) => ({
      id: row.id,
      completed: Number(row.completed) || 0
    }))
  });
  const doTfs = await lerHistoricoDaSprint({ azureDevOpsClient, config, args, sprintName });
  const doTimebox = await lerHorasTimebox({
    timeboxClient,
    config,
    startDate: window.startDate,
    endDate: window.finishDate
  });
  const hoursByDay = mergeHoursByDay(doAudit, doTfs, doTimebox);

  const estimados = diasEstimados(doTfs).filter((dia) => days.includes(dia));
  if (estimados.length > 0) {
    console.log(`Aviso: em ${estimados.join(", ")} havia horas sem data no comentario;`);
    console.log(`considerei a data em que foram gravadas, que pode nao ser o dia trabalhado.\n`);
  }
  let budget = args.completedWorkDelta === null ? null : Number(args.completedWorkDelta);
  const cardHours = resolveSprintCardHours({
    cards,
    days,
    maxHoursPerDay,
    hoursByDay
  });

  const plans = [];
  for (const [cardIndex, card] of cards.entries()) {
    const target = cardHours.targets[cardIndex];
    let hours = target.hours;
    let hourSource = target.source;
    if (budget !== null) {
      hours = Math.min(hours > 0 ? hours : budget, budget);
      if (target.source === "sprint-average") {
        hourSource = "manual-budget";
      }
    }

    if (!(hours > 0)) {
      const skippedReason =
        budget !== null && budget <= 0
          ? "orcamento de horas esgotado"
          : target.source === "sprint-average"
            ? "sem horas livres na sprint"
            : "sem trabalho restante";
      plans.push({ card, allocation: null, skippedReason, hourSource, plannedHours: hours });
      continue;
    }

    const allocation = planSprintAllocation({ days, totalHours: hours, maxHoursPerDay, hoursByDay });
    for (const item of allocation.allocations) {
      hoursByDay[item.date] = Math.round(((hoursByDay[item.date] || 0) + item.hours) * 100) / 100;
    }
    if (budget !== null) {
      budget = Math.round((budget - allocation.allocated) * 100) / 100;
    }

    plans.push({ card, allocation, hourSource, plannedHours: hours });
  }

  printSprintPlan({ plans, sprintName, window, days, config, args, ignoredByState, cardHours });

  const semEspaco = plans.filter((plan) => plan.allocation && plan.allocation.unallocated > 0);
  if (semEspaco.length > 0) {
    throw new Error(
      `Nao cabem ${semEspaco.reduce((total, plan) => total + plan.allocation.unallocated, 0)}h na sprint ${sprintName}: ` +
        `os dias uteis ja estao no limite de ${maxHoursPerDay}h/dia. Nada foi gravado.`
    );
  }

  const commands = plans.flatMap((plan) =>
    (plan.allocation?.allocations || []).map((item, index, todas) =>
      normalizeCommand({
        workItemId: plan.card.id,
        personName: args.personName,
        completedWorkDelta: item.hours,
        remainingWorkDelta: args.remainingWorkDelta,
        // Estado e zeramento do restante so no ultimo lancamento de cada card.
        targetState: index === todas.length - 1 ? args.targetState : null,
        targetBoardColumn: index === todas.length - 1 ? args.targetBoardColumn : null,
        forceRemainingZero: index === todas.length - 1 && Boolean(args.targetState || args.targetBoardColumn),
        workDate: item.date,
        comment: args.comment,
        confidence: args.confidence ?? 1,
        needsConfirmation: args.needsConfirmation,
        missingFields: args.missingFields
      })
    )
  );

  if (commands.length === 0) {
    throw new Error("Nada a lancar: nenhum card com horas pendentes.");
  }

  if (!args.apply) {
    // Valida politica/responsavel sem gravar, usando o primeiro lancamento.
    const preview = await service.plan(commands[0]);
    if (!preview.ok) {
      printResult(preview, false);
      process.exitCode = 1;
      return;
    }
    console.log("\nSimulacao apenas. Repita com --apply para gravar.");
    return;
  }

  const auditLog = new JsonlAuditLog(config.audit.logPath);
  for (const [index, command] of commands.entries()) {
    const result = await service.apply(command);
    auditLog.append({
      at: new Date().toISOString(),
      mode: "apply",
      input: { ...auditInput(args), fillSprint: true, sprint: sprintName },
      command,
      result
    });

    console.log(`\n[${index + 1}/${commands.length}] card #${command.workItemId} | ${command.workDate} +${command.completedWorkDelta}h`);
    printResult(result, true);

    if (!result.ok) {
      console.error(`\nInterrompido no lancamento de ${command.workDate}. Os anteriores ja foram gravados.`);
      process.exitCode = 1;
      return;
    }
  }
}

const TIMEBOX_DEFAULT_API = "https://amstl.agendaaqui.com.br/api";

// Modo automatico: liga o Time Box sem colar token. Descobre a identidade pelo PAT
// e passa a gerar o JWT localmente a cada uso (o backend nao valida assinatura).
async function runTimeboxSetup() {
  const config = buildConfig();
  const stored = config.timebox.apiUrl;
  const apiUrl = !stored || /localhost|127\.0\.0\.1/.test(stored) ? TIMEBOX_DEFAULT_API : stored;

  assertRuntimeConfig(config, { needsAzureDevOps: true });
  const azureDevOpsClient = new AzureDevOpsClient(config.azureDevOps);

  // Preenche id/org/nome pela conexao do Azure DevOps (so com o PAT) quando faltar.
  const alvo = { ...config, timebox: { ...config.timebox, apiUrl, enabled: true, mintToken: true } };
  process.stdout.write("Descobrindo sua identidade no Azure DevOps... ");
  try {
    await hydrateTimeboxUserConfig(alvo, azureDevOpsClient);
  } catch (error) {
    console.log("FALHOU");
    console.log(`  ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const user = alvo.timebox.user;
  const faltando = ["id", "organizationId", "name", "displayName"].filter((campo) => !user[campo]);
  if (faltando.length > 0) {
    console.log("incompleto");
    console.log(`  Nao consegui descobrir: ${faltando.join(", ")}. Preencha no .env e tente de novo.`);
    process.exitCode = 1;
    return;
  }
  console.log("OK");
  console.log(`  ${user.displayName} <${user.name}>`);
  console.log(`  org ${user.organizationId}`);

  // Valida gerando o token localmente e lendo do backend de verdade.
  process.stdout.write("Gerando token local e testando no Time Box... ");
  try {
    const jwt = mintTimeboxToken(user);
    const r = await fetch(`${apiUrl}/v1/appointment/search?workItemId=1`, {
      headers: { authorization: `Bearer ${jwt}`, accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) {
      console.log(`FALHOU (HTTP ${r.status})`);
      console.log("  O backend pode ter passado a validar o token. O modo automatico so");
      console.log("  funciona enquanto ele aceitar o JWT sem conferir a assinatura.");
      process.exitCode = 1;
      return;
    }
  } catch (error) {
    console.log(`FALHOU: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log("OK");

  updateEnvFile(".env", {
    TIMEBOX_API_URL: apiUrl,
    TIMEBOX_USER_ID: user.id,
    TIMEBOX_ORGANIZATION_ID: user.organizationId,
    TIMEBOX_USER_NAME: user.name,
    TIMEBOX_USER_DISPLAY_NAME: user.displayName,
    TIMEBOX_MINT_TOKEN: "true",
    TIMEBOX_ENABLED: "true",
    // Limpa tokens colados: no modo mint eles nao sao mais usados e teriam prioridade.
    TIMEBOX_AUTH_TOKEN: "",
    TIMEBOX_APP_TOKEN: ""
  });

  console.log("\nTime Box LIGADO no modo automatico. Nao precisa colar token nunca mais:");
  console.log("o CLI gera o token com a SUA identidade (acima) a cada lancamento.");
  console.log("\nNa primeira vez que apontar de verdade, confira no Time Box Control que o");
  console.log("apontamento aparece com o seu nome. Se aparecer diferente, use o menu");
  console.log("Time Box -> Colar token uma vez (a identidade do token e a definitiva).");
}

// Se o Timebox esta ligado mas o token venceu, avisa antes de aplicar: o AzDO
// seria atualizado e so o Timebox falharia, deixando as duas fontes divergentes.
function avisarTokenTimeboxExpirado(config) {
  if (!config.timebox.enabled) {
    return;
  }
  if (config.timebox.authToken) {
    const exp = decodeJwtPayload(config.timebox.authToken)?.exp || null;
    if (isExpired(exp)) {
      console.log(">> Time Box: seu token expirou. Nada sera gravado ate voce colar um novo.");
      console.log("   Use o menu Time Box Control -> Colar token.\n");
    }
    return;
  }
  if (config.timebox.mintToken) {
    return;
  }
  // Sem authToken, dependemos do app token via /v1/user, que precisa estar fresco.
  const exp = decodeJwtPayload(config.timebox.user?.appToken || "")?.exp || null;
  if (isExpired(exp)) {
    console.log(">> Time Box: seu app token expirou. O apontamento iria SO para o Azure DevOps.");
    console.log("   Cole um token novo (menu Time Box Control -> Colar token) antes de aplicar.\n");
  }
}

// Cola um token do navegador, grava a config do Timebox no .env, valida e liga.
async function runTimeboxLogin(pasted) {
  const dados = parseTimeboxToken(pasted);

  if (dados.kind === "invalid") {
    console.log("Token nao reconhecido. Cole o valor do header Authorization (comeca com 'Bearer eyJ...')");
    console.log("de uma chamada ao backend no F12 -> Network, ou o app token da extensao.");
    process.exitCode = 1;
    return;
  }

  const config = buildConfig();
  // O .env de exemplo aponta pra localhost (backend de dev que nao sobe aqui);
  // troca pelo backend hospedado real.
  const stored = config.timebox.apiUrl;
  const apiUrl = !stored || /localhost|127\.0\.0\.1/.test(stored) ? TIMEBOX_DEFAULT_API : stored;
  const updates = { TIMEBOX_API_URL: apiUrl };

  if (dados.kind === "app") {
    // App token sozinho nao traz o organizationId; so serve se ele ja estiver no .env.
    if (!config.timebox.user.organizationId) {
      console.log("Esse e um app token, que nao carrega o ID da organizacao do Timebox.");
      console.log("Cole antes o JWT completo (header Authorization do Network) uma vez;");
      console.log("depois disso o app token sozinho passa a bastar.");
      process.exitCode = 1;
      return;
    }
    updates.TIMEBOX_APP_TOKEN = dados.appToken;
  } else {
    // JWT do Timebox: traz tudo. Guarda o proprio JWT como TIMEBOX_AUTH_TOKEN.
    // O backend atual rejeita token expirado, por isso a validade e mostrada abaixo.
    Object.assign(updates, {
      TIMEBOX_USER_ID: dados.userId,
      TIMEBOX_ORGANIZATION_ID: dados.organizationId,
      TIMEBOX_USER_NAME: dados.name,
      TIMEBOX_USER_DISPLAY_NAME: dados.displayName,
      TIMEBOX_AUTH_TOKEN: dados.authToken,
      TIMEBOX_APP_TOKEN: dados.appToken || ""
    });
  }

  // Testa antes de ligar: nao adianta gravar ENABLED=true com token morto.
  process.stdout.write("Validando token no Timebox... ");
  const alvo = { ...config, timebox: { ...config.timebox, apiUrl, enabled: true } };
  const teste = await testarLoginTimebox(alvo, updates);
  if (!teste.ok) {
    console.log("FALHOU");
    console.log(`  ${teste.error}`);
    console.log("  O token pode ter expirado (duram ~1h). Gere um novo e cole de novo.");
    process.exitCode = 1;
    return;
  }
  console.log("OK");

  updates.TIMEBOX_ENABLED = "true";
  updateEnvFile(".env", updates);
  console.log("\nTime Box Control LIGADO. A partir de agora, cada hora lancada");
  console.log("tambem vira um apontamento la (por dia).");
  console.log(`Usuario: ${dados.displayName || config.timebox.user.displayName || dados.userId}`);

  if (updates.TIMEBOX_AUTH_TOKEN) {
    const min = dados.exp ? Math.round(secondsUntilExpiry(dados.exp) / 60) : null;
    console.log(min === null ? "Token sem validade legivel." : `Token vale ~${Math.max(0, min)} min.`);
    console.log("Quando expirar, esta tela vai bloquear os lancamentos ate voce colar um novo.");
  } else if (dados.appTokenExp) {
    const min = Math.round(secondsUntilExpiry(dados.appTokenExp) / 60);
    console.log(min > 0 ? `Token vale ~${min} min; depois disso, cole um novo.` : "Atencao: o token ja esta no limite; se falhar, cole um novo.");
  }
}

// Monta um cliente com os updates e tenta autenticar + uma leitura.
async function testarLoginTimebox(config, updates) {
  const user = {
    id: updates.TIMEBOX_USER_ID || config.timebox.user.id,
    organizationId: updates.TIMEBOX_ORGANIZATION_ID || config.timebox.user.organizationId,
    name: updates.TIMEBOX_USER_NAME || config.timebox.user.name,
    displayName: updates.TIMEBOX_USER_DISPLAY_NAME || config.timebox.user.displayName,
    appToken: updates.TIMEBOX_APP_TOKEN ?? config.timebox.user.appToken
  };

  try {
    const client = new TimeboxClient({
      apiUrl: config.timebox.apiUrl,
      authToken: updates.TIMEBOX_AUTH_TOKEN || "",
      user
    });
    // getAuthToken usa o authToken direto ou faz o PUT /v1/user e devolve o JWT.
    const jwt = await client.getAuthToken();
    if (!jwt) {
      return { ok: false, error: "nao consegui obter o token de acesso" };
    }
    // Prova de verdade: uma leitura autenticada de fato aceita pelo backend.
    const r = await fetch(`${config.timebox.apiUrl}/v1/appointment/search?workItemId=1`, {
      headers: { authorization: `Bearer ${jwt}`, accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    return { ok: r.ok, error: r.ok ? "" : `o backend recusou o token (HTTP ${r.status})` };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// Mostra a configuracao atual e testa a conexao com o Azure DevOps.
async function printConfigStatus(config) {
  const azure = config.azureDevOps;
  const identidades = Object.entries(config.policy.identities || {});

  console.log("CONFIGURACAO ATUAL\n");
  console.log(`  Servidor    : ${azure.collectionUrl || azure.orgUrl || "(nao configurado)"}`);
  console.log(`  Projeto     : ${azure.project || "(nao configurado)"}`);
  console.log(`  Token (PAT) : ${mascarar(azure.pat)}`);
  console.log(
    `  Identidade  : ${
      identidades.length > 0
        ? identidades.map(([chave, valor]) => `${chave} <${valor.azureDevOpsEmail || "sem e-mail"}>`).join(", ")
        : "(nenhuma cadastrada)"
    }`
  );
  console.log(`  Limite      : ${config.policy.maxHoursPerDay}h por dia, ${config.policy.maxHoursPerCommand}h por lancamento`);
  console.log(`  Dia futuro  : ${config.policy.allowFutureHours ? "avisa (padrao)" : "bloqueia"}`);
  console.log(`  Historico   : ${config.audit.logPath}`);
  console.log(`  Time Box    : ${config.timebox.enabled ? "ligado" : "desligado"}`);

  const faltando = [];
  if (!azure.orgUrl && !azure.collectionUrl) faltando.push("AZDO_ORG_URL");
  if (!azure.project) faltando.push("AZDO_PROJECT");
  if (!azure.pat) faltando.push("AZDO_PAT");

  if (faltando.length > 0) {
    console.log(`\n  FALTA CONFIGURAR no .env: ${faltando.join(", ")}`);
    return;
  }

  process.stdout.write("\n  Testando conexao com o Azure DevOps... ");
  try {
    const dados = await new AzureDevOpsClient(azure).getConnectionData();
    const usuario = dados.authenticatedUser || dados.authorizedUser || {};
    console.log(`OK`);
    console.log(`  Conectado como: ${usuario.providerDisplayName || usuario.customDisplayName || usuario.displayName || "?"}`);
  } catch (error) {
    console.log("FALHOU");
    console.log(`  ${error.message}`);
    console.log("  Verifique a URL, o projeto e se o PAT nao expirou.");
  }
}

async function printMonthlyView({ config, month, today }) {
  if (!config.timebox.enabled) {
    throw new Error(
      'A visao mensal usa os apontamentos reais do Time Box. Ligue a integracao no menu "Time Box Control".'
    );
  }

  // Se a identidade ainda nao estiver completa, reaproveita o mesmo mecanismo do
  // setup para descobri-la pelo PAT sem pedir dados ao usuario.
  const user = config.timebox.user || {};
  if (!user.id || !user.organizationId || !user.name || !user.displayName) {
    assertRuntimeConfig(config, { needsAzureDevOps: true });
    await hydrateTimeboxUserConfig(config, new AzureDevOpsClient(config.azureDevOps));
  }
  assertRuntimeConfig(config, { needsTimebox: true });

  const referenceToday = today || todayIso();
  const selectedMonth = ["atual", "current", "corrente"].includes(String(month || "").toLowerCase())
    ? referenceToday.slice(0, 7)
    : String(month || referenceToday.slice(0, 7));
  const range = monthRange(selectedMonth);
  const timeboxClient = new TimeboxClient(config.timebox);
  const appointments = await timeboxClient.searchAppointments({
    userId: config.timebox.user.id,
    startedAt: range.startDate,
    endedAt: range.endDate
  });
  const hoursByDay = hoursByDayFromAppointments(appointments);
  const summary = buildMonthlySummary({
    month: range.month,
    hoursByDay,
    maxHoursPerDay: config.policy.maxHoursPerDay,
    today: referenceToday
  });
  const countByDay = {};
  for (const appointment of appointments) {
    const day = String(appointment?.workedAt || "").slice(0, 10);
    countByDay[day] = (countByDay[day] || 0) + 1;
  }

  console.log(`VISAO MENSAL - ${String(summary.monthNumber).padStart(2, "0")}/${summary.year}\n`);
  console.log(`  Usuario : ${config.timebox.user.displayName || config.timebox.user.name}`);
  console.log(`  Fonte   : Time Box Control`);
  console.log(`  Regra   : maximo ${summary.maxHoursPerDay}h por dia\n`);
  console.log("  Data        Dia   Horas  Lanc.  Situacao");
  console.log("  ----------  ----  -----  -----  ----------------");

  for (const row of summary.rows) {
    let status;
    if (row.excess > 0) {
      status = `EXCEDE ${formatHours(row.excess)}h`;
    } else if (!row.businessDay) {
      status = "FIM DE SEMANA";
    } else if (row.hours === summary.maxHoursPerDay) {
      status = row.future ? "OK / FUTURO" : "OK";
    } else if (row.future) {
      status = row.hours > 0 ? `FUTURO / faltam ${formatHours(row.remaining)}h` : "FUTURO";
    } else {
      status = `FALTAM ${formatHours(row.remaining)}h`;
    }

    console.log(
      `  ${row.date}  ${weekdayLabel(row.date).padEnd(4)}  ` +
        `${`${formatHours(row.hours)}h`.padStart(5)}  ${String(countByDay[row.date] || 0).padStart(5)}  ${status}`
    );
  }

  console.log(`\n  Total apontado : ${formatHours(summary.loggedHours)}h`);
  console.log(`  Capacidade mes : ${formatHours(summary.capacityHours)}h (${summary.rows.filter((row) => row.businessDay).length} dias uteis)`);
  console.log(`  Dias completos : ${summary.completeDays}`);
  console.log(`  Dias incompletos ate hoje: ${summary.incompletePastDays}`);

  if (summary.overLimitDays > 0) {
    console.log(`\n  ATENCAO: ${summary.overLimitDays} dia(s) acima de ${summary.maxHoursPerDay}h.`);
    console.log("  A nova validacao bloqueia novos excessos; os existentes precisam ser corrigidos manualmente.");
  } else {
    console.log(`\n  Nenhum dia acima de ${summary.maxHoursPerDay}h.`);
  }
}

// Mostra se a integracao com o Time Box Control esta de fato funcionando.
async function printTimeboxStatus(config) {
  const timebox = config.timebox;

  console.log("TIME BOX CONTROL - INTEGRACAO\n");
  console.log("  O Time Box Control e a extensao de apontamento que roda dentro do");
  console.log("  Azure DevOps. Com a integracao ligada, cada hora lancada por aqui");
  console.log("  vira tambem um apontamento la, alem de atualizar o card.\n");
  console.log(`  Integracao : ${timebox.enabled ? "LIGADA" : "DESLIGADA"}   (TIMEBOX_ENABLED no .env)`);
  console.log(`  API        : ${timebox.apiUrl || "(nao configurada)"}`);

  // Validade do token guardado.
  if (timebox.mintToken) {
    console.log(`  Token      : gerado localmente a cada uso (modo automatico, sem colar)`);
  } else if (timebox.authToken) {
    const exp = decodeJwtPayload(timebox.authToken)?.exp || null;
    const min = exp ? Math.round(secondsUntilExpiry(exp) / 60) : null;
    const situacao =
      min === null ? "direto (validade nao informada)" : min > 0 ? `direto (vale ~${min} min)` : "direto EXPIRADO";
    console.log(`  Token      : ${situacao}`);
  } else if (timebox.user?.appToken) {
    const exp = decodeJwtPayload(timebox.user.appToken)?.exp || null;
    const min = exp ? Math.round(secondsUntilExpiry(exp) / 60) : null;
    const situacao = min === null ? "sem validade legivel" : min > 0 ? `app token vale ~${min} min` : "app token EXPIRADO (cole um novo)";
    console.log(`  Token      : ${situacao}`);
  } else {
    console.log(`  Token      : (nenhum) - use "colar token" para ligar`);
  }

  let responde = false;
  let apiReachable = false;
  if (timebox.apiUrl) {
    process.stdout.write("  Conexao    : testando... ");
    if (timebox.enabled) {
      try {
        const user = timebox.user || {};
        if (!user.id || !user.organizationId || !user.name || !user.displayName) {
          assertRuntimeConfig(config, { needsAzureDevOps: true });
          await hydrateTimeboxUserConfig(config, new AzureDevOpsClient(config.azureDevOps));
        }
        assertRuntimeConfig(config, { needsTimebox: true });
        const today = todayIso();
        const appointments = await new TimeboxClient(config.timebox).searchAppointments({
          userId: config.timebox.user.id,
          startedAt: today,
          endedAt: today
        });
        responde = true;
        apiReachable = true;
        console.log(`autenticada (${appointments.length} lancamento(s) hoje)`);
      } catch (error) {
        apiReachable = /^Erro Timebox \d+/.test(error.message) || /Token do Time Box expirou/.test(error.message);
        console.log(`FALHOU (${error.message})`);
      }
    } else {
      const teste = await testarUrl(timebox.apiUrl);
      responde = teste.ok;
      apiReachable = teste.ok;
      console.log(teste.ok ? `responde (HTTP ${teste.status})` : `SEM RESPOSTA (${teste.error})`);
    }
  }

  console.log("\n  VEREDITO");
  if (timebox.enabled && responde) {
    console.log("  Funcionando: as horas vao para o Azure DevOps E para o Time Box.");
    return;
  }

  if (timebox.enabled) {
    console.log("  BLOQUEADO: enquanto o Time Box nao autenticar, nenhum novo lancamento");
    console.log("  e gravado no Azure nem no Time Box. Assim as duas fontes nao divergem.\n");
  } else {
    console.log("  Time Box desligado: as horas vao somente para o Azure DevOps/TFS.\n");
  }
  console.log("  Para ligar, na ordem:");
  let passo = 1;
  if (!apiReachable) {
    console.log(`   ${passo++}. Suba o backend do Time Box (projeto PLUGIN-TIMEBOX) em ${timebox.apiUrl || "TIMEBOX_API_URL"}`);
  }
  if (timebox.enabled && apiReachable && !responde) {
    console.log(`   ${passo++}. Abra o Time Box no Azure DevOps e cole um token novo na opcao [1]`);
  }
  if (!timebox.enabled) {
    console.log(`   ${passo++}. Troque TIMEBOX_ENABLED para true no .env`);
  }
  console.log(`   ${passo}. Rode esta tela de novo para conferir`);
}

// Ping simples: qualquer resposta HTTP ja prova que tem alguem ouvindo.
async function testarUrl(url) {
  try {
    const resposta = await fetch(url, { method: "GET", signal: AbortSignal.timeout(4000) });
    return { ok: true, status: resposta.status };
  } catch (error) {
    return { ok: false, error: error.name === "TimeoutError" ? "tempo esgotado" : error.message };
  }
}

function mascarar(segredo) {
  if (!segredo) {
    return "(nao configurado)";
  }
  return `${"*".repeat(8)}${String(segredo).slice(-4)} (${String(segredo).length} caracteres)`;
}

function formatHours(value) {
  const rounded = Math.round(Number(value || 0) * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(".", ",");
}

// "atual"/"current"/"auto" pedem deteccao automatica da sprint.
function isCurrentSprintAlias(value) {
  return ["atual", "current", "auto", "corrente"].includes(String(value || "").trim().toLowerCase());
}

// Sem --person, usa a unica identidade cadastrada (caso comum de uso pessoal).
function defaultPersonName(config) {
  const keys = Object.keys(config.policy.identities || {});
  return keys.length === 1 ? keys[0] : null;
}

// Mostra dia a dia da sprint quanto ja foi lancado e quanto ainda cabe.
async function printSprintDaySummary({ azureDevOpsClient, timeboxClient, config, args, result }) {
  const iterationPath = result.rows[0]?.iterationPath;
  const sprintName = isCurrentSprintAlias(args.sprint)
    ? sprintNameFromIterationPath(iterationPath)
    : args.sprint;

  const nodes = await azureDevOpsClient.getIterationNodes();
  const window = findSprintWindow(nodes, sprintName, { parentPath: parentOfIterationPath(iterationPath || "") });
  if (!window) {
    return;
  }

  const pessoa = args.personName || defaultPersonName(config);
  const sprintCardsForAudit = await listAssignedCards(azureDevOpsClient, config, {
    person: pessoa,
    sprint: sprintName,
    includeClosed: true
  });
  const doAudit = sumAppliedHoursByDay(config.audit.logPath, {
    personName: pessoa,
    workItems: sprintCardsForAudit.rows.map((row) => ({
      id: row.id,
      completed: Number(row.completed) || 0
    }))
  });
  const doTfs = await lerHistoricoDaSprint({ azureDevOpsClient, config, args: { ...args, personName: pessoa }, sprintName });
  const doTimebox = await lerHorasTimebox({
    timeboxClient,
    config,
    startDate: window.startDate,
    endDate: window.finishDate
  });
  const porDia = mergeHoursByDay(doAudit, doTfs, doTimebox);

  const limite = config.policy.maxHoursPerDay;
  const dias = listBusinessDays(window.startDate, window.finishDate);
  const incompletos = dias.filter((dia) => (porDia[dia] || 0) < limite);

  console.log(`\nHoras por dia em ${window.name || sprintName} (${window.startDate} a ${window.finishDate}):`);
  for (const dia of dias) {
    const lancado = porDia[dia] || 0;
    const falta = Math.round(Math.max(0, limite - lancado) * 100) / 100;
    const excesso = Math.round(Math.max(0, lancado - limite) * 100) / 100;
    const marca = excesso > 0 ? `EXCEDE ${excesso}h` : lancado === limite ? "completo" : `faltam ${falta}h`;
    console.log(`  ${dia}  ${weekdayLabel(dia)}  ${String(lancado).padStart(4)}h de ${limite}h   ${marca}`);
  }

  const totalFaltante = incompletos.reduce((soma, dia) => soma + (limite - (porDia[dia] || 0)), 0);
  console.log(
    incompletos.length === 0
      ? "\nTodos os dias uteis desta sprint estao completos."
      : `\n${incompletos.length} dia(s) incompletos, somando ${Math.round(totalFaltante * 100) / 100}h a lancar.`
  );
}

// O Time Box guarda a data trabalhada de forma nativa e por isso e a fonte
// principal do limite diario. Quando a integracao esta ligada, falhar a consulta
// bloqueia o planejamento: continuar poderia repetir exatamente o caso de 16h.
async function lerHorasTimebox({ timeboxClient, config, startDate, endDate }) {
  if (!config.timebox?.enabled) {
    return {};
  }
  if (!timeboxClient) {
    throw new Error("Time Box esta ligado, mas o cliente nao foi inicializado. Nada foi planejado.");
  }

  try {
    const appointments = await timeboxClient.searchAppointments({
      userId: config.timebox.user?.id,
      startedAt: startDate,
      endedAt: endDate
    });
    return hoursByDayFromAppointments(appointments);
  } catch (error) {
    throw new Error(
      `Nao foi possivel consultar o Time Box entre ${startDate} e ${endDate}: ${error.message}. ` +
        "Nada foi planejado para evitar horas duplicadas."
    );
  }
}

// Le o historico de todos os cards da sprint (inclusive fechados) para saber quanto
// ja foi lancado em cada dia, mesmo que tenha sido feito em outra maquina.
async function lerHistoricoDaSprint({ azureDevOpsClient, config, args, sprintName }) {
  if (!sprintName) {
    return {};
  }

  try {
    const daSprint = await listAssignedCards(azureDevOpsClient, config, {
      person: args.personName,
      sprint: sprintName,
      includeClosed: true
    });

    const historicos = await Promise.all(
      daSprint.rows.map(async (row) => {
        try {
          const updates = await azureDevOpsClient.getWorkItemUpdates(row.id);
          return hoursByDayFromUpdates(updates.value || [], {
            currentCompleted: Number(row.completed) || 0
          });
        } catch {
          return {};
        }
      })
    );

    // Cards diferentes somam no mesmo dia.
    const total = {};
    for (const historico of historicos) {
      for (const [dia, valor] of Object.entries(historico)) {
        const atual = total[dia] || { hours: 0, exata: true };
        total[dia] = {
          hours: Math.round((atual.hours + valor.hours) * 100) / 100,
          exata: atual.exata && valor.exata
        };
      }
    }

    return total;
  } catch {
    // Sem historico do TFS o planejamento continua com o audit log local.
    return {};
  }
}

// Resolve os cards do --fill-sprint: os IDs informados em --id (aceita lista separada
// por virgula) ou, na falta deles, todos os cards abertos da pessoa na sprint.
async function resolveSprintCards({ args, config, azureDevOpsClient }) {
  if (args.workItemId) {
    const ids = String(args.workItemId)
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isInteger(item) && item > 0);

    if (ids.length === 0) {
      throw new Error(`--id invalido: ${args.workItemId}`);
    }

    const detail = await azureDevOpsClient.getWorkItems(ids, [...WORK_ITEM_FIELDS, ITERATION_PATH]);
    return { cards: detail.value.map((workItem) => toCard(workItem.id, workItem.fields || {})), ignoredByState: 0 };
  }

  // Fechar a sprint = completar os cards que ainda tem trabalho: New e Active.
  // Resolved (em revisao) e Closed ficam de fora. --status sobrepoe se preciso.
  const list = await listAssignedCards(azureDevOpsClient, config, {
    person: args.personName,
    sprint: args.sprint,
    states: args.states || "New,Active"
  });

  return {
    cards: list.rows.map((row) => ({
      id: row.id,
      title: row.title,
      state: row.state,
      completed: Number(row.completed) || 0,
      remaining: optionalHours(row.remaining),
      iterationPath: row.iterationPath
    })),
    // Cards da sprint que ficaram de fora do filtro de status (Resolved/Closed).
    ignoredByState: Math.max(0, (list.naSprint ?? list.rows.length) - list.rows.length)
  };
}

function toCard(id, fields) {
  return {
    id,
    title: fields["System.Title"] || "",
    state: fields["System.State"] || "",
    completed: Number(fields[COMPLETED_WORK_FIELD]) || 0,
    remaining: optionalHours(fields[REMAINING_WORK_FIELD]),
    iterationPath: fields[ITERATION_PATH] || ""
  };
}

function optionalHours(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function printSprintPlan({
  plans,
  sprintName,
  window,
  days,
  config,
  args,
  ignoredByState = 0,
  cardHours
}) {
  console.log(`Sprint ${sprintName}: ${window.startDate} a ${window.finishDate} (${days.length} dias uteis, limite ${config.policy.maxHoursPerDay}h/dia)`);

  const filtro = args.states || "New/Active";
  const comHoras = plans.filter((plan) => plan.allocation).length;
  console.log(`Fechando ${comHoras} card(s) ${filtro} com horas faltando.` + (ignoredByState > 0 ? ` ${ignoredByState} ja Resolved/Closed, ignorado(s).` : ""));
  const automaticos = plans.filter((plan) => plan.hourSource === "sprint-average");
  if (automaticos.length > 0) {
    console.log(
      `Sem RemainingWork em ${automaticos.length} card(s): ` +
        `${formatHours(cardHours.availableHours)}h livres / ${cardHours.cardCount} cards = ` +
        `media de ${formatHours(cardHours.averageHours)}h por card.`
    );
  }

  const alvo = args.targetState || args.targetBoardColumn;
  const hoje = args.today || todayIso();
  let total = 0;

  for (const plan of plans) {
    const { card, allocation } = plan;
    const remainingLabel = card.remaining === null ? "nao informado" : `${formatHours(card.remaining)}h`;
    console.log(`\nCard #${card.id} | ${card.state} | feito ${formatHours(card.completed)}h / resta ${remainingLabel}`);
    console.log(`  ${truncate(card.title, 90)}`);
    if (plan.hourSource === "sprint-average") {
      console.log(`  estimativa automatica: ${formatHours(plan.plannedHours)}h`);
    }

    if (!allocation) {
      console.log(`  -> ignorado: ${plan.skippedReason}`);
      continue;
    }

    for (const item of allocation.allocations) {
      const ocupado = item.alreadyLogged > 0 ? ` (dia ja tinha ${item.alreadyLogged}h)` : "";
      const futuro = isFutureDay(item.date, hoje) ? "  << FUTURO" : "";
      console.log(`  ${item.date}  ${weekdayLabel(item.date)}  +${item.hours}h${ocupado}${futuro}`);
    }

    for (const item of allocation.skipped) {
      console.log(`  ${item.date}  ${weekdayLabel(item.date)}  pulado: ${item.reason}`);
    }

    total += allocation.allocated;
    const pendente = allocation.unallocated > 0 ? ` | FALTAM ${allocation.unallocated}h sem espaco` : "";
    console.log(`  -> ${allocation.allocated}h${pendente}${alvo ? ` | ao final: ${alvo}, restante 0` : ""}`);
  }

  console.log(`\nTotal a lancar: ${Math.round(total * 100) / 100}h em ${plans.filter((plan) => plan.allocation).length} card(s).`);
  if (args.comment) {
    console.log(`Comentario em cada lancamento: "${args.comment}"`);
  }

  // Aviso de horas futuras: trabalho que ainda nao aconteceu.
  const futuras = plans
    .flatMap((plan) => plan.allocation?.allocations || [])
    .filter((item) => isFutureDay(item.date, hoje));

  if (futuras.length > 0) {
    const horasFuturas = Math.round(futuras.reduce((soma, item) => soma + item.hours, 0) * 100) / 100;
    const fecha = alvo ? ` e fecharia o card como "${alvo}"` : "";
    console.log(`\n>> ATENCAO: ${horasFuturas}h caem em ${futuras.length} dia(s) que ainda nao aconteceram${fecha}.`);
    console.log(`   (hoje e ${hoje}; veja as linhas marcadas com FUTURO acima)`);
  }
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function weekdayLabel(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return ["dom", "seg", "ter", "qua", "qui", "sex", "sab"][new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

async function hydrateTimeboxUserConfig(config, azureDevOpsClient) {
  const user = config.timebox.user;
  if (user.id && user.organizationId && user.name && user.displayName) {
    return;
  }

  const connectionData = await azureDevOpsClient.getConnectionData();
  const azureUser = connectionData.authenticatedUser || connectionData.authorizedUser || {};
  const properties = azureUser.properties || {};

  user.id ||= azureUser.id || "";
  user.organizationId ||= connectionData.instanceId || "";
  user.name ||= properties.Account?.$value || azureUser.uniqueName || azureUser.providerName || "";
  user.displayName ||= azureUser.customDisplayName || azureUser.providerDisplayName || azureUser.displayName || user.name;
}
function parseArgs(argv) {
  const args = {
    positionals: [],
    apply: false,
    help: false,
    list: false,
    fillSprint: false,
    configStatus: false,
    timeboxStatus: false,
    timeboxToken: null,
    timeboxSetup: false,
    month: null,
    sprint: null,
    states: null,
    today: null,
    includeClosed: false,
    createTasks: false,
    userStoryId: null,
    taskPhases: null,
    taskType: "Task",
    taskAssignee: null,
    commandJson: "",
    workItemId: null,
    personName: null,
    completedWorkDelta: null,
    remainingWorkDelta: null,
    targetState: null,
    targetBoardColumn: null,
    workDate: null,
    comment: null,
    confidence: 1,
    needsConfirmation: false,
    missingFields: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") {
      args.help = true;
    } else if (value === "--apply") {
      args.apply = true;
    } else if (value === "--dry-run") {
      args.apply = false;
    } else if (value === "--list") {
      args.list = true;
    } else if (value === "--fill-sprint") {
      args.fillSprint = true;
    } else if (value === "--create-tasks") {
      args.createTasks = true;
    } else if (value === "--config-status") {
      args.configStatus = true;
    } else if (value === "--timebox-status") {
      args.timeboxStatus = true;
    } else if (value === "--timebox-token") {
      args.timeboxToken = readNext(argv, index, value);
      index += 1;
    } else if (value === "--timebox-setup") {
      args.timeboxSetup = true;
    } else if (value === "--month" || value === "--mes") {
      args.month = readNext(argv, index, value);
      index += 1;
    } else if (value === "--sprint") {
      args.sprint = readNext(argv, index, value);
      index += 1;
    } else if (value === "--status" || value === "--states") {
      args.states = readNext(argv, index, value);
      index += 1;
    } else if (value === "--today") {
      args.today = readNext(argv, index, value);
      index += 1;
    } else if (value === "--include-closed") {
      args.includeClosed = true;
    } else if (value === "--command-json") {
      args.commandJson = readNext(argv, index, value);
      index += 1;
    } else if (value === "--work-item-id" || value === "--id") {
      args.workItemId = readNext(argv, index, value);
      index += 1;
    } else if (value === "--user-story-id" || value === "--story-id") {
      args.userStoryId = readNext(argv, index, value);
      index += 1;
    } else if (value === "--phases" || value === "--phase") {
      args.taskPhases = readNext(argv, index, value);
      index += 1;
    } else if (value === "--task-type") {
      args.taskType = readNext(argv, index, value);
      index += 1;
    } else if (value === "--task-person" || value === "--assign-to") {
      args.taskAssignee = readNext(argv, index, value);
      index += 1;
    } else if (value === "--person") {
      args.personName = readNext(argv, index, value);
      index += 1;
    } else if (value === "--hours") {
      args.completedWorkDelta = readNext(argv, index, value);
      index += 1;
    } else if (value === "--remaining-delta") {
      args.remainingWorkDelta = readNext(argv, index, value);
      index += 1;
    } else if (value === "--state") {
      args.targetState = readNext(argv, index, value);
      index += 1;
    } else if (value === "--board-column" || value === "--column") {
      args.targetBoardColumn = readNext(argv, index, value);
      index += 1;
    } else if (value === "--date" || value === "--work-date") {
      args.workDate = readNext(argv, index, value);
      index += 1;
    } else if (value === "--comment") {
      args.comment = readNext(argv, index, value);
      index += 1;
    } else if (value === "--confidence") {
      args.confidence = readNext(argv, index, value);
      index += 1;
    } else if (value === "--needs-confirmation") {
      args.needsConfirmation = true;
    } else if (value === "--missing-fields") {
      args.missingFields = parseMissingFields(readNext(argv, index, value));
      index += 1;
    } else {
      args.positionals.push(value);
    }
  }

  return args;
}

function readNext(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Valor ausente para ${flag}.`);
  }
  return value;
}

function hasStructuredFlags(args) {
  return args.workItemId !== null || args.personName !== null || args.completedWorkDelta !== null;
}

function auditInput(args) {
  return {
    commandJsonProvided: Boolean(args.commandJson),
    flagsProvided: !args.commandJson,
    apply: args.apply
  };
}

function printList(result) {
  const escopo = result.sprint ? `sprint ${result.sprint}` : "todas as sprints";
  const filtroStatus =
    result.states?.length > 0 && !result.states.includes("todos") ? `, status ${result.states.join("/")}` : "";

  console.log(`Cards de ${result.person} (${escopo}${filtroStatus}): ${result.rows.length} de ${result.naSprint ?? result.totalAssigned}.`);

  if (result.rows.length === 0) {
    console.log(
      filtroStatus
        ? "Nenhum card com esse status. Tente --status todos para ver todos."
        : "Nenhum card encontrado."
    );
    return;
  }

  for (const row of result.rows) {
    const feito = row.completed === "" || row.completed === null ? "0" : row.completed;
    const resta = row.remaining === "" || row.remaining === null ? "0" : row.remaining;
    console.log("");
    console.log(`  #${row.id}  ${row.type} | ${row.state} | feito ${feito}h / resta ${resta}h`);
    console.log(`  ${row.title}`);
  }
  console.log("");
}

function printResult(result, applied) {
  const label = applied ? "APPLY" : "DRY-RUN";
  console.log(`[${label}] ${result.ok ? "OK" : "BLOQUEADO"} - ${result.stage}`);
  console.log(JSON.stringify(result, null, 2));
}

function printHelp() {
  console.log(`Uso:
  npm start -- --list
  npm start -- --list --sprint "2026 W24"                   (mostra tambem as horas por dia)
  npm start -- --month 2026-07                              (visao mensal do Time Box)
  npm start -- --list --sprint "2026 W24" --status todos
  npm start -- --fill-sprint --state Closed                 (sprint corrente, todos os cards abertos)
  npm start -- --fill-sprint --sprint "2026 W24" --state Closed
  npm start -- --fill-sprint --id 12345,12346 --hours 40 --state Closed
  npm start -- --create-tasks --user-story-id 12345 --phases develop,homologation,deployment
  npm start -- --create-tasks --apply --id 12345 --phases develop,homologation
  npm start -- --dry-run --work-item-id 12345 --hours 2 --column Active --date 2026-06-25
  npm start -- --apply --work-item-id 12345 --hours 2 --column Active --date 2026-06-25
  npm start -- --command-json '{ "workItemId": 12345, "personName": "Fulano", "completedWorkDelta": 2, "remainingWorkDelta": -2, "targetState": "Active", "targetBoardColumn": null, "workDate": "2026-06-25", "comment": null, "confidence": 1, "needsConfirmation": false, "missingFields": [] }'

Opcoes:
  --list                    Lista cards atribuidos (sem gravar).
  --fill-sprint             Distribui horas pelos dias uteis da sprint, enchendo ate
                            8h/dia e pulando dias ja ocupados. Sem --id, pega todos
                            os cards abertos da pessoa na sprint. Usa o trabalho
                            restante; se ausente, divide as horas livres pelo total
                            de cards. --id aceita lista separada por virgula.
                            --hours vira um teto total.
                            Com --state/--column, o ultimo lancamento de cada card
                            muda o estado e zera o trabalho restante.
  --create-tasks            Le uma user story e planeja/cria tarefas filhas por fase.
                            Padrao: develop,homologation,deployment. Simulacao por padrao.
  --user-story-id, --story-id ID da user story que recebera as tarefas. --id tambem funciona.
  --phases                  Fases separadas por virgula: develop, homologation, deployment.
  --task-type               Tipo do work item filho; este fluxo aceita somente Task.
  --task-person, --assign-to Responsavel dos novos cards. Sem ele, herda a user story.
  --sprint                  Sprint alvo (ex.: "2026 W24") ou "atual" para detectar
                            a corrente pela area dos seus proprios cards.
  --timebox-setup           Tenta o modo automatico legado, apenas para backends que
                            ainda aceitam token gerado localmente.
  --timebox-token <jwt>     Liga colando o token do navegador (header Authorization do
                            F12->Network). Caminho suportado pelo backend atual.
  --timebox-status          Mostra se a integracao Time Box esta funcionando.
  --month, --mes AAAA-MM    Mostra o mes dia a dia pelo Time Box, destacando dias
                            incompletos e qualquer total acima de 8h.
  --status                  Filtra a listagem por status, depois da sprint.
                            Ex.: --status Active | --status New,Active | --status todos
                            Sem ele, lista os abertos (esconde Closed).
  --today                   Finge outra data ao detectar a sprint corrente (AAAA-MM-DD).
  --include-closed          Inclui cards fechados na listagem.
  --dry-run                 Planeja a alteracao sem gravar. Padrao.
  --apply                   Aplica a alteracao no Azure DevOps/TFS.
  --command-json            Comando estruturado gerado pelo Claude CLI.
  --work-item-id, --id      ID numerico do card/work item.
  --person                  Nome ou alias mapeado em config/identities.json.
  --hours                   Horas a adicionar em Completed Work.
  --remaining-delta         Delta de Remaining Work. Padrao: negativo de --hours.
  --state                   Estado de workflow desejado.
  --board-column, --column  Coluna do taskboard (ex.: "Code Review"); vira o estado mapeado.
  --date, --work-date       Data das horas (AAAA-MM-DD); padrao hoje. Registrada no historico.
  --comment                 Comentario para System.History e Timebox.
  --needs-confirmation      Marca comando como dependente de confirmacao.
  --missing-fields          Lista separada por virgulas.
  --help, -h                Mostra esta ajuda.
`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
