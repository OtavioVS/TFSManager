import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WorkItemService,
  buildPatchOperations,
  summarizeChanges,
  validateDailyHours
} from "../src/work-items/service.js";

const workItem = {
  id: 12345,
  rev: 7,
  fields: {
    "System.Title": "Implementar API",
    "System.State": "New",
    "System.BoardColumn": "New",
    "Microsoft.VSTS.Scheduling.CompletedWork": 1,
    "Microsoft.VSTS.Scheduling.RemainingWork": 5
  }
};

test("buildPatchOperations creates revision-safe update", () => {
  const operations = buildPatchOperations(workItem, {
    completedWorkDelta: 2,
    remainingWorkDelta: -2,
    targetState: "Active",
    targetBoardColumn: "Doing",
    personName: "Max",
    comment: null
  });

  assert.deepEqual(operations[0], { op: "test", path: "/rev", value: 7 });
  assert.deepEqual(operations[1], {
    op: "add",
    path: "/fields/Microsoft.VSTS.Scheduling.CompletedWork",
    value: 3
  });
  assert.deepEqual(operations[2], {
    op: "add",
    path: "/fields/Microsoft.VSTS.Scheduling.RemainingWork",
    value: 3
  });
  assert.equal(operations.at(-1).path, "/fields/System.History");
});

test("buildPatchOperations records work date and skips board column field", () => {
  const operations = buildPatchOperations(workItem, {
    completedWorkDelta: 2,
    remainingWorkDelta: -2,
    targetState: "Resolved",
    targetBoardColumn: "Code Review",
    workDate: "2026-06-25",
    personName: "Max",
    comment: null
  });

  const history = operations.at(-1);
  assert.equal(history.path, "/fields/System.History");
  assert.match(history.value, /2026-06-25/);
  assert.equal(operations.some((op) => op.path === "/fields/System.BoardColumn"), false);
  assert.equal(
    operations.some((op) => op.path === "/fields/System.State" && op.value === "Resolved"),
    true
  );
});

test("summarizeChanges shows before and after values", () => {
  const changes = summarizeChanges(workItem, {
    completedWorkDelta: 1.5,
    remainingWorkDelta: -1.5,
    targetState: "Active",
    targetBoardColumn: null
  });

  assert.deepEqual(changes.completedWork, { from: 1, to: 2.5 });
  assert.deepEqual(changes.remainingWork, { from: 5, to: 3.5 });
  assert.deepEqual(changes.state, { from: "New", to: "Active" });
});



