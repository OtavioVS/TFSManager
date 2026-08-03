import test from "node:test";
import assert from "node:assert/strict";
import { listAssignedCards } from "../src/work-items/list.js";

const config = {
  policy: {
    identitiesPath: "config/identities.json",
    identities: { Max: { displayName: "Max", azureDevOpsEmail: "max@empresa.com", aliases: ["eu"] } }
  }
};

const CARDS = [
  { id: 1, state: "New", iteration: "P\\Time\\2026 W24" },
  { id: 2, state: "Active", iteration: "P\\Time\\2026 W24" },
  { id: 3, state: "Closed", iteration: "P\\Time\\2026 W24" },
  { id: 4, state: "Resolved", iteration: "P\\Time\\2026 W26" }
];

function clienteFalso() {
  const chamadas = [];
  return {
    chamadas,
    async queryWiql(query) {
      chamadas.push(query);
      // Simula o servidor: o WIQL e quem esconde os Closed.
      const esconde = query.includes("<> 'Closed'");
      return { workItems: CARDS.filter((card) => !esconde || card.state !== "Closed").map((card) => ({ id: card.id })) };
    },
    async getWorkItems(ids) {
      return {
        value: CARDS.filter((card) => ids.includes(card.id)).map((card) => ({
          fields: {
            "System.Id": card.id,
            "System.Title": `Card ${card.id}`,
            "System.State": card.state,
            "System.IterationPath": card.iteration
          }
        }))
      };
    }
  };
}

test("without a status filter the query hides closed cards", async () => {
  const cliente = clienteFalso();
  const resultado = await listAssignedCards(cliente, config, { person: "Max" });

  assert.ok(cliente.chamadas[0].includes("<> 'Closed'"));
  assert.deepEqual(resultado.rows.map((row) => row.id), [1, 2, 4]);
});

test("sprint filters first, then status", async () => {
  const resultado = await listAssignedCards(clienteFalso(), config, {
    person: "Max",
    sprint: "2026 W24",
    states: "Active"
  });

  assert.equal(resultado.naSprint, 3, "tres cards na W24 antes do status");
  assert.deepEqual(resultado.rows.map((row) => row.id), [2]);
});

test("an explicit status brings closed cards back", async () => {
  const cliente = clienteFalso();
  const resultado = await listAssignedCards(cliente, config, { person: "Max", states: "Closed" });

  assert.ok(!cliente.chamadas[0].includes("<> 'Closed'"), "precisa trazer tudo do servidor");
  assert.deepEqual(resultado.rows.map((row) => row.id), [3]);
});

test("New,Active (the fill-sprint default) leaves Resolved and Closed out", async () => {
  const resultado = await listAssignedCards(clienteFalso(), config, { person: "Max", states: "New,Active" });

  assert.deepEqual(resultado.rows.map((row) => row.state).sort(), ["Active", "New"]);
  assert.ok(!resultado.rows.some((row) => row.state === "Resolved"), "Resolved fica de fora");
  assert.ok(!resultado.rows.some((row) => row.state === "Closed"), "Closed fica de fora");
});

test("status accepts a list and 'todos'", async () => {
  const varios = await listAssignedCards(clienteFalso(), config, { person: "Max", states: "new,active" });
  assert.deepEqual(varios.rows.map((row) => row.id), [1, 2]);

  const todos = await listAssignedCards(clienteFalso(), config, { person: "Max", states: "todos" });
  assert.deepEqual(todos.rows.map((row) => row.id), [1, 2, 3, 4]);
});
