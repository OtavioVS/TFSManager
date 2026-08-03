import { isFutureDay } from "./sprint.js";

export function validateParsedCommand(command, config) {
  const errors = [];
  const warnings = [];
  const azureDevOps = config.azureDevOps || {};

  if (!Number.isInteger(command.workItemId) || command.workItemId <= 0) {
    errors.push("workItemId ausente ou invalido.");
  }

  if (!command.personName) {
    errors.push("personName ausente.");
  }

  if (!Number.isFinite(command.completedWorkDelta) || command.completedWorkDelta <= 0) {
    errors.push("completedWorkDelta deve ser maior que zero.");
  }

  if (
    Number.isFinite(command.completedWorkDelta) &&
    command.completedWorkDelta > config.policy.maxHoursPerCommand
  ) {
    errors.push(`completedWorkDelta excede MAX_HOURS_PER_COMMAND (${config.policy.maxHoursPerCommand}).`);
  }

  if (command.remainingWorkDelta !== null && command.remainingWorkDelta > 0) {
    errors.push("remainingWorkDelta nao pode aumentar trabalho restante automaticamente.");
  }

  // Resolve o estado efetivo: a coluna do taskboard (ex.: "Code Review") vira um
  // estado (ex.: "Resolved"). targetState explicito tambem e aceito.
  const resolution = resolveTargetState(command, azureDevOps.taskboardColumnMap || {});
  errors.push(...resolution.errors);
  const effectiveState = resolution.state;

  if (effectiveState && !matchesAllowed(effectiveState, azureDevOps.allowedStates)) {
    errors.push(`targetState invalido: ${effectiveState}.`);
  }

  if (command.workDate && !/^\d{4}-\d{2}-\d{2}$/.test(command.workDate)) {
    errors.push(`workDate invalida, use AAAA-MM-DD: ${command.workDate}.`);
  }

  // Hora em dia que ainda nao aconteceu: avisa por padrao, bloqueia se configurado.
  if (command.workDate && isFutureDay(command.workDate, config.policy?.today)) {
    if (config.policy?.allowFutureHours === false) {
      errors.push(`Data futura: ${command.workDate} ainda nao aconteceu (ALLOW_FUTURE_HOURS=false).`);
    } else {
      warnings.push(`ATENCAO: ${command.workDate} e uma data futura; o trabalho ainda nao aconteceu.`);
    }
  }

  const identity = normalizeIdentity(command.personName, config.policy.identities);
  if (!identity) {
    warnings.push(`Identidade nao mapeada: ${command.personName}.`);
  }

  if (command.needsConfirmation || config.policy.requireConfirmation) {
    warnings.push("Confirmacao requerida antes de aplicar.");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    identity,
    effectiveState,
    resolvedColumn: resolution.column
  };
}

function resolveTargetState(command, columnMap) {
  const errors = [];
  let state = command.targetState || null;
  let column = null;

  if (command.targetBoardColumn) {
    const entry = columnMap[normalizeText(command.targetBoardColumn)];
    if (!entry) {
      const validas = Object.values(columnMap).map((item) => item.name);
      const sufixo = validas.length > 0 ? ` Validas: ${validas.join(", ")}.` : "";
      errors.push(`coluna invalida: ${command.targetBoardColumn}.${sufixo}`);
    } else {
      column = entry;
      if (state && normalizeText(state) !== normalizeText(entry.state)) {
        errors.push(
          `conflito entre targetState (${command.targetState}) e a coluna ${entry.name} (estado ${entry.state}).`
        );
      } else {
        state = entry.state;
      }
    }
  }

  return { state, column, errors };
}

export function validateWorkItemOwnership(workItem, identity, requireAssignedToMatch) {
  if (!requireAssignedToMatch || !identity) {
    return { ok: true, errors: [] };
  }

  const assignedTo = getAssignedTo(workItem);
  if (!assignedTo) {
    return { ok: false, errors: ["Card sem System.AssignedTo; nao da para validar responsavel."] };
  }

  const expected = [identity.azureDevOpsEmail, identity.displayName, ...(identity.aliases || [])]
    .filter(Boolean)
    .map(normalizeText);

  const actual = [assignedTo.displayName, assignedTo.uniqueName, assignedTo.email, assignedTo]
    .filter(Boolean)
    .map((value) => (typeof value === "string" ? value : ""))
    .filter(Boolean)
    .map(normalizeText);

  const matches = actual.some((value) => expected.includes(value));
  return matches
    ? { ok: true, errors: [] }
    : { ok: false, errors: [`Card atribuido a ${formatAssignedTo(assignedTo)}, nao a ${identity.displayName}.`] };
}

export function normalizeIdentity(personName, identities = {}) {
  if (!personName) {
    return null;
  }

  const normalized = normalizeText(personName);
  for (const [key, value] of Object.entries(identities)) {
    const aliases = [key, value.displayName, value.azureDevOpsEmail, ...(value.aliases || [])]
      .filter(Boolean)
      .map(normalizeText);

    if (aliases.includes(normalized)) {
      return {
        key,
        displayName: value.displayName || key,
        azureDevOpsEmail: value.azureDevOpsEmail || "",
        aliases: value.aliases || []
      };
    }
  }

  return null;
}

function matchesAllowed(value, allowedValues) {
  if (!allowedValues || allowedValues.length === 0) {
    return true;
  }

  const normalized = normalizeText(value);
  return allowedValues.map(normalizeText).includes(normalized);
}

function getAssignedTo(workItem) {
  return workItem?.fields?.["System.AssignedTo"];
}

function formatAssignedTo(assignedTo) {
  if (typeof assignedTo === "string") {
    return assignedTo;
  }

  return assignedTo?.displayName || assignedTo?.uniqueName || "desconhecido";
}

function normalizeText(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

