import crypto from "node:crypto";

// Monta localmente um JWT no formato que o backend do Time Box espera.
//
// O backend so faz ReadToken (nao valida assinatura nem expiracao) e le o claim
// "loggedUser". Por isso conseguimos gerar o token aqui, sem depender de colar nada
// do navegador. IMPORTANTE: o token carrega SEMPRE a identidade do proprio usuario
// (vinda do PAT/.env). Nao ha entrada para forjar outra pessoa.
//
// Isso funciona porque o backend nao confere a assinatura — e uma fragilidade dele.
// Se um dia passar a validar, este modo para de funcionar (o --apply avisa).

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

export function mintTimeboxToken(user, { now = Math.floor(Date.now() / 1000), ttlSeconds = 3600 } = {}) {
  const faltando = ["id", "organizationId", "name", "displayName"].filter((campo) => !user?.[campo]);
  if (faltando.length > 0) {
    throw new Error(`Nao da para gerar o token do Time Box sem: ${faltando.join(", ")}.`);
  }

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: "ArcelorMittal Sistemas",
    aud: "ArcelorMittal Sistemas",
    exp: now + ttlSeconds,
    loggedUser: {
      id: user.id,
      organizationId: user.organizationId,
      profile: user.profile ?? 2,
      name: user.name,
      displayName: user.displayName,
      appToken: user.appToken || ""
    }
  };

  const semAssinatura = `${base64url(header)}.${base64url(payload)}`;
  // Assinatura com chave local qualquer: o backend nao a verifica, mas assim o
  // token fica bem-formado.
  const assinatura = crypto.createHmac("sha256", "amstbc-local").update(semAssinatura).digest("base64url");
  return `${semAssinatura}.${assinatura}`;
}
