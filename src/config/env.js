import fs from "node:fs";
import path from "node:path";

export function loadDotEnv(filePath = ".env", target = process.env) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return;
  }

  const content = fs.readFileSync(resolved, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim().replace(/^[']|[']$/g, "").replace(/^["]|["]$/g, "");
    if (key && target[key] === undefined) {
      target[key] = value;
    }
  }
}

export function buildConfig(env = process.env) {
  const identityPath = env.AZDO_IDENTITIES_PATH || "config/identities.json";
  const taskboardColumnMap = parseColumnMap(env.AZDO_TASKBOARD_COLUMN_MAP);

  return {
    azureDevOps: {
      orgUrl: env.AZDO_ORG_URL || "",
      collectionUrl: env.AZDO_COLLECTION_URL || "",
      project: env.AZDO_PROJECT || "",
      pat: env.AZDO_PAT || "",
      apiVersion: env.AZDO_API_VERSION || "7.1",
      demandNumberField: env.AZDO_DEMAND_NUMBER_FIELD || "",
      allowedStates: parseList(env.AZDO_ALLOWED_STATES),
      taskboardColumnMap,
      allowedBoardColumns: Object.values(taskboardColumnMap).map((column) => column.name),
      requireAssignedToMatch: parseBoolean(env.AZDO_REQUIRE_ASSIGNED_TO_MATCH, true)
    },
    policy: {
      identitiesPath: identityPath,
      identities: loadIdentities(identityPath),
      maxHoursPerCommand: parseNumber(env.MAX_HOURS_PER_COMMAND, 8),
      maxHoursPerDay: parseNumber(env.MAX_HOURS_PER_DAY, 8),
      requireConfirmation: parseBoolean(env.REQUIRE_CONFIRMATION, false),
      // Lancar hora em dia que ainda nao aconteceu: por padrao so avisa.
      // ALLOW_FUTURE_HOURS=false transforma o aviso em bloqueio.
      allowFutureHours: parseBoolean(env.ALLOW_FUTURE_HOURS, true)
    },
    audit: {
      logPath: env.AUDIT_LOG_PATH || "logs/audit.jsonl"
    },
    timebox: {
      enabled: parseBoolean(env.TIMEBOX_ENABLED, false),
      apiUrl: env.TIMEBOX_API_URL || "",
      authToken: env.TIMEBOX_AUTH_TOKEN || "",
      // Gera o JWT localmente a partir da identidade, sem colar token.
      mintToken: parseBoolean(env.TIMEBOX_MINT_TOKEN, false),
      user: {
        id: env.TIMEBOX_USER_ID || "",
        organizationId: env.TIMEBOX_ORGANIZATION_ID || "",
        name: env.TIMEBOX_USER_NAME || "",
        displayName: env.TIMEBOX_USER_DISPLAY_NAME || "",
        appToken: env.TIMEBOX_APP_TOKEN || env.AZDO_PAT || ""
      }
    }
  };
}

export function assertRuntimeConfig(config, options = {}) {
  const missing = [];

  if (options.needsAzureDevOps) {
    if (!config.azureDevOps.orgUrl && !config.azureDevOps.collectionUrl) {
      missing.push("AZDO_ORG_URL ou AZDO_COLLECTION_URL");
    }
    if (!config.azureDevOps.project) {
      missing.push("AZDO_PROJECT");
    }
    if (!config.azureDevOps.pat) {
      missing.push("AZDO_PAT");
    }
  }

  if (options.needsTimebox) {
    if (!config.timebox.apiUrl) {
      missing.push("TIMEBOX_API_URL");
    }

    const user = config.timebox.user || {};
    if (!user.id) {
      missing.push("TIMEBOX_USER_ID");
    }

    // Com authToken pronto ou no modo mint (gera localmente), basta a identidade;
    // o app token so e exigido no caminho classico (PUT /v1/user).
    if (!config.timebox.authToken) {
      if (!user.organizationId) {
        missing.push("TIMEBOX_ORGANIZATION_ID");
      }
      if (!user.name) {
        missing.push("TIMEBOX_USER_NAME");
      }
      if (!user.displayName) {
        missing.push("TIMEBOX_USER_DISPLAY_NAME");
      }
      if (!config.timebox.mintToken && !user.appToken) {
        missing.push("TIMEBOX_APP_TOKEN");
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(`Configuracao ausente: ${missing.join(", ")}`);
  }
}

function loadIdentities(identityPath) {
  const resolved = path.resolve(identityPath);
  if (!fs.existsSync(resolved)) {
    return {};
  }

  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Arquivo de identidades invalido: ${identityPath}`);
  }

  return parsed;
}

function parseList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Mapeia colunas do taskboard para estados, ex: "New:New,Code Review:Resolved".
// A chave normalizada (minuscula, sem acento) aponta para { name, state }.
function parseColumnMap(value) {
  const map = {};
  if (!value) {
    return map;
  }

  for (const pair of value.split(",")) {
    const separatorIndex = pair.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }

    const name = pair.slice(0, separatorIndex).trim();
    const state = pair.slice(separatorIndex + 1).trim();
    if (name && state) {
      map[normalizeColumnKey(name)] = { name, state };
    }
  }

  return map;
}

function normalizeColumnKey(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function parseNumber(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "sim", "y"].includes(String(value).toLowerCase());
}