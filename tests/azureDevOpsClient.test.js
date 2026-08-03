import test from "node:test";
import assert from "node:assert/strict";
import { AzureDevOpsClient } from "../src/azure-devops/client.js";

test("AzureDevOpsClient builds get work item request", async () => {
  let capturedRequest;
  const client = new AzureDevOpsClient({
    orgUrl: "https://dev.azure.com/org",
    project: "Projeto X",
    pat: "pat",
    fetchImpl: async (url, options) => {
      capturedRequest = { url: String(url), options };
      return jsonResponse({ id: 123, rev: 4, fields: {} });
    }
  });

  const workItem = await client.getWorkItem(123, ["System.Id", "System.State"]);

  assert.equal(workItem.id, 123);
  assert.match(capturedRequest.url, /https:\/\/dev\.azure\.com\/org\/Projeto%20X\/_apis\/wit\/workitems\/123/);
  assert.match(capturedRequest.url, /api-version=7\.1/);
  assert.match(capturedRequest.url, /fields=System\.Id%2CSystem\.State/);
  assert.equal(capturedRequest.options.method, "GET");
  assert.match(capturedRequest.options.headers.authorization, /^Basic /);
});

test("AzureDevOpsClient sends json patch update", async () => {
  let capturedRequest;
  const client = new AzureDevOpsClient({
    collectionUrl: "https://servidor/tfs/Collection",
    project: "Projeto",
    pat: "pat",
    fetchImpl: async (url, options) => {
      capturedRequest = { url: String(url), options };
      return jsonResponse({ id: 123, rev: 5, fields: {} });
    }
  });

  await client.updateWorkItem(123, [{ op: "test", path: "/rev", value: 4 }]);

  assert.match(capturedRequest.url, /https:\/\/servidor\/tfs\/Collection\/Projeto\/_apis\/wit\/workitems\/123/);
  assert.equal(capturedRequest.options.method, "PATCH");
  assert.equal(capturedRequest.options.headers["content-type"], "application/json-patch+json");
  assert.equal(capturedRequest.options.body, JSON.stringify([{ op: "test", path: "/rev", value: 4 }]));
});

test("AzureDevOpsClient creates a work item with json patch", async () => {
  let capturedRequest;
  const client = new AzureDevOpsClient({
    orgUrl: "https://dev.azure.com/org",
    project: "Projeto X",
    pat: "pat",
    fetchImpl: async (url, options) => {
      capturedRequest = { url: String(url), options };
      return jsonResponse({ id: 456, url: "https://dev.azure.com/org/Projeto%20X/_apis/wit/workItems/456" }, 201);
    }
  });

  const operations = [{ op: "add", path: "/fields/System.Title", value: "Tarefa" }];
  const result = await client.createWorkItem("Task", operations);

  assert.equal(result.id, 456);
  assert.match(capturedRequest.url, /\/_apis\/wit\/workitems\/\$Task/);
  assert.match(capturedRequest.url, /api-version=7\.1/);
  assert.equal(capturedRequest.options.method, "POST");
  assert.equal(capturedRequest.options.headers["content-type"], "application/json-patch+json");
  assert.equal(capturedRequest.options.body, JSON.stringify(operations));
});


test("AzureDevOpsClient builds connection data request", async () => {
  let capturedRequest;
  const client = new AzureDevOpsClient({
    orgUrl: "https://dev.azure.com/org",
    project: "Projeto",
    pat: "pat",
    fetchImpl: async (url, options) => {
      capturedRequest = { url: String(url), options };
      return jsonResponse({ instanceId: "org-id", authenticatedUser: { id: "user-id" } });
    }
  });

  const result = await client.getConnectionData();

  assert.equal(result.instanceId, "org-id");
  assert.match(capturedRequest.url, /https:\/\/dev\.azure\.com\/org\/_apis\/connectionData/);
  assert.match(capturedRequest.url, /api-version=7\.1-preview\.1/);
  assert.equal(capturedRequest.options.method, "GET");
});
test("AzureDevOpsClient posts a wiql query", async () => {
  let capturedRequest;
  const client = new AzureDevOpsClient({
    orgUrl: "https://dev.azure.com/org",
    project: "Projeto",
    pat: "pat",
    fetchImpl: async (url, options) => {
      capturedRequest = { url: String(url), options };
      return jsonResponse({ workItems: [{ id: 1 }, { id: 2 }] });
    }
  });

  const result = await client.queryWiql("SELECT [System.Id] FROM WorkItems");

  assert.deepEqual(result.workItems, [{ id: 1 }, { id: 2 }]);
  assert.match(capturedRequest.url, /\/_apis\/wit\/wiql/);
  assert.equal(capturedRequest.options.method, "POST");
  assert.equal(capturedRequest.options.body, JSON.stringify({ query: "SELECT [System.Id] FROM WorkItems" }));
});

test("AzureDevOpsClient batches getWorkItems by ids", async () => {
  let capturedRequest;
  const client = new AzureDevOpsClient({
    orgUrl: "https://dev.azure.com/org",
    project: "Projeto",
    pat: "pat",
    fetchImpl: async (url, options) => {
      capturedRequest = { url: String(url), options };
      return jsonResponse({ value: [{ id: 10 }, { id: 11 }] });
    }
  });

  const result = await client.getWorkItems([10, 11], ["System.Id", "System.State"]);

  assert.equal(result.value.length, 2);
  assert.match(capturedRequest.url, /\/_apis\/wit\/workitems\?/);
  assert.match(capturedRequest.url, /ids=10%2C11/);
  assert.match(capturedRequest.url, /fields=System\.Id%2CSystem\.State/);
  assert.equal(capturedRequest.options.method, "GET");
});

test("AzureDevOpsClient getWorkItems returns empty without ids", async () => {
  const client = new AzureDevOpsClient({
    orgUrl: "https://dev.azure.com/org",
    project: "Projeto",
    pat: "pat",
    fetchImpl: async () => {
      throw new Error("nao deveria chamar fetch");
    }
  });

  const result = await client.getWorkItems([]);
  assert.deepEqual(result.value, []);
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}
