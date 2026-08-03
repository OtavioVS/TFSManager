import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIdentity, validateParsedCommand, validateWorkItemOwnership } from "../src/work-items/policy.js";

const config = {
  azureDevOps: {
    allowedStates: ["New", "Active", "Resolved", "Closed"],
    allowedBoardColumns: ["New", "Active", "Code Review", "Closed"],
    taskboardColumnMap: {
      new: { name: "New", state: "New" },
      active: { name: "Active", state: "Active" },
      "code review": { name: "Code Review", state: "Resolved" },
      closed: { name: "Closed", state: "Closed" }
    },
    requireAssignedToMatch: true
  },
  policy: {
    maxHoursPerCommand: 8,
    identities: {
      Max: {
        displayName: "Max",
        azureDevOpsEmail: "max@empresa.com",
        aliases: ["max", "eu", "pra mim"]
      }
    }
  }
};

test("normalizeIdentity resolves aliases", () => {
  assert.equal(normalizeIdentity("pra mim", config.policy.identities).azureDevOpsEmail, "max@empresa.com");
});

function comandoValido(extra = {}) {
  return {
    workItemId: 123,
    personName: "Max",
    completedWorkDelta: 4,
    remainingWorkDelta: -4,
    targetState: null,
    targetBoardColumn: null,
    needsConfirmation: false,
    ...extra
  };
}

test("validateParsedCommand warns about hours on a future day", () => {
  const validation = validateParsedCommand(comandoValido({ workDate: "2026-07-21" }), {
    ...config,
    policy: { ...config.policy, today: "2026-07-20" }
  });

  assert.equal(validation.ok, true, "por padrao so avisa, nao bloqueia");
  assert.ok(
    validation.warnings.some((aviso) => /futura/i.test(aviso)),
    `esperava aviso de data futura, veio: ${JSON.stringify(validation.warnings)}`
  );
});

test("validateParsedCommand does not warn for today or past days", () => {
  for (const dia of ["2026-07-20", "2026-07-19"]) {
    const validation = validateParsedCommand(comandoValido({ workDate: dia }), {
      ...config,
      policy: { ...config.policy, today: "2026-07-20" }
    });

    assert.ok(!validation.warnings.some((aviso) => /futura/i.test(aviso)), `${dia} nao e futuro`);
  }
});

test("validateParsedCommand blocks future days when allowFutureHours is off", () => {
  const validation = validateParsedCommand(comandoValido({ workDate: "2026-07-21" }), {
    ...config,
    policy: { ...config.policy, today: "2026-07-20", allowFutureHours: false }
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((erro) => /futura/i.test(erro)));
});

test("validateParsedCommand blocks invalid hours and states", () => {
  const validation = validateParsedCommand(
    {
      workItemId: 123,
      personName: "Max",
      completedWorkDelta: 12,
      remainingWorkDelta: -12,
      targetState: "Invalid",
      targetBoardColumn: null,
      needsConfirmation: false
    },
    config
  );

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join(" "), /MAX_HOURS_PER_COMMAND/);
  assert.match(validation.errors.join(" "), /targetState invalido/);
});

test("validateParsedCommand resolves taskboard column to its state", () => {
  const validation = validateParsedCommand(
    {
      workItemId: 1070143,
      personName: "Max",
      completedWorkDelta: 2,
      remainingWorkDelta: null,
      targetState: null,
      targetBoardColumn: "Code Review",
      workDate: "2026-06-25",
      needsConfirmation: false
    },
    config
  );

  assert.equal(validation.ok, true);
  assert.equal(validation.effectiveState, "Resolved");
  assert.equal(validation.resolvedColumn.name, "Code Review");
});

test("validateParsedCommand rejects unknown column and bad date", () => {
  const validation = validateParsedCommand(
    {
      workItemId: 1070143,
      personName: "Max",
      completedWorkDelta: 2,
      remainingWorkDelta: null,
      targetState: null,
      targetBoardColumn: "Inexistente",
      workDate: "25/06/2026",
      needsConfirmation: false
    },
    config
  );

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join(" "), /coluna invalida/);
  assert.match(validation.errors.join(" "), /workDate invalida/);
});

test("validateWorkItemOwnership accepts matching assigned user", () => {
  const workItem = {
    fields: {
      "System.AssignedTo": {
        displayName: "Max",
        uniqueName: "max@empresa.com"
      }
    }
  };

  const identity = normalizeIdentity("eu", config.policy.identities);
  assert.equal(validateWorkItemOwnership(workItem, identity, true).ok, true);
});

test("validateWorkItemOwnership blocks different assigned user", () => {
  const workItem = {
    fields: {
      "System.AssignedTo": {
        displayName: "Outra Pessoa",
        uniqueName: "outra@empresa.com"
      }
    }
  };

  const identity = normalizeIdentity("Max", config.policy.identities);
  const validation = validateWorkItemOwnership(workItem, identity, true);
  assert.equal(validation.ok, false);
  assert.match(validation.errors[0], /Outra Pessoa/);
});

