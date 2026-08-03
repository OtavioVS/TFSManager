import fs from "node:fs";

export function sumAppliedHoursForDay(logPath, { personName, workDate }) {
  if (!logPath || !workDate || !personName || !fs.existsSync(logPath)) {
    return 0;
  }

  return sumAppliedHoursByDay(logPath, { personName })[workDate] || 0;
}

// Mesma contabilidade, porem para varios dias de uma vez (planejamento de sprint).
// Retorna um mapa { "AAAA-MM-DD": horas }.
export function sumAppliedHoursByDay(logPath, { personName }) {
  const totals = {};
  if (!logPath || !personName || !fs.existsSync(logPath)) {
    return totals;
  }

  const normalizedPerson = normalizeText(personName);

  for (const line of fs.readFileSync(logPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const entry = parseJson(line);
    if (!entry || entry.mode !== "apply") {
      continue;
    }

    const result = entry.result || {};
    const stage = result.stage || "";
    const azureWasUpdated = result.ok === true || stage === "applied" || stage === "applied-with-timebox-error";
    if (!azureWasUpdated) {
      continue;
    }

    const command = entry.command || result.command || {};
    if (!command.workDate || normalizeText(command.personName) !== normalizedPerson) {
      continue;
    }

    const hours = Number(command.completedWorkDelta);
    if (Number.isFinite(hours) && hours > 0) {
      totals[command.workDate] = Math.round(((totals[command.workDate] || 0) + hours) * 100) / 100;
    }
  }

  return totals;
}

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}