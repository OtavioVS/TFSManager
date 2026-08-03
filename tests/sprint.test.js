import test from "node:test";
import assert from "node:assert/strict";
import {
  findSprintWindow,
  isFutureDay,
  listBusinessDays,
  normalizeIterationPath,
  parentOfIterationPath,
  pickSprintForDate,
  planSprintAllocation,
  resolveSprintCardHours,
  resolveCurrentSprint,
  sprintNameFromIterationPath
} from "../src/work-items/sprint.js";

// Duas areas com sprints de mesmo nome, como acontece de verdade no TFS: uma serie
// par (Safety Hub) e uma impar (Outro Time).
const ARVORE = {
  name: "LCB-TI",
  path: "\\LCB-TI\\Iteration",
  children: [
    {
      name: "Safety Hub",
      path: "\\LCB-TI\\Iteration\\GPM\\Safety Hub",
      children: [
        { name: "2026 W24", path: "\\LCB-TI\\Iteration\\GPM\\Safety Hub\\2026 W24", attributes: { startDate: "2026-06-08T00:00:00Z", finishDate: "2026-06-19T00:00:00Z" } },
        { name: "2026 W30", path: "\\LCB-TI\\Iteration\\GPM\\Safety Hub\\2026 W30", attributes: { startDate: "2026-07-20T00:00:00Z", finishDate: "2026-07-31T00:00:00Z" } }
      ]
    },
    {
      name: "Outro Time",
      path: "\\LCB-TI\\Iteration\\Comercial\\Outro Time",
      children: [
        { name: "2026 W24", path: "\\LCB-TI\\Iteration\\Comercial\\Outro Time\\2026 W24", attributes: { startDate: "2026-06-01T00:00:00Z", finishDate: "2026-06-12T00:00:00Z" } },
        { name: "2026 W29", path: "\\LCB-TI\\Iteration\\Comercial\\Outro Time\\2026 W29", attributes: { startDate: "2026-07-16T00:00:00Z", finishDate: "2026-07-29T00:00:00Z" } }
      ]
    }
  ]
};

const CARDS_DO_USUARIO = [
  "LCB-TI\\GPM\\Safety Hub\\2026 W24",
  "LCB-TI\\GPM\\Safety Hub\\2026 W24",
  "LCB-TI\\GPM\\Safety Hub\\2026 W30"
];

const NODES = {
  name: "Safety Hub",
  children: [
    { name: "2026 W22", attributes: { startDate: "2026-05-25T00:00:00Z", finishDate: "2026-06-05T00:00:00Z" } },
    { name: "2026 W24", attributes: { startDate: "2026-06-08T00:00:00Z", finishDate: "2026-06-19T00:00:00Z" } },
    { name: "2026 W26", attributes: {} }
  ]
};

test("sprintNameFromIterationPath takes the leaf of the iteration path", () => {
  assert.equal(sprintNameFromIterationPath("LCB-TI\\GPM\\Safety Hub\\2026 W24"), "2026 W24");
  assert.equal(sprintNameFromIterationPath("LCB-TI/GPM/Safety Hub/2026 W26"), "2026 W26");
  assert.equal(sprintNameFromIterationPath(""), null);
});

test("findSprintWindow reads the real window from the TFS iteration tree", () => {
  assert.deepEqual(findSprintWindow(NODES, "2026 W24"), {
    name: "2026 W24",
    startDate: "2026-06-08",
    finishDate: "2026-06-19"
  });
});

test("findSprintWindow ignores iterations without dates", () => {
  assert.equal(findSprintWindow(NODES, "2026 W26"), null);
  assert.equal(findSprintWindow(NODES, "2026 W99"), null);
});

test("normalizeIterationPath drops the Iteration node so both formats compare", () => {
  assert.equal(
    normalizeIterationPath("\\LCB-TI\\Iteration\\GPM\\Safety Hub\\2026 W24"),
    "LCB-TI\\GPM\\Safety Hub\\2026 W24"
  );
  assert.equal(
    normalizeIterationPath("LCB-TI\\GPM\\Safety Hub\\2026 W24"),
    "LCB-TI\\GPM\\Safety Hub\\2026 W24"
  );
  assert.equal(parentOfIterationPath("LCB-TI\\GPM\\Safety Hub\\2026 W24"), "LCB-TI\\GPM\\Safety Hub");
});

