import test from "node:test";
import assert from "node:assert/strict";
import {
  TimeboxClient,
  assertDailyAppointmentLimit,
  buildTimeboxPlan,
  formatWorkedWeek,
  hoursToMinutes
} from "../src/timebox/client.js";

test("buildTimeboxPlan creates Timebox work item and appointment payloads", () => {
  const plan = buildTimeboxPlan({
    command: {
      workItemId: 1070143,
      completedWorkDelta: 1.5,
      workDate: "2026-06-25"
    },
    workItem: {
      id: 1070143,
      fields: {
        "System.Title": "Implementar motor de calculo",
        "System.AreaPath": "LCB-TI\\Squad",
        "Custom.Demand": "DMND0131165"
      }
    },
    config: {
      azureDevOps: { demandNumberField: "Custom.Demand" },
      timebox: { user: { id: "user-id" } }
    },
    comment: "inicio da validacao"
  });

  assert.deepEqual(plan.workItem, {
    id: 1070143,
    title: "Implementar motor de calculo",
    areaPath: "LCB-TI\\Squad",
    demandNumber: "DMND0131165"
  });
  assert.deepEqual(plan.appointment, {
    workItemId: 1070143,
    userId: "user-id",
    workedWeek: "2026-26",
    workedAt: "2026-06-25",
    workedMinutes: 90,
    comment: "inicio da validacao"
  });
});

test("TimeboxClient syncs user, work item and appointment", async () => {
  const calls = [];
  const client = new TimeboxClient({
    apiUrl: "http://localhost:5256/api/",
    user: {
      id: "8F17416D-C490-6982-B4BF-05E31BA254BE",
      organizationId: "27F974F5-E405-474D-B0DE-02A714384429",
      name: "gabriel@example.com",
      displayName: "Gabriel Menezes",
      appToken: "app-token"
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (String(url).endsWith("/v1/user")) {
        return jsonResponse("jwt-token");
      }
      if (String(url).endsWith("/v1/work-item")) {
        return jsonResponse(JSON.parse(options.body));
      }
      return jsonResponse({ id: "appointment-id", ...JSON.parse(options.body) });
    }
  });

  const result = await client.createTimeLog({
    workItem: { id: 123, title: "Card", areaPath: "Area", demandNumber: null },
    appointment: {
      workItemId: 123,
      userId: "8F17416D-C490-6982-B4BF-05E31BA254BE",
      workedWeek: "2026-26",
      workedAt: "2026-06-25",
      workedMinutes: 120,
      comment: "feito"
    }
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "http://localhost:5256/api/v1/user");
  assert.equal(calls[0].options.method, "PUT");
  assert.equal(calls[1].url, "http://localhost:5256/api/v1/work-item");
  assert.equal(calls[1].options.headers.authorization, "Bearer jwt-token");
  assert.equal(calls[2].url, "http://localhost:5256/api/v1/appointment");
  assert.equal(calls[2].options.headers.authorization, "Bearer jwt-token");
  assert.equal(result.appointment.workedMinutes, 120);
});

test("Timebox date helpers match frontend payload format", () => {
  assert.equal(hoursToMinutes(2.25), 135);
  assert.equal(formatWorkedWeek("2026-06-25"), "2026-26");
});

test("TimeboxClient searches appointments by user and inclusive date range", async () => {
  let captured;
  const client = new TimeboxClient({
    apiUrl: "https://timebox.example/api",
    authToken: "jwt-token",
    user: { id: "user-id" },
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return jsonResponse([{ id: "appointment-id", workedMinutes: 60 }]);
    }
  });

  const result = await client.searchAppointments({
    startedAt: "2026-07-01",
    endedAt: "2026-07-31"
  });

  assert.equal(result.length, 1);
  assert.match(captured.url, /\/v1\/appointment\/search\?/);
  assert.match(captured.url, /userId=user-id/);
  assert.match(captured.url, /startedAt=2026-07-01/);
  assert.match(captured.url, /endedAt=2026-07-31/);
  assert.equal(captured.options.method, "GET");
  assert.equal(captured.options.body, undefined);
  assert.equal(captured.options.headers.authorization, "Bearer jwt-token");
});

test("TimeboxClient refuses the POST when the day already has 8h", async () => {
  const calls = [];
  const client = new TimeboxClient({
    apiUrl: "https://timebox.example/api",
    authToken: "jwt-token",
    user: { id: "user-id" },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse([
        {
          userId: "user-id",
          workedAt: "2026-07-20T00:00:00",
          workedMinutes: 480
        }
      ]);
    }
  });

  await assert.rejects(
    () =>
      client.createTimeLog(
        {
          workItem: { id: 123, title: "Card", areaPath: "Area", demandNumber: null },
          appointment: {
            workItemId: 123,
            userId: "user-id",
            workedWeek: "2026-30",
            workedAt: "2026-07-20",
            workedMinutes: 480,
            comment: "feito"
          }
        },
        { maxHoursPerDay: 8 }
      ),
    /passaria de 8h/
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/appointment\/search/);
});

test("assertDailyAppointmentLimit allows filling only the remaining daily balance", () => {
  const existing = [{ workedAt: "2026-07-20", workedMinutes: 360 }];
  const result = assertDailyAppointmentLimit(
    existing,
    { workedAt: "2026-07-20", workedMinutes: 120 },
    8
  );

  assert.deepEqual(result, {
    alreadyLogged: 6,
    requested: 2,
    nextTotal: 8,
    maxHoursPerDay: 8
  });
});

test("TimeboxClient blocks before the API when both chained tokens expired", async () => {
  let called = false;
  const expired = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  const client = new TimeboxClient({
    apiUrl: "https://timebox.example/api",
    authToken: expired,
    user: {
      id: "user-id",
      organizationId: "org-id",
      name: "max@example.com",
      displayName: "Max",
      appToken: expired
    },
    fetchImpl: async () => {
      called = true;
      return jsonResponse([]);
    }
  });

  await assert.rejects(
    () => client.searchAppointments({ startedAt: "2026-07-20", endedAt: "2026-07-20" }),
    /Token do Time Box expirou/
  );
  assert.equal(called, false);
});

test("TimeboxClient renews an expired session while the app token is valid", async () => {
  const calls = [];
  const expiredAuth = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  const validApp = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const client = new TimeboxClient({
    apiUrl: "https://timebox.example/api",
    authToken: expiredAuth,
    user: {
      id: "user-id",
      organizationId: "org-id",
      name: "max@example.com",
      displayName: "Max",
      appToken: validApp
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/v1/user")) {
        return jsonResponse("renewed-jwt");
      }
      return jsonResponse([]);
    }
  });

  await client.searchAppointments({ startedAt: "2026-07-20", endedAt: "2026-07-20" });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "PUT");
  assert.equal(calls[1].options.headers.authorization, "Bearer renewed-jwt");
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}
