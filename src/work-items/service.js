import { WORK_ITEM_FIELDS } from "../azure-devops/client.js";
import { sumAppliedHoursForDay } from "../audit/dailyHours.js";
import { hoursByDayFromUpdates } from "../audit/tfsHistory.js";
import { buildTimeboxPlan } from "../timebox/client.js";
import { hoursByDayFromAppointments } from "../timebox/summary.js";
import { validateParsedCommand, validateWorkItemOwnership } from "./policy.js";

const COMPLETED_WORK = "Microsoft.VSTS.Scheduling.CompletedWork";
const REMAINING_WORK = "Microsoft.VSTS.Scheduling.RemainingWork";
const STATE = "System.State";
const BOARD_COLUMN = "System.BoardColumn";
const HISTORY = "System.History";
const AREA_PATH = "System.AreaPath";

export class WorkItemService {
  constructor({ azureDevOpsClient, timeboxClient = null, config }) {
    this.azureDevOpsClient = azureDevOpsClient;
    this.timeboxClient = timeboxClient;
    this.config = config;
  }

  async plan(command) {
    const commandValidation = validateParsedCommand(command, this.config);
    if (!commandValidation.ok) {
      return {
        ok: false,
        stage: "command-validation",
        errors: commandValidation.errors,
        warnings: commandValidation.warnings
      };
    }

    const dailyValidation = await validateDailyHours(
      command,
      this.config,
      this.timeboxClient,
      this.azureDevOpsClient
    );
    if (!dailyValidation.ok) {
      return {
        ok: false,
        stage: "daily-hours-validation",
        errors: dailyValidation.errors,
        warnings: [...commandValidation.warnings, ...dailyValidation.warnings],
        dailyHours: dailyValidation.details
      };
    }

    const workItem = await this.azureDevOpsClient.getWorkItem(command.workItemId, buildWorkItemFields(this.config));
    const ownership = validateWorkItemOwnership(
      workItem,
      commandValidation.identity,
      this.config.azureDevOps.requireAssignedToMatch
    );
    if (!ownership.ok) {
      return {
        ok: false,
        stage: "ownership-validation",
        errors: ownership.errors,
        warnings: commandValidation.warnings,
        workItem: summarizeWorkItem(workItem)
      };
    }

    // A coluna do taskboard ja foi resolvida para um estado pela politica.
    const effectiveCommand = { ...command, targetState: commandValidation.effectiveState };
    const operations = buildPatchOperations(workItem, effectiveCommand);
    const result = {
      ok: true,
      stage: "planned",
      warnings: [...commandValidation.warnings, ...dailyValidation.warnings],
      command,
      identity: commandValidation.identity,
      dailyHours: dailyValidation.details,
      ...(commandValidation.resolvedColumn
        ? { columnResolution: { column: commandValidation.resolvedColumn.name, state: commandValidation.resolvedColumn.state } }
        : {}),
      workItem: summarizeWorkItem(workItem),
      changes: summarizeChanges(workItem, effectiveCommand),
      operations
    };

    if (this.config.timebox.enabled) {
      result.timebox = buildTimeboxPlan({
        command,
        workItem,
        config: this.config,
        comment: buildComment(command)
      });
    }

    return result;
  }

  async apply(command) {
    const plan = await this.plan(command);
    if (!plan.ok) {
      return plan;
    }

    const updatedWorkItem = await this.azureDevOpsClient.updateWorkItem(command.workItemId, plan.operations);
    const applied = {
      ...plan,
      stage: "applied",
      updatedWorkItem: summarizeWorkItem(updatedWorkItem)
    };

    if (plan.timebox?.enabled && this.timeboxClient) {
      try {
        applied.timebox = {
          ...plan.timebox,
          stage: "applied",
          result: await this.timeboxClient.createTimeLog(plan.timebox, {
            maxHoursPerDay: this.config.policy?.maxHoursPerDay
          })
        };
      } catch (error) {
        return {
          ...applied,
          ok: false,
          stage: "applied-with-timebox-error",
          timebox: {
            ...plan.timebox,
            stage: "failed",
            error: error.message
          }
        };
      }
    }

    return applied;
  }
}

