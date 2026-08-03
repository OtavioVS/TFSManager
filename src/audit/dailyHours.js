import fs from "node:fs";

export function sumAppliedHoursForDay(logPath, { personName, workDate, workItems = null }) {
  if (!logPath || !workDate || !personName || !fs.existsSync(logPath)) {
    return 0;
  }

  return sumAppliedHoursByDay(logPath, { personName, workItems })[workDate] || 0;
}

// Mesma contabilidade, porem para varios dias de uma vez (planejamento de sprint).
// Retorna um mapa { "AAAA-MM-DD": horas }.
export function sumAppliedHoursByDay(logPath, { personName, workItems = null }) {
  const totals = {};
  if (!logPath || !personName || !fs.existsSync(logPath)) {
    return totals;
  }

  const normalizedPerson = normalizeText(personName);
  const currentItems = normalizeWorkItems(workItems);
  const byWorkItem = new Map();

  for (const [index, line] of fs.readFileSync(logPath, "utf8").split(/\r?\n/).entries()) {
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
      const workItemId = Number(command.workItemId);
      if (currentItems) {
        if (!currentItems.has(workItemId)) {
          continue;
        }
        const entries = byWorkItem.get(workItemId) || [];
        entries.push({ date: command.workDate, hours, index });
        byWorkItem.set(workItemId, entries);
      } else {
        addHours(totals, command.workDate, hours);
      }
    }
  }

  if (currentItems) {
    for (const [workItemId, entries] of byWorkItem) {
      let remaining = currentItems.get(workItemId);
      for (const entry of [...entries].reverse()) {
        if (remaining <= 0) {
          break;
        }
        const hours = Math.min(entry.hours, remaining);
        addHours(totals, entry.date, hours);
        remaining = roundHours(remaining - hours);
      }
    }
  }

  return totals;
}

function normalizeWorkItems(workItems) {
  if (!Array.isArray(workItems)) {
    return null;
  }

  const result = new Map();
  for (const item of workItems) {
    const id = Number(item?.id);
    const completed = Number(item?.completed);
    if (Number.isInteger(id) && id > 0 && Number.isFinite(completed)) {
      result.set(id, Math.max(0, roundHours(completed)));
    }
  }
  return result;
}

function addHours(totals, date, hours) {
  totals[date] = roundHours((totals[date] || 0) + hours);
}

function roundHours(value) {
  return Math.round(Number(value) * 100) / 100;
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