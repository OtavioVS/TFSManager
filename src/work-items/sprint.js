// Resolucao de sprint e distribuicao de horas pelos dias uteis.
//
// As sprints do TFS seguem o padrao "AAAA Wnn" e cobrem DUAS semanas: a sprint
// "2026 W24" vai de 08/06 a 19/06 (semanas 24 e 25). Alguns projetos nomeiam so
// as semanas pares, outros so as impares; por isso a janela nunca e calculada a
// partir do numero da semana, e sim lida de startDate/finishDate do proprio TFS.

// Extrai o nome da sprint do IterationPath.
// "LCB-TI\\...\\Safety Hub\\2026 W24" -> "2026 W24"
export function sprintNameFromIterationPath(iterationPath) {
  if (!iterationPath) {
    return null;
  }

  const segments = String(iterationPath)
    .split(/[\\/]/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  return segments.length > 0 ? segments[segments.length - 1] : null;
}

// O IterationPath do card e "Projeto\\Area\\Sprint"; o path do no da API de
// classification nodes inclui um segmento "Iteration" a mais. Normaliza os dois
// para o mesmo formato para poderem ser comparados.
export function normalizeIterationPath(value) {
  const segments = String(value || "")
    .split(/[\\/]/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length > 1 && normalizeText(segments[1]) === "iteration") {
    segments.splice(1, 1);
  }

  return segments.join("\\");
}

// Caminho da area que contem a sprint ("...\\Safety Hub\\2026 W24" -> "...\\Safety Hub").
export function parentOfIterationPath(value) {
  const segments = normalizeIterationPath(value).split("\\").filter(Boolean);
  segments.pop();
  return segments.join("\\");
}

// Achata a arvore em sprints com janela definida, guardando o caminho do pai.
// Nomes de sprint se repetem entre areas ("2026 W24" existe em varios projetos),
// por isso o pai e obrigatorio para desambiguar.
export function collectSprints(rootNode) {
  const sprints = [];

  (function walk(node, ancestors) {
    if (!node) {
      return;
    }

    const path = node.path ? normalizeIterationPath(node.path) : [...ancestors, node.name].join("\\");
    const attributes = node.attributes || {};

    if (attributes.startDate && attributes.finishDate) {
      sprints.push({
        name: node.name,
        path,
        parentPath: parentOfIterationPath(path),
        startDate: isoDay(attributes.startDate),
        finishDate: isoDay(attributes.finishDate)
      });
    }

    for (const child of node.children || []) {
      walk(child, [...ancestors, node.name]);
    }
  })(rootNode, []);

  return sprints;
}

// Escolhe a sprint da data: a que contem o dia; senao a proxima; senao a ultima passada.
export function pickSprintForDate(sprints, today) {
  const dia = isoDay(today);
  const ordenadas = [...sprints].sort((a, b) => a.startDate.localeCompare(b.startDate));

  const atual = ordenadas.filter((sprint) => sprint.startDate <= dia && dia <= sprint.finishDate);
  if (atual.length > 0) {
    // Havendo empate, fica a janela mais curta (evita nos mensais/anuais).
    return atual.sort((a, b) => duracao(a) - duracao(b))[0];
  }

  return ordenadas.find((sprint) => sprint.startDate > dia) || ordenadas.at(-1) || null;
}

// Descobre a sprint corrente a partir dos cards do proprio usuario: a area onde ele
// trabalha define a serie de sprints (par, impar ou qualquer outra convencao).
export function resolveCurrentSprint({ rootNode, iterationPaths = [], today }) {
  const parentPath = dominantParentPath(iterationPaths);
  const todas = collectSprints(rootNode);
  const candidatas = parentPath
    ? todas.filter((sprint) => normalizeText(sprint.parentPath) === normalizeText(parentPath))
    : todas;

  return {
    parentPath,
    sprint: pickSprintForDate(candidatas.length > 0 ? candidatas : todas, today),
    candidates: candidatas
  };
}

// Area mais frequente entre os cards do usuario.
function dominantParentPath(iterationPaths) {
  const contagem = new Map();
  for (const path of iterationPaths) {
    const parent = parentOfIterationPath(path);
    if (parent) {
      contagem.set(parent, (contagem.get(parent) || 0) + 1);
    }
  }

  return [...contagem.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function duracao(sprint) {
  return new Date(sprint.finishDate).getTime() - new Date(sprint.startDate).getTime();
}

// Percorre a arvore de nos de iteracao e devolve a janela da sprint pedida.
// parentPath escopa a busca na area do usuario: o mesmo nome de sprint existe em
// varias areas do TFS, entao sem escopo a primeira encontrada pode ser de outro time.
export function findSprintWindow(rootNode, sprintName, { parentPath = null } = {}) {
  if (!rootNode || !sprintName) {
    return null;
  }

  const alvo = normalizeText(sprintName);
  const homonimas = collectSprints(rootNode).filter((sprint) => normalizeText(sprint.name) === alvo);
  const noEscopo = parentPath
    ? homonimas.filter((sprint) => normalizeText(sprint.parentPath) === normalizeText(parentPath))
    : homonimas;

  const escolhida = (noEscopo.length > 0 ? noEscopo : homonimas)[0];
  if (!escolhida) {
    return null;
  }

  return {
    name: escolhida.name,
    startDate: escolhida.startDate,
    finishDate: escolhida.finishDate
  };
}

// Dias uteis (segunda a sexta) dentro da janela, inclusive nas duas pontas.
export function listBusinessDays(startDate, finishDate) {
  const start = toUtcDate(startDate);
  const finish = toUtcDate(finishDate);
  if (!start || !finish || start > finish) {
    return [];
  }

  const days = [];
  for (let cursor = start; cursor <= finish; cursor = addDays(cursor, 1)) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      days.push(isoDay(cursor.toISOString()));
    }
  }

  return days;
}

// Quando o card nao tem RemainingWork, divide a capacidade que sobra depois dos
// cards estimados entre os cards sem estimativa. A conta usa centesimos de hora.
export function resolveSprintCardHours({
  cards = [],
  days = [],
  maxHoursPerDay,
  hoursByDay = {}
}) {
  const dailyLimit = Math.max(0, Number(maxHoursPerDay) || 0);
  const availableUnits = days.reduce((total, date) => {
    const alreadyLogged = Math.max(0, Number(hoursByDay[date]) || 0);
    const free = Math.max(0, dailyLimit - alreadyLogged);
    return total + Math.round(free * 100);
  }, 0);

  const cardCount = cards.length;
  const remainingByCard = cards.map((card) => optionalHours(card?.remaining));
  const explicitUnits = remainingByCard.reduce(
    (total, remaining) => total + (remaining === null ? 0 : Math.round(remaining * 100)),
    0
  );
  const missingIndexes = remainingByCard
    .map((remaining, index) => (remaining === null ? index : null))
    .filter((index) => index !== null);
  const automaticUnits = Math.max(0, availableUnits - explicitUnits);
  const baseUnits = missingIndexes.length > 0 ? Math.floor(automaticUnits / missingIndexes.length) : 0;
  const extraUnits = missingIndexes.length > 0 ? automaticUnits % missingIndexes.length : 0;
  const automaticHours = new Map(
    missingIndexes.map((cardIndex, index) => [
      cardIndex,
      roundHours((baseUnits + (index < extraUnits ? 1 : 0)) / 100)
    ])
  );

  const targets = remainingByCard.map((remaining, index) =>
    remaining === null
      ? { hours: automaticHours.get(index) || 0, source: "sprint-average" }
      : { hours: remaining, source: "remaining-work" }
  );

  const availableHours = roundHours(availableUnits / 100);
  return {
    availableHours,
    averageHours: missingIndexes.length > 0
      ? roundHours(automaticUnits / 100 / missingIndexes.length)
      : 0,
    cardCount,
    targets
  };
}

// Distribui totalHours pelos dias, enchendo cada dia ate maxHoursPerDay e
// descontando o que ja foi lancado nele. Dias sem folga sao pulados.
export function planSprintAllocation({ days = [], totalHours, maxHoursPerDay, hoursByDay = {} }) {
  const allocations = [];
  const skipped = [];
  let remaining = roundHours(totalHours);

  for (const date of days) {
    const alreadyLogged = roundHours(hoursByDay[date] || 0);
    const free = roundHours(maxHoursPerDay - alreadyLogged);

    if (free <= 0) {
      skipped.push({ date, alreadyLogged, reason: `ja tem ${alreadyLogged}h lancadas (limite ${maxHoursPerDay}h)` });
      continue;
    }

    if (remaining <= 0) {
      break;
    }

    const hours = roundHours(Math.min(free, remaining));
    allocations.push({ date, hours, alreadyLogged });
    remaining = roundHours(remaining - hours);
  }

  return {
    allocations,
    skipped,
    allocated: roundHours(allocations.reduce((total, item) => total + item.hours, 0)),
    unallocated: roundHours(Math.max(0, remaining))
  };
}

// Data de hoje no fuso local. Usar toISOString() direto erraria o dia a noite no
// Brasil (UTC-3), quando o UTC ja virou.
export function todayIso() {
  const agora = new Date();
  return new Date(agora.getTime() - agora.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// Dia posterior a hoje (ou a uma data de referencia informada).
export function isFutureDay(value, today = todayIso()) {
  const dia = isoDay(value);
  return Boolean(dia) && dia > isoDay(today);
}

function addDays(date, amount) {
  return new Date(date.getTime() + amount * 24 * 60 * 60 * 1000);
}

function toUtcDate(value) {
  const iso = isoDay(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return null;
  }

  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDay(value) {
  return String(value || "").slice(0, 10);
}

function roundHours(value) {
  return Math.round(Number(value) * 100) / 100;
}

function optionalHours(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? roundHours(Math.max(0, parsed)) : null;
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}