test("WorkItemService blocks daily total above maxHoursPerDay before loading work item", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azdo-time-service-daily-"));
  const logPath = path.join(dir, "audit.jsonl");
  fs.writeFileSync(
    logPath,
    `${JSON.stringify({
      mode: "apply",
      command: { personName: "Max", workDate: "2026-06-25", completedWorkDelta: 6 },
      result: { ok: true }
    })}\n`,
    "utf8"
  );

  let loadedWorkItem = false;
  const service = new WorkItemService({
    azureDevOpsClient: {
      getWorkItem: async () => {
        loadedWorkItem = true;
        return workItem;
      }
    },
    config: serviceConfig({ auditLogPath: logPath })
  });

  const result = await service.plan({
    workItemId: 12345,
    personName: "Max",
    completedWorkDelta: 3,
    remainingWorkDelta: null,
    targetState: null,
    targetBoardColumn: null,
    workDate: "2026-06-25",
    comment: null,
    needsConfirmation: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, "daily-hours-validation");
  assert.equal(loadedWorkItem, false);
  assert.match(result.errors[0], /Limite diario excedido/);
});
test("WorkItemService plan includes Timebox payload when enabled", async () => {
  let requestedFields = [];
  const service = new WorkItemService({
    azureDevOpsClient: {
      getWorkItem: async (_id, fields) => {
        requestedFields = fields;
        return {
          ...workItem,
          fields: {
            ...workItem.fields,
            "System.AreaPath": "LCB-TI\\Squad",
            "System.AssignedTo": { displayName: "Max", uniqueName: "max@empresa.com" },
            "Custom.Demand": "DMND0131165"
          }
        };
      }
    },
    timeboxClient: {
      searchAppointments: async () => []
    },
    config: serviceConfig({ timeboxEnabled: true })
  });

  const result = await service.plan({
    workItemId: 12345,
    personName: "Max",
    completedWorkDelta: 2,
    remainingWorkDelta: null,
    targetState: null,
    targetBoardColumn: null,
    workDate: "2026-06-25",
    comment: "feito",
    needsConfirmation: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.timebox.appointment.workedMinutes, 120);
  assert.equal(result.timebox.appointment.workedWeek, "2026-26");
  assert.equal(result.timebox.workItem.demandNumber, "DMND0131165");
  assert.equal(requestedFields.includes("System.AreaPath"), true);
  assert.equal(requestedFields.includes("Custom.Demand"), true);
});

test("WorkItemService reports partial failure when Timebox apply fails", async () => {
  const service = new WorkItemService({
    azureDevOpsClient: {
      getWorkItem: async () => ({
        ...workItem,
        fields: {
          ...workItem.fields,
          "System.AreaPath": "LCB-TI\\Squad",
          "System.AssignedTo": { displayName: "Max", uniqueName: "max@empresa.com" }
        }
      }),
      updateWorkItem: async () => ({ ...workItem, rev: 8, fields: workItem.fields })
    },
    timeboxClient: {
      searchAppointments: async () => [],
      createTimeLog: async () => {
        throw new Error("Timebox fora do ar");
      }
    },
    config: serviceConfig({ timeboxEnabled: true })
  });

  const result = await service.apply({
    workItemId: 12345,
    personName: "Max",
    completedWorkDelta: 1,
    remainingWorkDelta: null,
    targetState: null,
    targetBoardColumn: null,
    workDate: "2026-06-25",
    comment: null,
    needsConfirmation: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, "applied-with-timebox-error");
  assert.equal(result.updatedWorkItem.rev, 8);
  assert.match(result.timebox.error, /Timebox fora do ar/);
});

test("WorkItemService blocks a duplicate day using hours already in Timebox", async () => {
  let loadedWorkItem = false;
  const service = new WorkItemService({
    azureDevOpsClient: {
      getWorkItem: async () => {
        loadedWorkItem = true;
        return workItem;
      }
    },
    timeboxClient: {
      searchAppointments: async () => [
        {
          workItemId: 12345,
          userId: "timebox-user-id",
          workedAt: "2026-07-20T00:00:00",
          workedMinutes: 480
        }
      ]
    },
    config: serviceConfig({ timeboxEnabled: true })
  });

  const result = await service.plan({
    workItemId: 12345,
    personName: "Max",
    completedWorkDelta: 8,
    remainingWorkDelta: null,
    targetState: null,
    targetBoardColumn: null,
    workDate: "2026-07-20",
    comment: null,
    needsConfirmation: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, "daily-hours-validation");
  assert.equal(result.dailyHours.timeboxHours, 8);
  assert.equal(result.dailyHours.nextTotal, 16);
  assert.equal(loadedWorkItem, false);
  assert.match(result.errors[0], /8h ja lancadas no Time Box/);
});

test("Azure current history is authoritative over local audit and Timebox", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azdo-time-service-authority-"));
  const logPath = path.join(dir, "audit.jsonl");
  fs.writeFileSync(
    logPath,
    `${JSON.stringify({
      mode: "apply",
      command: { personName: "Max", workDate: "2026-07-21", completedWorkDelta: 8 },
      result: { ok: true, stage: "applied" }
    })}\n`,
    "utf8"
  );

  const result = await validateDailyHours(
    {
      workItemId: 12345,
      personName: "Max",
      completedWorkDelta: 8,
      workDate: "2026-07-21"
    },
    serviceConfig({ timeboxEnabled: true, auditLogPath: logPath }),
    { searchAppointments: async () => [] },
    {
      getWorkItem: async () => ({
        fields: { "Microsoft.VSTS.Scheduling.CompletedWork": 0 }
      }),
      getWorkItemUpdates: async () => ({ value: [] })
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.details.azureHours, 0);
  assert.equal(result.details.auditHours, 8);
  assert.equal(result.details.hoursSource, "azure");
});

test("Azure daily history blocks a duplicate even when local and Timebox are empty", async () => {
  const result = await validateDailyHours(
    {
      workItemId: 12345,
      personName: "Max",
      completedWorkDelta: 8,
      workDate: "2026-07-21"
    },
    serviceConfig({ timeboxEnabled: true }),
    { searchAppointments: async () => [] },
    {
      getWorkItem: async () => ({
        fields: { "Microsoft.VSTS.Scheduling.CompletedWork": 8 }
      }),
      getWorkItemUpdates: async () => ({
        value: [{
          revisedDate: "2026-07-21T10:00:00Z",
          fields: {
            "Microsoft.VSTS.Scheduling.CompletedWork": { oldValue: 0, newValue: 8 },
            "System.History": { newValue: "Apontamento (Refere-se ao dia 2026-07-21.)" }
          }
        }]
      })
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.details.azureHours, 8);
  assert.equal(result.details.hoursSource, "azure");
  assert.match(result.errors[0], /8h ja lancadas no Azure DevOps/);
});

test("WorkItemService fails closed when Timebox cannot be checked", async () => {
  const service = new WorkItemService({
    azureDevOpsClient: {
      getWorkItem: async () => {
        throw new Error("nao deveria carregar o card");
      }
    },
    timeboxClient: {
      searchAppointments: async () => {
        throw new Error("API indisponivel");
      }
    },
    config: serviceConfig({ timeboxEnabled: true })
  });

  const result = await service.plan({
    workItemId: 12345,
    personName: "Max",
    completedWorkDelta: 1,
    remainingWorkDelta: null,
    targetState: null,
    targetBoardColumn: null,
    workDate: "2026-07-21",
    comment: null,
    needsConfirmation: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, "daily-hours-validation");
  assert.match(result.errors[0], /API indisponivel/);
  assert.match(result.errors[0], /Nada foi gravado/);
});

function serviceConfig({ timeboxEnabled = false, auditLogPath = "" } = {}) {
  return {
    azureDevOps: {
      allowedStates: ["New", "Active", "Resolved", "Closed"],
      taskboardColumnMap: {},
      requireAssignedToMatch: true,
      demandNumberField: "Custom.Demand"
    },
    policy: {
      identities: {
        Max: {
          displayName: "Max",
          azureDevOpsEmail: "max@empresa.com",
          aliases: ["max"]
        }
      },
      maxHoursPerCommand: 8,
      maxHoursPerDay: 8,
      requireConfirmation: false
    },
    audit: {
      logPath: auditLogPath
    },
    timebox: {
      enabled: timeboxEnabled,
      user: { id: "timebox-user-id" }
    }
  };
}