export function buildPatchOperations(workItem, command) {
  const fields = workItem.fields || {};
  const currentCompleted = toNumber(fields[COMPLETED_WORK], 0);
  const currentRemaining = toNullableNumber(fields[REMAINING_WORK]);
  const remainingDelta =
    command.remainingWorkDelta === null || command.remainingWorkDelta === undefined
      ? -command.completedWorkDelta
      : command.remainingWorkDelta;

  const operations = [
    {
      op: "test",
      path: "/rev",
      value: workItem.rev
    },
    {
      op: "add",
      path: `/fields/${COMPLETED_WORK}`,
      value: roundHours(currentCompleted + command.completedWorkDelta)
    }
  ];

  // Ao concluir o card o trabalho restante vai a zero, independente do delta.
  if (command.forceRemainingZero) {
    operations.push({
      op: "add",
      path: `/fields/${REMAINING_WORK}`,
      value: 0
    });
  } else if (currentRemaining !== null || command.remainingWorkDelta !== null) {
    operations.push({
      op: "add",
      path: `/fields/${REMAINING_WORK}`,
      value: roundHours(Math.max(0, (currentRemaining ?? 0) + remainingDelta))
    });
  }

  if (command.targetState) {
    operations.push({
      op: "add",
      path: `/fields/${STATE}`,
      value: command.targetState
    });
  }

  operations.push({
    op: "add",
    path: `/fields/${HISTORY}`,
    value: buildComment(command)
  });

  return operations;
}

export function summarizeChanges(workItem, command) {
  const fields = workItem.fields || {};
  const currentCompleted = toNumber(fields[COMPLETED_WORK], 0);
  const currentRemaining = toNullableNumber(fields[REMAINING_WORK]);
  const remainingDelta =
    command.remainingWorkDelta === null || command.remainingWorkDelta === undefined
      ? -command.completedWorkDelta
      : command.remainingWorkDelta;

  const changes = {
    completedWork: {
      from: currentCompleted,
      to: roundHours(currentCompleted + command.completedWorkDelta)
    }
  };

  if (command.forceRemainingZero) {
    changes.remainingWork = { from: currentRemaining ?? 0, to: 0 };
  } else if (currentRemaining !== null || command.remainingWorkDelta !== null) {
    changes.remainingWork = {
      from: currentRemaining ?? 0,
      to: roundHours(Math.max(0, (currentRemaining ?? 0) + remainingDelta))
    };
  }

  if (command.targetState) {
    changes.state = {
      from: fields[STATE] ?? null,
      to: command.targetState
    };
  }

  return changes;
}

export function summarizeWorkItem(workItem) {
  const fields = workItem.fields || {};
  return {
    id: workItem.id,
    rev: workItem.rev,
    title: fields["System.Title"] || null,
    areaPath: fields[AREA_PATH] || null,
    assignedTo: formatAssignedTo(fields["System.AssignedTo"]),
    state: fields[STATE] || null,
    boardColumn: fields[BOARD_COLUMN] || null,
    completedWork: fields[COMPLETED_WORK] ?? null,
    remainingWork: fields[REMAINING_WORK] ?? null
  };
}

export function buildComment(command) {
  const base = command.comment
    ? command.comment
    : defaultComment(command);

  if (command.workDate) {
    return `${base} (Refere-se ao dia ${command.workDate}.)`;
  }
  return base;
}

