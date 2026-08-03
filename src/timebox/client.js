import { mintTimeboxToken } from "./mintToken.js";
import { decodeJwtPayload, isExpired } from "./appToken.js";
import { hoursByDayFromAppointments } from "./summary.js";

export class TimeboxClient {
  constructor({ apiUrl, authToken = "", user = {}, mintToken = false, fetchImpl = globalThis.fetch }) {
    this.apiUrl = normalizeApiUrl(apiUrl);
    this.authToken = authToken;
    this.user = user;
    this.mintToken = mintToken;
    this.fetch = fetchImpl;
  }

  async createTimeLog(plan, { maxHoursPerDay } = {}) {
    const authToken = await this.getAuthToken();

    // Segunda barreira, imediatamente antes do POST. O planejamento tambem
    // valida, mas esta consulta reduz a janela para duas execucoes concorrentes
    // criarem mais de 8h no mesmo dia.
    if (Number.isFinite(Number(maxHoursPerDay)) && Number(maxHoursPerDay) > 0) {
      const existing = await this.searchAppointments(
        {
          userId: plan.appointment.userId,
          startedAt: plan.appointment.workedAt,
          endedAt: plan.appointment.workedAt
        },
        authToken
      );
      assertDailyAppointmentLimit(existing, plan.appointment, Number(maxHoursPerDay));
    }

    const workItem = await this.updateWorkItem(plan.workItem, authToken);
    const appointment = await this.createAppointment(plan.appointment, authToken);

    return { workItem, appointment };
  }

  async getAuthToken() {
    if (this.authToken) {
      const exp = decodeJwtPayload(this.authToken)?.exp || null;
      if (!isExpired(exp)) {
        return this.authToken;
      }

      // O backend passou a rejeitar JWT expirado. Se o app token da extensao
      // ainda estiver valido, usa o PUT /user abaixo para renovar a sessao.
      this.authToken = "";
      const appTokenExp = decodeJwtPayload(this.user?.appToken)?.exp || null;
      if (!this.mintToken && isExpired(appTokenExp)) {
        throw new Error(
          "Token do Time Box expirou. Abra o Time Box Control no Azure DevOps e cole um token novo."
        );
      }
    }

    // Modo mint: gera o JWT localmente a partir da propria identidade, sem rede.
    if (this.mintToken) {
      this.authToken = mintTimeboxToken(this.user);
      return this.authToken;
    }

    assertUserConfig(this.user);
    const token = await this.request("PUT", "/v1/user", {
      id: this.user.id,
      organizationId: this.user.organizationId,
      name: this.user.name,
      displayName: this.user.displayName,
      appToken: this.user.appToken
    });

    this.authToken = String(token || "");
    return this.authToken;
  }

  async updateWorkItem(workItem, authToken) {
    return this.request("PUT", "/v1/work-item", workItem, authToken);
  }

  async createAppointment(appointment, authToken) {
    return this.request("POST", "/v1/appointment", appointment, authToken);
  }

  async searchAppointments(
    { workItemId, userId = this.user.id, startedAt, endedAt, areaPath } = {},
    authToken = ""
  ) {
    const token = authToken || (await this.getAuthToken());
    const query = new URLSearchParams();
    if (workItemId !== null && workItemId !== undefined && workItemId !== "") {
      query.set("workItemId", String(workItemId));
    }
    if (userId) query.set("userId", String(userId));
    if (startedAt) query.set("startedAt", String(startedAt));
    if (endedAt) query.set("endedAt", String(endedAt));
    if (areaPath) query.set("areaPath", String(areaPath));

    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request("GET", `/v1/appointment/search${suffix}`, undefined, token);
  }

  async request(method, path, body, authToken = "") {
    if (!this.apiUrl) {
      throw new Error("TIMEBOX_API_URL nao configurado.");
    }

    const headers = {
      accept: "application/json"
    };

    if (authToken) {
      headers.authorization = `Bearer ${authToken}`;
    }

    const options = {
      method,
      headers
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    const response = await this.fetch(`${this.apiUrl}${path}`, options);

    return readResponse(response);
  }
}

export function assertDailyAppointmentLimit(appointments, appointment, maxHoursPerDay) {
  const workDate = String(appointment?.workedAt || "").slice(0, 10);
  const hoursByDay = hoursByDayFromAppointments(appointments);
  const alreadyLogged = roundHours(hoursByDay[workDate] || 0);
  const requested = roundHours(Number(appointment?.workedMinutes || 0) / 60);
  const nextTotal = roundHours(alreadyLogged + requested);

  if (nextTotal > maxHoursPerDay) {
    throw new Error(
      `Limite diario do Time Box excedido em ${workDate}: ` +
        `${alreadyLogged}h ja lancadas, +${requested}h passaria de ${maxHoursPerDay}h. ` +
        "O apontamento nao foi criado."
    );
  }

  return { alreadyLogged, requested, nextTotal, maxHoursPerDay };
}

export function buildTimeboxPlan({ command, workItem, config, comment }) {
  const user = config.timebox.user;
  const workDate = command.workDate || todayIsoDate();
  const workItemModel = buildTimeboxWorkItemModel(workItem, config.azureDevOps.demandNumberField);

  return {
    enabled: true,
    workItem: workItemModel,
    appointment: {
      workItemId: command.workItemId,
      userId: user.id,
      workedWeek: formatWorkedWeek(workDate),
      workedAt: workDate,
      workedMinutes: hoursToMinutes(command.completedWorkDelta),
      comment: comment || ""
    }
  };
}

export function buildTimeboxWorkItemModel(workItem, demandNumberField = "") {
  const fields = workItem.fields || {};

  return {
    id: workItem.id,
    title: truncate(fields["System.Title"] || `Work item ${workItem.id}`, 300),
    areaPath: truncate(fields["System.AreaPath"] || "Sem area", 300),
    demandNumber: truncate(demandNumberField ? fields[demandNumberField] || null : null, 20)
  };
}

export function hoursToMinutes(hours) {
  return Math.round(Number(hours) * 60);
}

export function formatWorkedWeek(isoDate) {
  const parsed = parseIsoDate(isoDate);
  return `${parsed.year}-${String(isoWeekNumber(parsed.date)).padStart(2, "0")}`;
}

export function todayIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) {
    throw new Error(`Data invalida para Timebox: ${value}.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return { year, date: new Date(Date.UTC(year, month - 1, day)) };
}

function isoWeekNumber(date) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);

  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);

  return 1 + Math.round((target - firstThursday) / 604800000);
}

function truncate(value, maxLength) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function roundHours(value) {
  return Math.round(Number(value) * 100) / 100;
}

function normalizeApiUrl(apiUrl) {
  return apiUrl ? String(apiUrl).replace(/\/+$/, "") : "";
}

function assertUserConfig(user) {
  const missing = [];
  if (!user.id) missing.push("TIMEBOX_USER_ID");
  if (!user.organizationId) missing.push("TIMEBOX_ORGANIZATION_ID");
  if (!user.name) missing.push("TIMEBOX_USER_NAME");
  if (!user.displayName) missing.push("TIMEBOX_USER_DISPLAY_NAME");
  if (!user.appToken) missing.push("TIMEBOX_APP_TOKEN");

  if (missing.length > 0) {
    throw new Error(`Configuracao ausente para autenticar no Timebox: ${missing.join(", ")}.`);
  }
}

async function readResponse(response) {
  const text = await response.text();
  const body = text ? parseJson(text) : {};

  if (!response.ok) {
    throw new Error(`Erro Timebox ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
