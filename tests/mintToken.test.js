import test from "node:test";
import assert from "node:assert/strict";
import { mintTimeboxToken } from "../src/timebox/mintToken.js";
import { parseTimeboxToken } from "../src/timebox/appToken.js";

const EU = {
  id: "user-guid",
  organizationId: "org-guid",
  name: "eu@empresa.com",
  displayName: "Eu Mesmo"
};

test("mintTimeboxToken produces a 3-part JWT with the loggedUser claim", () => {
  const jwt = mintTimeboxToken(EU, { now: 1000, ttlSeconds: 3600 });
  assert.equal(jwt.split(".").length, 3);

  // O proprio parser do projeto le de volta os campos.
  const lido = parseTimeboxToken(jwt);
  assert.equal(lido.kind, "timebox");
  assert.equal(lido.userId, "user-guid");
  assert.equal(lido.organizationId, "org-guid");
  assert.equal(lido.name, "eu@empresa.com");
  assert.equal(lido.displayName, "Eu Mesmo");
});

test("mintTimeboxToken carries only the identity it is given (sem impersonar)", () => {
  // Nao ha caminho para forjar outra pessoa: sai exatamente o que entra.
  const jwt = mintTimeboxToken(EU);
  const lido = parseTimeboxToken(jwt);
  assert.equal(lido.userId, EU.id);
  assert.equal(lido.name, EU.name);
});

test("mintTimeboxToken recusa identidade incompleta", () => {
  assert.throws(() => mintTimeboxToken({ id: "x", organizationId: "y" }), /name/);
  assert.throws(() => mintTimeboxToken({}), /id/);
});

test("mintTimeboxToken sets a future expiry (mesmo sem ser validada)", () => {
  const jwt = mintTimeboxToken(EU, { now: 1000, ttlSeconds: 3600 });
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
  assert.equal(payload.exp, 4600);
  assert.equal(payload.loggedUser.profile, 2);
});