export async function validateDailyHours(
  command,
  config,
  timeboxClient = null,
  azureDevOpsClient = null
) {
  const maxHoursPerDay = Number(config.policy?.maxHoursPerDay);
  if (!Number.isFinite(maxHoursPerDay) || maxHoursPerDay <= 0 || !command.workDate) {
    return { ok: true, errors: [], warnings: [], details: null };
  }

  const auditHours = roundHours(sumAppliedHoursForDay(config.audit?.logPath, {
    personName: command.personName,
    workDate: command.workDate
  }));

  const azure = await readAzureHoursForDay(azureDevOpsClient, command);
  const azureHours = azure.available ? azure.hours : null;
  let timeboxHours = null;
  const warnings = [];
  if (config.timebox?.enabled) {
    if (!timeboxClient || typeof timeboxClient.searchAppointments !== "function") {
      if (!azure.available) {
        return {
          ok: false,
          errors: [
            "Time Box esta ligado, mas nao foi possivel consultar os apontamentos existentes e o Azure DevOps tambem nao pode ser consultado. Nada foi gravado."
          ],
          warnings: [],
          details: {
            workDate: command.workDate,
            auditHours,
            azureHours: null,
            hoursSource: "none",
            timeboxHours: null,
            maxHoursPerDay
          }
        };
      }
      warnings.push("Time Box nao foi consultado; o Azure DevOps permanece como fonte da verdade.");
    } else {
      try {
        const appointments = await timeboxClient.searchAppointments({
          userId: config.timebox.user?.id,
          startedAt: command.workDate,
          endedAt: command.workDate
        });
        timeboxHours = roundHours(hoursByDayFromAppointments(appointments)[command.workDate] || 0);
      } catch (error) {
        if (!azure.available) {
          return {
            ok: false,
            errors: [
              `Nao foi possivel validar as horas de ${command.workDate} no Time Box: ${error.message}. Nada foi gravado.`
            ],
            warnings: [],
            details: {
              workDate: command.workDate,
              auditHours,
              azureHours: null,
              hoursSource: "none",
              timeboxHours: null,
              maxHoursPerDay
            }
          };
        }
        warnings.push(`Time Box nao foi consultado (${error.message}); o Azure DevOps permanece como fonte da verdade.`);
      }
    }
  }

  const hoursSource = azure.available
    ? "azure"
    : timeboxHours !== null && timeboxHours > auditHours
      ? "timebox"
      : "audit";
  const alreadyLogged = azure.available
    ? azureHours
    : roundHours(Math.max(auditHours, timeboxHours ?? 0));
  const nextTotal = roundHours(alreadyLogged + command.completedWorkDelta);
  const details = {
    workDate: command.workDate,
    auditHours,
    azureHours,
    hoursSource,
    timeboxHours,
    alreadyLogged,
    requestedHours: command.completedWorkDelta,
    nextTotal,
    maxHoursPerDay
  };

  if (nextTotal > maxHoursPerDay) {
    const sourceLabel = hoursSource === "azure"
      ? "no Azure DevOps"
      : hoursSource === "timebox"
        ? "no Time Box"
        : "no historico local";
    return {
      ok: false,
      errors: [
        `Limite diario excedido em ${command.workDate}: ${alreadyLogged}h ja lancadas` +
          ` ${sourceLabel}, +${command.completedWorkDelta}h passaria de ${maxHoursPerDay}h.`
      ],
      warnings,
      details
    };
  }

  return { ok: true, errors: [], warnings, details };
}

async function readAzureHoursForDay(azureDevOpsClient, command) {
  if (
    !azureDevOpsClient ||
    typeof azureDevOpsClient.getWorkItem !== "function" ||
    typeof azureDevOpsClient.getWorkItemUpdates !== "function"
  ) {
    return { available: false, hours: null };
  }

  try {
    const workItem = await azureDevOpsClient.getWorkItem(command.workItemId, [COMPLETED_WORK]);
    const updates = await azureDevOpsClient.getWorkItemUpdates(command.workItemId);
    const currentCompleted = toNumber(workItem?.fields?.[COMPLETED_WORK], 0);
    const byDay = hoursByDayFromUpdates(updates?.value || [], { currentCompleted });
    return {
      available: true,
      hours: roundHours(byDay[command.workDate]?.hours || 0)
    };
  } catch {
    return { available: false, hours: null };
  }
}

function buildWorkItemFields(config) {
  const fields = [...WORK_ITEM_FIELDS, AREA_PATH];
  const demandNumberField = config.azureDevOps.demandNumberField;
  if (demandNumberField) {
    fields.push(demandNumberField);
  }

  return [...new Set(fields)];
}

function defaultComment(command) {
  const parts = [`Apontamento automatizado: +${command.completedWorkDelta}h`];
  if (command.personName) {
    parts.push(`para ${command.personName}`);
  }
  return `${parts.join(" ")}.`;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundHours(value) {
  return Math.round(value * 100) / 100;
}

function formatAssignedTo(assignedTo) {
  if (!assignedTo) {
    return null;
  }

  if (typeof assignedTo === "string") {
    return assignedTo;
  }

  return assignedTo.displayName || assignedTo.uniqueName || null;
}
