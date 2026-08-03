import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMonthlySummary,
  hoursByDayFromAppointments,
  monthRange
} from "../src/timebox/summary.js";

test("hoursByDayFromAppointments sums every card on the same day", () => {
  const result = hoursByDayFromAppointments([
    { workedAt: "2026-07-20T00:00:00", workedMinutes: 480, workItemId: 1 },
    { workedAt: "2026-07-20T00:00:00", workedMinutes: 120, workItemId: 2 },
    { workedAt: "2026-07-21T00:00:00", workedMinutes: 90, workItemId: 1 }
  ]);

  assert.deepEqual(result, {
    "2026-07-20": 10,
    "2026-07-21": 1.5
  });
});

test("monthRange validates the month and handles leap years", () => {
  assert.deepEqual(monthRange("2028-02"), {
    month: "2028-02",
    startDate: "2028-02-01",
    endDate: "2028-02-29",
    year: 2028,
    monthNumber: 2,
    lastDay: 29
  });
  assert.throws(() => monthRange("2026-13"), /Mes invalido/);
});

test("buildMonthlySummary highlights incomplete and over-limit days", () => {
  const summary = buildMonthlySummary({
    month: "2026-07",
    hoursByDay: {
      "2026-07-20": 16,
      "2026-07-21": 8,
      "2026-07-22": 4
    },
    maxHoursPerDay: 8,
    today: "2026-07-22"
  });

  assert.equal(summary.loggedHours, 28);
  assert.equal(summary.overLimitDays, 1);
  assert.equal(summary.completeDays, 1);
  assert.equal(summary.rows.find((row) => row.date === "2026-07-20").excess, 8);
  assert.equal(summary.rows.find((row) => row.date === "2026-07-22").remaining, 4);
  assert.equal(summary.rows.find((row) => row.date === "2026-07-23").future, true);
});