test("findSprintWindow scoped by area does not pick the homonym from another team", () => {
  const semEscopo = findSprintWindow(ARVORE, "2026 W24");
  const comEscopo = findSprintWindow(ARVORE, "2026 W24", { parentPath: "LCB-TI\\GPM\\Safety Hub" });

  assert.equal(comEscopo.startDate, "2026-06-08", "janela da area do usuario");
  assert.equal(comEscopo.finishDate, "2026-06-19");
  assert.equal(semEscopo.startDate, "2026-06-08", "sem escopo cai na primeira encontrada");

  const outraArea = findSprintWindow(ARVORE, "2026 W24", { parentPath: "LCB-TI\\Comercial\\Outro Time" });
  assert.equal(outraArea.startDate, "2026-06-01", "a mesma sprint tem janela diferente em outra area");
});

test("resolveCurrentSprint uses the user's own area to disambiguate", () => {
  // Em 20/07 duas sprints cobrem a data: W29 (serie impar, outro time) e W30
  // (serie par, area do usuario). Tem que sair a do usuario.
  const resultado = resolveCurrentSprint({
    rootNode: ARVORE,
    iterationPaths: CARDS_DO_USUARIO,
    today: "2026-07-20"
  });

  assert.equal(resultado.parentPath, "LCB-TI\\GPM\\Safety Hub");
  assert.equal(resultado.sprint.name, "2026 W30");
});

test("resolveCurrentSprint works for a team on the odd-week series", () => {
  const resultado = resolveCurrentSprint({
    rootNode: ARVORE,
    iterationPaths: ["LCB-TI\\Comercial\\Outro Time\\2026 W24"],
    today: "2026-07-20"
  });

  assert.equal(resultado.sprint.name, "2026 W29");
});

test("pickSprintForDate falls back to the next sprint when none covers today", () => {
  const sprints = [
    { name: "A", parentPath: "x", startDate: "2026-06-08", finishDate: "2026-06-19" },
    { name: "B", parentPath: "x", startDate: "2026-07-20", finishDate: "2026-07-31" }
  ];

  assert.equal(pickSprintForDate(sprints, "2026-07-01").name, "B", "entre sprints, pega a proxima");
  assert.equal(pickSprintForDate(sprints, "2026-08-30").name, "B", "depois de tudo, pega a ultima");
  assert.equal(pickSprintForDate(sprints, "2026-06-10").name, "A");
});

test("listBusinessDays covers the two weeks of the sprint without weekends", () => {
  const days = listBusinessDays("2026-06-08", "2026-06-19");

  assert.equal(days.length, 10);
  assert.equal(days[0], "2026-06-08");
  assert.equal(days[4], "2026-06-12");
  assert.equal(days[5], "2026-06-15");
  assert.equal(days.at(-1), "2026-06-19");
  assert.ok(!days.includes("2026-06-13"), "sabado nao entra");
  assert.ok(!days.includes("2026-06-14"), "domingo nao entra");
});

test("missing estimates divide the free sprint hours by the total number of cards", () => {
  const result = resolveSprintCardHours({
    cards: [{ remaining: null }, { remaining: "" }, {}],
    days: listBusinessDays("2026-06-08", "2026-06-19"),
    maxHoursPerDay: 8
  });

  assert.equal(result.availableHours, 80);
  assert.equal(result.averageHours, 26.67);
  assert.deepEqual(result.targets, [
    { hours: 26.67, source: "sprint-average" },
    { hours: 26.67, source: "sprint-average" },
    { hours: 26.66, source: "sprint-average" }
  ]);
  assert.equal(
    result.targets.reduce((total, target) => total + target.hours, 0),
    80,
    "o arredondamento nao pode criar horas alem da capacidade"
  );
});

test("RemainingWork is reserved before distributing the remaining sprint capacity", () => {
  const result = resolveSprintCardHours({
    cards: [{ remaining: null }, { remaining: 12 }, { remaining: 0 }],
    days: ["2026-06-08", "2026-06-09"],
    maxHoursPerDay: 8,
    hoursByDay: {
      "2026-06-08": 3,
      "2026-06-09": 8
    }
  });

  assert.equal(result.availableHours, 5);
  assert.equal(result.averageHours, 0);
  assert.deepEqual(result.targets, [
    { hours: 0, source: "sprint-average" },
    { hours: 12, source: "remaining-work" },
    { hours: 0, source: "remaining-work" }
  ]);
});

