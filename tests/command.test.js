import test from "node:test";
import assert from "node:assert/strict";
import { commandFromFlags, normalizeCommand, parseMissingFields } from "../src/work-items/command.js";

test("normalizeCommand coerces structured input", () => {
  const command = normalizeCommand({
    workItemId: "12345",
    personName: " Max ",
    completedWorkDelta: "1.5",
    remainingWorkDelta: "-1.5",
    targetState: "",
    targetBoardColumn: "Doing",
    workDate: " 2026-06-25 ",
    comment: null,
    confidence: 1.5,
    needsConfirmation: false,
    missingFields: null
  });

  assert.deepEqual(command, {
    action: "log_time_and_move_card",
    workItemId: 12345,
    personName: "Max",
    completedWorkDelta: 1.5,
    remainingWorkDelta: -1.5,
    targetState: null,
    targetBoardColumn: "Doing",
    workDate: "2026-06-25",
    comment: null,
    confidence: 1,
    needsConfirmation: false,
    forceRemainingZero: false,
    missingFields: []
  });
});

test("commandFromFlags builds command for Claude CLI flags", () => {
  const command = commandFromFlags({
    workItemId: "12345",
    personName: "Max",
    completedWorkDelta: "2",
    remainingWorkDelta: null,
    targetState: "Active",
    targetBoardColumn: null,
    comment: "feito",
    confidence: "0.9",
    needsConfirmation: true,
    missingFields: ["targetBoardColumn"]
  });

  assert.equal(command.workItemId, 12345);
  assert.equal(command.completedWorkDelta, 2);
  assert.equal(command.remainingWorkDelta, null);
  assert.equal(command.targetState, "Active");
  assert.equal(command.needsConfirmation, true);
  assert.deepEqual(command.missingFields, ["targetBoardColumn"]);
});

test("parseMissingFields parses comma-separated values", () => {
  assert.deepEqual(parseMissingFields("workItemId, hours, personName"), ["workItemId", "hours", "personName"]);
});
