import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskCardService,
  buildTaskCards,
  decomposeUserStory,
  normalizeTaskPhases
} from "../src/work-items/task-cards.js";

const story = {
  id: 321,
  url: "https://dev.azure.com/org/project/_apis/wit/workItems/321",
  fields: {
    "System.WorkItemType": "User Story",
    "System.Title": "Permitir importar pedidos",
    "System.Description": "<p>O operador deve importar pedidos do arquivo.</p>",
    "System.AssignedTo": { displayName: "Ana", uniqueName: "ana@empresa.com" },
    "System.AreaPath": "Projeto\\Equipe",
    "System.IterationPath": "Projeto\\Sprint 1"
  }
};

test("normalizeTaskPhases accepts aliases and removes duplicates", () => {
  assert.deepEqual(
    normalizeTaskPhases("desenvolvimento, homolog, deploy, develop"),
    ["develop", "homologation", "deployment"]
  );
});

test("buildTaskCards creates child task patches from the user story", () => {
  const tasks = buildTaskCards(story, ["develop", "deployment"]);

  assert.equal(tasks.length, 4);
  assert.equal(tasks[0].title, "[Desenvolvimento] Implementar: Permitir importar pedidos");
  assert.deepEqual(
    tasks[0].operations.find((operation) => operation.path === "/fields/Microsoft.VSTS.Common.Activity"),
    { op: "add", path: "/fields/Microsoft.VSTS.Common.Activity", value: "Development" }
  );
  assert.match(tasks[0].description, /Entregar o comportamento descrito/);
  assert.match(tasks[0].description, /Trecho relacionado: O operador deve importar pedidos/);
  assert.deepEqual(
    tasks[0].operations.find((operation) => operation.path === "/fields/System.AssignedTo"),
    { op: "add", path: "/fields/System.AssignedTo", value: "ana@empresa.com" }
  );
  assert.deepEqual(
    tasks[0].operations.find((operation) => operation.path === "/relations/-").value,
    {
      rel: "System.LinkTypes.Hierarchy-Reverse",
      url: story.url,
      attributes: { comment: "Tarefa gerada para a fase de Desenvolvimento." }
    }
  );
});

test("decomposeUserStory creates focused development tasks instead of a story clone", () => {
  const specifications = decomposeUserStory({
    storyTitle: "Escalonamento de Execuções",
    storyDescription:
      "O sistema deve registrar execuções, inserir cenários em uma fila FIFO, validar inputs, " +
      "exibir status na interface e manter logs para auditoria."
  });

  assert.equal(specifications.length, 5);
  assert.deepEqual(
    specifications.map((specification) => specification.title),
    [
      "Modelar o ciclo de vida das execuções",
      "Implementar fila e processamento assíncrono",
      "Implementar submissão e validação dos cenários",
      "Implementar acompanhamento das execuções no ScrApp",
      "Implementar resiliência, auditoria e segurança"
    ]
  );
  assert.ok(specifications.every((specification) => specification.activities.length > 0));
});

test("homologation uses the Homologation activity", () => {
  const tasks = buildTaskCards(story, ["homologation"]);

  assert.equal(tasks.length, 3);
  assert.equal(
    new Set(tasks.map((task) =>
      task.operations.find((operation) => operation.path === "/fields/Microsoft.VSTS.Common.Activity").value
    )).size,
    1
  );
  assert.ok(tasks.every((task) => task.title.startsWith("[Homologação] ")));
});

test("TaskCardService applies one child task per selected phase", async () => {
  const createdTypes = [];
  const service = new TaskCardService({
    azureDevOpsClient: {
      buildWorkItemUrl: () => story.url,
      getWorkItem: async () => story,
      createWorkItem: async (type, operations) => {
        createdTypes.push({ type, operations });
        return { id: createdTypes.length, url: `https://example.test/${createdTypes.length}` };
      }
    }
  });

  const result = await service.apply({
    userStoryId: 321,
    phases: "develop,homologation",
    workItemType: "Task"
  });

  assert.equal(result.ok, true);
  assert.equal(result.stage, "applied");
  assert.deepEqual(result.created.map((item) => item.phase), [
    "develop",
    "homologation",
    "homologation",
    "homologation"
  ]);
  assert.deepEqual(createdTypes.map((item) => item.type), ["Task", "Task", "Task", "Task"]);
  assert.equal(createdTypes.length, 4);
});

test("TaskCardService rejects non-Task child types", async () => {
  const service = new TaskCardService({
    azureDevOpsClient: {
      getWorkItem: async () => story
    }
  });

  await assert.rejects(
    () => service.plan({ userStoryId: 321, phases: "develop", workItemType: "User Story" }),
    /somente work items do tipo Task/
  );
});

test("TaskCardService blocks non-story parents", async () => {
  const service = new TaskCardService({
    azureDevOpsClient: {
      getWorkItem: async () => ({
        ...story,
        fields: { ...story.fields, "System.WorkItemType": "Task" }
      })
    }
  });

  const result = await service.plan({ userStoryId: 321, phases: "develop" });

  assert.equal(result.ok, false);
  assert.equal(result.stage, "task-card-validation");
  assert.match(result.errors[0], /nao de user story/);
});
