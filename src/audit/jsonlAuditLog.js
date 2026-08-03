import fs from "node:fs";
import path from "node:path";

export class JsonlAuditLog {
  constructor(logPath) {
    this.logPath = logPath;
  }

  append(entry) {
    if (!this.logPath) {
      return;
    }

    const resolved = path.resolve(this.logPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.appendFileSync(resolved, `${JSON.stringify(redact(entry))}\n`, "utf8");
  }
}

function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|pat|apiKey|authorization|secret|password/i.test(key)) {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = redact(item);
    }
  }
  return redacted;
}
