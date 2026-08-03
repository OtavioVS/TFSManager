import test from "node:test";
import assert from "node:assert/strict";
import { diasEstimados, hoursByDayFromUpdates, mergeHoursByDay } from "../src/audit/tfsHistory.js";

function update(revisedDate, de, para, historico) {
  return {
    revisedDate,
    fields: {
      "Microsoft.VSTS.Scheduling.CompletedWork": { oldValue: de, newValue: para },
      ...(historico === undefined ? {} : { "System.History": { newValue: historico } })
    }
  };
}

// Formato real observado no card #1067496, lancado por este CLI.
const LANCADO_PELO_CLI = [
  update("2026-07-20T14:16:34Z", 0, 8, "Apontamento automatizado: +8h para Gabriel. (Refere-se ao dia 2026-06-08.)"),
  update("2026-07-20T14:16:35Z", 8, 16, "Apontamento automatizado: +8h para Gabriel. (Refere-se ao dia 2026-06-09.)"),
  // O TFS marca a revisao mais recente com a data sentinela 9999-01-01.
  update("9999-01-01T00:00:00Z", 16, 20, "Apontamento automatizado: +4h para Gabriel. (Refere-se ao dia 2026-06-10.)")
];

// Formato real do card #1048694, fechado pela interface do TFS: sem comentario.
const LANCADO_FORA = [
  update("2026-06-15T10:00:00Z", 0, 8, ""),
  update("2026-06-15T10:01:00Z", 8, 16, "")
];

test("hoursByDayFromUpdates reads the work date from the comment", () => {
  const porDia = hoursByDayFromUpdates(LANCADO_PELO_CLI);

  assert.deepEqual(porDia["2026-06-08"], { hours: 8, exata: true });
  assert.deepEqual(porDia["2026-06-09"], { hours: 8, exata: true });
  assert.deepEqual(porDia["2026-06-10"], { hours: 4, exata: true }, "a revisao 9999 vale pelo comentario");
  assert.ok(!porDia["9999-01-01"], "a data sentinela nunca vira um dia");
});

test("hoursByDayFromUpdates falls back to the revision date and flags it", () => {
  const porDia = hoursByDayFromUpdates(LANCADO_FORA);

  assert.equal(porDia["2026-06-15"].hours, 16);
  assert.equal(porDia["2026-06-15"].exata, false, "sem comentario, o dia e so um palpite");
  assert.deepEqual(diasEstimados(porDia), ["2026-06-15"]);
});

test("hoursByDayFromUpdates ignores revisions that do not add hours", () => {
  const porDia = hoursByDayFromUpdates([
    update("2026-06-08T10:00:00Z", 0, 8, "lancamento"),
    update("2026-06-08T11:00:00Z", 8, 8, "so mudou o estado"),
    update("2026-06-08T12:00:00Z", 8, 4, "correcao para menos"),
    { revisedDate: "2026-06-08T13:00:00Z", fields: { "System.State": { newValue: "Closed" } } }
  ]);

  assert.deepEqual(porDia["2026-06-08"], { hours: 4, exata: false });
});

test("hoursByDayFromUpdates removes reset hours and respects current CompletedWork", () => {
  const porDia = hoursByDayFromUpdates([
    update("2026-08-03T10:00:00Z", 0, 8, ""),
    update("2026-08-03T10:01:00Z", 8, 16, ""),
    update("2026-08-03T10:02:00Z", 16, 8, ""),
    update("2026-08-03T10:03:00Z", 8, 0, "")
  ], { currentCompleted: 0 });

  assert.deepEqual(porDia, {});
});

test("mergeHoursByDay takes the larger source instead of summing", () => {
  // O mesmo lancamento aparece nas duas fontes; somar contaria 16h onde ha 8h.
  const merged = mergeHoursByDay(
    { "2026-06-08": 8, "2026-06-09": 4 },
    { "2026-06-08": { hours: 8, exata: true }, "2026-06-10": { hours: 6, exata: true } }
  );

  assert.equal(merged["2026-06-08"], 8, "nao pode dobrar");
  assert.equal(merged["2026-06-09"], 4, "so no audit local");
  assert.equal(merged["2026-06-10"], 6, "so no TFS");
});

test("mergeHoursByDay never underestimates a day", () => {
  const merged = mergeHoursByDay(
    { "2026-06-08": 3 },
    { "2026-06-08": { hours: 8, exata: true } },
    { "2026-06-08": 10 }
  );
  assert.equal(merged["2026-06-08"], 10, "Time Box tambem entra sem somar em dobro");
});

test("mergeHoursByDay accepts Timebox as a third source", () => {
  const merged = mergeHoursByDay(
    { "2026-07-20": 8 },
    { "2026-07-21": { hours: 8, exata: true } },
    { "2026-07-20": 16, "2026-07-22": 4 }
  );

  assert.equal(merged["2026-07-20"], 16);
  assert.equal(merged["2026-07-21"], 8);
  assert.equal(merged["2026-07-22"], 4);
});
