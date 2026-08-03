export class AzureDevOpsClient {
  constructor({ orgUrl, collectionUrl, project, pat, apiVersion = "7.1", fetchImpl = globalThis.fetch }) {
    this.baseUrl = normalizeBaseUrl(collectionUrl || orgUrl);
    this.project = project;
    this.pat = pat;
    this.apiVersion = apiVersion;
    this.fetch = fetchImpl;
  }

  async getWorkItem(id, fields = []) {
    const url = this.buildWorkItemUrl(id, {
      fields: fields.length > 0 ? fields.join(",") : undefined
    });

    const response = await this.fetch(url, {
      method: "GET",
      headers: this.headers()
    });

    return this.readResponse(response);
  }

  async updateWorkItem(id, operations, options = {}) {
    const url = this.buildWorkItemUrl(id, {
      validateOnly: options.validateOnly ? "true" : undefined,
      bypassRules: options.bypassRules ? "true" : undefined
    });

    const response = await this.fetch(url, {
      method: "PATCH",
      headers: {
        ...this.headers(),
        "content-type": "application/json-patch+json"
      },
      body: JSON.stringify(operations)
    });

    return this.readResponse(response);
  }

  async createWorkItem(workItemType, operations, options = {}) {
    const encodedType = encodeURIComponent(workItemType);
    const url = new URL(
      `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/wit/workitems/$${encodedType}`
    );
    url.searchParams.set("api-version", this.apiVersion);
    if (options.validateOnly) {
      url.searchParams.set("validateOnly", "true");
    }

    const response = await this.fetch(url, {
      method: "POST",
      headers: {
        ...this.headers(),
        "content-type": "application/json-patch+json"
      },
      body: JSON.stringify(operations)
    });

    return this.readResponse(response);
  }

  async queryWiql(query) {
    const url = new URL(`${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/wit/wiql`);
    url.searchParams.set("api-version", this.apiVersion);

    const response = await this.fetch(url, {
      method: "POST",
      headers: {
        ...this.headers(),
        "content-type": "application/json"
      },
      body: JSON.stringify({ query })
    });

    return this.readResponse(response);
  }

  // Revisoes do work item: usadas para reconstruir as horas ja lancadas por dia.
  async getWorkItemUpdates(id) {
    const url = new URL(`${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/wit/workitems/${id}/updates`);
    url.searchParams.set("api-version", this.apiVersion);

    const response = await this.fetch(url, {
      method: "GET",
      headers: this.headers()
    });

    return this.readResponse(response);
  }

  // Arvore de iteracoes com startDate/finishDate, usada para achar a janela da sprint.
  async getIterationNodes(depth = 6) {
    const url = new URL(`${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/wit/classificationnodes/Iterations`);
    url.searchParams.set("$depth", String(depth));
    url.searchParams.set("api-version", this.apiVersion);

    const response = await this.fetch(url, {
      method: "GET",
      headers: this.headers()
    });

    return this.readResponse(response);
  }

  async getConnectionData() {
    const url = new URL(`${this.baseUrl}/_apis/connectionData`);
    url.searchParams.set("api-version", "7.1-preview.1");

    const response = await this.fetch(url, {
      method: "GET",
      headers: this.headers()
    });

    return this.readResponse(response);
  }

  async getWorkItems(ids, fields = []) {
    if (!ids || ids.length === 0) {
      return { value: [] };
    }

    const collected = [];
    for (let start = 0; start < ids.length; start += 200) {
      const chunk = ids.slice(start, start + 200);
      const url = new URL(`${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/wit/workitems`);
      url.searchParams.set("ids", chunk.join(","));
      if (fields.length > 0) {
        url.searchParams.set("fields", fields.join(","));
      }
      url.searchParams.set("api-version", this.apiVersion);

      const response = await this.fetch(url, { method: "GET", headers: this.headers() });
      const body = await this.readResponse(response);
      collected.push(...(body.value || []));
    }

    return { value: collected };
  }

  buildWorkItemUrl(id, query = {}) {
    const encodedProject = encodeURIComponent(this.project);
    const url = new URL(`${this.baseUrl}/${encodedProject}/_apis/wit/workitems/${id}`);
    url.searchParams.set("api-version", this.apiVersion);

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    }

    return url;
  }

  headers() {
    if (!this.pat) {
      throw new Error("AZDO_PAT nao configurado.");
    }

    return {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`:${this.pat}`).toString("base64")}`
    };
  }

  async readResponse(response) {
    const text = await response.text();
    const body = text ? parseJson(text) : {};

    if (!response.ok) {
      throw new Error(`Erro Azure DevOps ${response.status}: ${JSON.stringify(body)}`);
    }

    return body;
  }
}

export const WORK_ITEM_FIELDS = [
  "System.Id",
  "System.Title",
  "System.Description",
  "System.WorkItemType",
  "System.AssignedTo",
  "System.State",
  "System.BoardColumn",
  "System.AreaPath",
  "System.IterationPath",
  "System.BoardColumnDone",
  "Microsoft.VSTS.Scheduling.CompletedWork",
  "Microsoft.VSTS.Scheduling.RemainingWork"
];

function normalizeBaseUrl(url) {
  if (!url) {
    throw new Error("AZDO_ORG_URL ou AZDO_COLLECTION_URL nao configurado.");
  }

  return url.replace(/\/+$/, "");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