test("explicit estimates do not inflate automatic estimates beyond sprint capacity", () => {
  const result = resolveSprintCardHours({
    cards: [
      { remaining: 72 },
      ...Array.from({ length: 16 }, () => ({ remaining: null }))
    ],
    days: listBusinessDays("2026-06-08", "2026-06-19"),
    maxHoursPerDay: 8
  });

  assert.equal(result.availableHours, 80);
  assert.equal(result.averageHours, 0.5);
  assert.equal(result.targets[0].hours, 72);
  assert.ok(result.targets.slice(1).every((target) => target.hours === 0.5));
  assert.equal(
    result.targets.reduce((total, target) => total + target.hours, 0),
    80
  );
});

test("planSprintAllocation fills 8h per day until the total is covered", () => {
  const plan = planSprintAllocation({
    days: listBusinessDays("2026-06-08", "2026-06-19"),
    totalHours: 40,
    maxHoursPerDay: 8
  });

  assert.equal(plan.allocated, 40);
  assert.equal(plan.unallocated, 0);
  assert.equal(plan.allocations.length, 5);
  assert.deepEqual(
    plan.allocations.map((item) => item.date),
    ["2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12"]
  );
  assert.ok(plan.allocations.every((item) => item.hours === 8));
});

test("planSprintAllocation skips full days and uses partial free hours", () => {
  const plan = planSprintAllocation({
    days: listBusinessDays("2026-06-08", "2026-06-19"),
    totalHours: 40,
    maxHoursPerDay: 8,
    hoursByDay: {
      "2026-06-08": 8, // cheio, pula
      "2026-06-09": 5, // sobram 3h
      "2026-06-10": 20 // estourado por lancamento antigo, pula
    }
  });

  assert.equal(plan.allocated, 40);
  assert.equal(plan.unallocated, 0);
  assert.deepEqual(plan.skipped.map((item) => item.date), ["2026-06-08", "2026-06-10"]);
  assert.deepEqual(
    plan.allocations.map((item) => [item.date, item.hours]),
    [
      ["2026-06-09", 3],
      ["2026-06-11", 8],
      ["2026-06-12", 8],
      ["2026-06-15", 8],
      ["2026-06-16", 8],
      ["2026-06-17", 5]
    ]
  );
});

test("two cards share the same daily budget without exceeding the limit", () => {
  // Espelha o encadeamento do --fill-sprint: o saldo do dia acumula entre cards.
  const days = listBusinessDays("2026-06-08", "2026-06-19");
  const hoursByDay = {};
  const porCard = [];

  for (const horasDoCard of [20, 20]) {
    const plan = planSprintAllocation({ days, totalHours: horasDoCard, maxHoursPerDay: 8, hoursByDay });
    for (const item of plan.allocations) {
      hoursByDay[item.date] = (hoursByDay[item.date] || 0) + item.hours;
    }
    porCard.push(plan.allocations.map((item) => [item.date, item.hours]));
  }

  assert.deepEqual(porCard[0], [
    ["2026-06-08", 8],
    ["2026-06-09", 8],
    ["2026-06-10", 4]
  ]);
  assert.deepEqual(porCard[1], [
    ["2026-06-10", 4],
    ["2026-06-11", 8],
    ["2026-06-12", 8]
  ]);
  assert.ok(
    Object.values(hoursByDay).every((horas) => horas <= 8),
    "nenhum dia pode passar de 8h somando os dois cards"
  );
});

test("isFutureDay only flags days after the reference date", () => {
  assert.equal(isFutureDay("2026-07-21", "2026-07-20"), true);
  assert.equal(isFutureDay("2026-07-20", "2026-07-20"), false, "hoje nao e futuro");
  assert.equal(isFutureDay("2026-07-19", "2026-07-20"), false);
  assert.equal(isFutureDay("", "2026-07-20"), false);
});

test("planSprintAllocation reports hours that do not fit in the sprint", () => {
  const plan = planSprintAllocation({
    days: listBusinessDays("2026-06-08", "2026-06-12"),
    totalHours: 60,
    maxHoursPerDay: 8
  });

  assert.equal(plan.allocated, 40);
  assert.equal(plan.unallocated, 20);
});
