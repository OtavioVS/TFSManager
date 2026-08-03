export function hoursByDayFromAppointments(appointments = []) {
  const totals = {};

  for (const appointment of appointments) {
    const day = isoDay(appointment?.workedAt);
    const minutes = Number(appointment?.workedMinutes);
    if (!day || !Number.isFinite(minutes) || minutes <= 0) {
      continue;
    }

    totals[day] = roundHours((totals[day] || 0) + minutes / 60);
  }

  return totals;
}

export function monthRange(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  if (!match) {
    throw new Error(`Mes invalido: ${value}. Use AAAA-MM.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Mes invalido: ${value}. Use AAAA-MM.`);
  }

  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    month: `${year}-${String(month).padStart(2, "0")}`,
    startDate: `${year}-${String(month).padStart(2, "0")}-01`,
    endDate: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
    year,
    monthNumber: month,
    lastDay
  };
}

export function buildMonthlySummary({ month, hoursByDay = {}, maxHoursPerDay = 8, today }) {
  const range = monthRange(month);
  const limit = Number(maxHoursPerDay);
  const rows = [];

  for (let day = 1; day <= range.lastDay; day += 1) {
    const date = `${range.month}-${String(day).padStart(2, "0")}`;
    const weekday = new Date(Date.UTC(range.year, range.monthNumber - 1, day)).getUTCDay();
    const businessDay = weekday !== 0 && weekday !== 6;
    const hours = roundHours(hoursByDay[date] || 0);

    // Dias uteis sempre aparecem. Fim de semana so aparece se tiver apontamento,
    // pois nesse caso tambem e uma anomalia que o usuario precisa enxergar.
    if (!businessDay && hours <= 0) {
      continue;
    }

    rows.push({
      date,
      weekday,
      businessDay,
      future: Boolean(today && date > today),
      hours,
      remaining: roundHours(Math.max(0, limit - hours)),
      excess: roundHours(Math.max(0, hours - limit))
    });
  }

  const businessRows = rows.filter((row) => row.businessDay);
  const loggedHours = roundHours(
    Object.entries(hoursByDay)
      .filter(([date]) => date.startsWith(`${range.month}-`))
      .reduce((total, [, hours]) => total + Number(hours || 0), 0)
  );

  return {
    ...range,
    maxHoursPerDay: limit,
    rows,
    loggedHours,
    capacityHours: roundHours(businessRows.length * limit),
    completeDays: businessRows.filter((row) => row.hours === limit).length,
    overLimitDays: rows.filter((row) => row.excess > 0).length,
    incompletePastDays: businessRows.filter((row) => !row.future && row.hours < limit).length,
    futureBusinessDays: businessRows.filter((row) => row.future).length
  };
}

function isoDay(value) {
  const day = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

function roundHours(value) {
  return Math.round(Number(value) * 100) / 100;
}
