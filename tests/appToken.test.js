import test from "node:test";
import assert from "node:assert/strict";
import { decodeJwtPayload, isExpired, parseTimeboxToken, secondsUntilExpiry } from "../src/timebox/appToken.js";

// Monta um JWT so com o payload (assinatura irrelevante para decodificar).
function jwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ typ: "JWT" })}.${b64(payload)}.assinatura`;
}

const APP_TOKEN = jwt({ nameid: "user-guid", tid: "tenant-guid", iss: "app.vstoken.visualstudio.com", exp: 2000000000 });
const NESTED_APP = jwt({ nameid: "user-guid", iss: "app.vstoken.visualstudio.com", exp: 2000000000 });
const TIMEBOX_JWT = jwt({
  iss: "ArcelorMittal Sistemas",
  exp: 2000000500,
  loggedUser: {
    id: "user-guid",
    organizationId: "org-guid",
    name: "fulano@empresa.com",
    displayName: "Fulano de Tal",
    appToken: NESTED_APP
  }
});

test("decodeJwtPayload reads the payload and rejects junk", () => {
  assert.equal(decodeJwtPayload(TIMEBOX_JWT).iss, "ArcelorMittal Sistemas");
  assert.equal(decodeJwtPayload("nao-e-jwt"), null);
  assert.equal(decodeJwtPayload(""), null);
});

test("parseTimeboxToken extracts everything from the Timebox JWT", () => {
  const dados = parseTimeboxToken(`Bearer ${TIMEBOX_JWT}`);

  assert.equal(dados.kind, "timebox");
  assert.equal(dados.userId, "user-guid");
  assert.equal(dados.organizationId, "org-guid", "o org id vem do loggedUser, nao do tid");
  assert.equal(dados.name, "fulano@empresa.com");
  assert.equal(dados.displayName, "Fulano de Tal");
  assert.equal(dados.appToken, NESTED_APP);
  assert.equal(dados.authToken, TIMEBOX_JWT, "prefixo 'Bearer ' e removido");
});

test("parseTimeboxToken recognizes a bare app token but has no org", () => {
  const dados = parseTimeboxToken(APP_TOKEN);

  assert.equal(dados.kind, "app");
  assert.equal(dados.userId, "user-guid");
  assert.equal(dados.organizationId, "", "app token nao carrega o org id do Timebox");
});

test("parseTimeboxToken flags unrecognized tokens", () => {
  assert.equal(parseTimeboxToken("").kind, "invalid");
  assert.equal(parseTimeboxToken(jwt({ foo: "bar" })).kind, "invalid");
});

test("expiry helpers compute remaining time", () => {
  const agora = 1000;
  assert.equal(secondsUntilExpiry(1600, agora), 600);
  assert.equal(isExpired(900, agora), true);
  assert.equal(isExpired(1600, agora), false);
  assert.equal(secondsUntilExpiry(null), null);
  assert.equal(isExpired(null), false);
});
