import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonlAuditLog } from "../src/audit/jsonlAuditLog.js";
import { sumAppliedHoursForDay } from "../src/audit/dailyHours.js";

test("JsonlAuditLog writes redacted entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azdo-time-audit-"));
  const logPath = path.join(dir, "audit.jsonl");

  new JsonlAuditLog(logPath).append({
    command: { workItemId: 123 },
    pat: "secret",
    nested: {
      apiKey: "secret"
    }
  });

  const lines = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/);
  assert.equal(lines.length, 1);

  const entry = JSON.parse(lines[0]);
  assert.equal(entry.pat, "[REDACTED]");
  assert.equal(entry.nested.apiKey, "[REDACTED]");
  assert.equal(entry.command.workItemId, 123);
});


test("sumAppliedHoursForDay counts only successful apply entries for the same person and date", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azdo-time-daily-"));
  const logPath = path.join(dir, "audit.jsonl");
  const entries = [
    { mode: "apply", command: { personName: "Máx", workDate: "2026-06-25", completedWorkDelta: 4 }, result: { ok: true } },
    { mode: "apply", command: { personName: "Max", workDate: "2026-06-25", completedWorkDelta: 2.5 }, result: { stage: "applied" } },
    { mode: "apply", command: { personName: "Max", workDate: "2026-06-25", completedWorkDelta: 8 }, result: { ok: false } },
    { mode: "plan", command: { personName: "Max", workDate: "2026-06-25", completedWorkDelta: 8 }, result: { ok: true } },
    { mode: "apply", command: { personName: "Ana", workDate: "2026-06-25", completedWorkDelta: 8 }, result: { ok: true } },
    { mode: "apply", command: { personName: "Max", workDate: "2026-06-26", completedWorkDelta: 8 }, result: { ok: true } }
  ];
  fs.writeFileSync(logPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\nnao-json`, "utf8");

  assert.equal(sumAppliedHoursForDay(logPath, { personName: "Max", workDate: "2026-06-25" }), 6.5);
});