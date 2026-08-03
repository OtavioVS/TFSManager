export function normalizeCommand(input) {
  const missingFields = Array.isArray(input.missingFields) ? input.missingFields : [];

  return {
    action: "log_time_and_move_card",
    workItemId: normalizeInteger(input.workItemId),
    personName: normalizeNullableString(input.personName),
    completedWorkDelta: normalizeNumber(input.completedWorkDelta),
    remainingWorkDelta: normalizeNumber(input.remainingWorkDelta),
    targetState: normalizeNullableString(input.targetState),
    targetBoardColumn: normalizeNullableString(input.targetBoardColumn),
    workDate: normalizeNullableString(input.workDate),
    comment: normalizeNullableString(input.comment),
    confidence: normalizeConfidence(input.confidence),
    needsConfirmation: Boolean(input.needsConfirmation),
    forceRemainingZero: Boolean(input.forceRemainingZero),
    missingFields
  };
}

export function commandFromFlags(args) {
  return normalizeCommand({
    workItemId: args.workItemId,
    personName: args.personName,
    completedWorkDelta: args.completedWorkDelta,
    remainingWorkDelta: args.remainingWorkDelta,
    targetState: args.targetState,
    targetBoardColumn: args.targetBoardColumn,
    workDate: args.workDate,
    comment: args.comment,
    confidence: args.confidence ?? 1,
    needsConfirmation: args.needsConfirmation,
    forceRemainingZero: args.forceRemainingZero,
    missingFields: args.missingFields
  });
}

export function parseMissingFields(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function normalizeConfidence(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.min(1, Math.max(0, parsed));
}
