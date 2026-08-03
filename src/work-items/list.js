import { normalizeIdentity } from "./policy.js";

const LIST_FIELDS = [
  "System.Id",
  "System.Title",
  "System.WorkItemType",
  "System.State",
  "System.BoardColumn",
  "System.IterationPath",
  "Microsoft.VSTS.Scheduling.CompletedWork",
  "Microsoft.VSTS.Scheduling.RemainingWork"
];

// Lista work items atribuidos a uma pessoa, com filtro opcional por sprint.
export async function listAssignedCards(azureDevOpsClient, config, options = {}) {
  const personName = options.person || onlyIdentityKey(config.policy.identities);
  const identity = normalizeIdentity(personName, config.policy.identities);
  if (!identity || !identity.azureDevOpsEmail) {
    throw new Error(
      `Pessoa nao mapeada em ${config.policy.identitiesPath}: ${personName || "(nenhuma informada)"}.`
    );
  }

  const email = identity.azureDevOpsEmail.replace(/'/g, "''");
  // Filtrar por status explicito implica trazer tudo do servidor e peneirar aqui.
  const states = normalizeStates(options.states);
  const trazerTudo = options.includeClosed || states.length > 0;
  const stateClause = trazerTudo ? "" : "AND [System.State] <> 'Closed' ";
  const query =
    `SELECT [System.Id] FROM WorkItems ` +
    `WHERE [System.AssignedTo] = '${email}' ${stateClause}` +
    `ORDER BY [System.ChangedDate] DESC`;

  const wiql = await azureDevOpsClient.queryWiql(query);
  const ids = (wiql.workItems || []).map((item) => item.id);
  const detail = await azureDevOpsClient.getWorkItems(ids, LIST_FIELDS);

  let rows = detail.value.map((workItem) => toRow(workItem.fields || {}));
  const totalAssigned = rows.length;

  // A semana filtra primeiro; o status refina o que sobrou.
  if (options.sprint) {
    const needle = normalizeText(options.sprint);
    rows = rows.filter((row) => normalizeText(row.iterationPath).includes(needle));
  }

  const naSprint = rows.length;

  if (states.length > 0 && !states.includes("todos")) {
    rows = rows.filter((row) => states.includes(normalizeText(row.state)));
  }

  return {
    person: identity.displayName,
    sprint: options.sprint || null,
    states,
    totalAssigned,
    naSprint,
    rows
  };
}

function toRow(fields) {
  return {
    id: fields["System.Id"],
    type: fields["System.WorkItemType"] || "",
    state: fields["System.State"] || "",
    boardColumn: fields["System.BoardColumn"] || "",
    completed: fields["Microsoft.VSTS.Scheduling.CompletedWork"] ?? "",
    remaining: fields["Microsoft.VSTS.Scheduling.RemainingWork"] ?? "",
    iterationPath: fields["System.IterationPath"] || "",
    title: fields["System.Title"] || ""
  };
}

// Aceita "Active", "active,resolved", "todos"/"all".
function normalizeStates(value) {
  if (!value) {
    return [];
  }

  const lista = Array.isArray(value) ? value : String(value).split(",");
  return lista
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .map((item) => (item === "all" ? "todos" : item));
}

function onlyIdentityKey(identities = {}) {
  const keys = Object.keys(identities);
  return keys.length === 1 ? keys[0] : null;
}

function normalizeText(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}
