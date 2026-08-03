// Extrai a configuracao do Timebox de um token colado do navegador.
//
// A extensao autentica com dois tokens encadeados:
//   1. App token do Azure DevOps (iss "app.vstoken.visualstudio.com"): identifica
//      o usuario, mas NAO carrega o organizationId interno do Timebox.
//   2. JWT do Timebox (iss "ArcelorMittal Sistemas"): traz um "loggedUser" com id,
//      organizationId, name, displayName e o app token aninhado.
//
// No F12 -> Network, o header Authorization das chamadas ao backend e o JWT do
// Timebox (2). Dele sai tudo o que precisamos, inclusive o app token para renovar.

export function decodeJwtPayload(token) {
  const parte = String(token || "").split(".")[1];
  if (!parte) {
    return null;
  }

  try {
    const json = Buffer.from(parte.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Recebe o texto colado (com ou sem o prefixo "Bearer ") e devolve os campos de
// config do Timebox. `kind` distingue os dois formatos aceitos.
export function parseTimeboxToken(pasted) {
  const token = String(pasted || "").trim().replace(/^Bearer\s+/i, "");
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return { kind: "invalid" };
  }

  // JWT do Timebox: tem loggedUser com tudo.
  if (payload.loggedUser) {
    const user = payload.loggedUser;
    return {
      kind: "timebox",
      authToken: token,
      appToken: user.appToken || "",
      userId: user.id || "",
      organizationId: user.organizationId || "",
      name: user.name || "",
      displayName: user.displayName || "",
      exp: payload.exp || null,
      appTokenExp: decodeJwtPayload(user.appToken)?.exp || null
    };
  }

  // App token do Azure DevOps: identifica o usuario, sem o organizationId do Timebox.
  if (payload.iss && String(payload.iss).includes("vstoken")) {
    return {
      kind: "app",
      appToken: token,
      userId: payload.nameid || "",
      organizationId: "",
      exp: payload.exp || null,
      appTokenExp: payload.exp || null
    };
  }

  return { kind: "invalid" };
}

// Segundos restantes ate expirar (negativo = ja expirou). null se sem exp.
export function secondsUntilExpiry(exp, now = Math.floor(Date.now() / 1000)) {
  if (!exp) {
    return null;
  }
  return exp - now;
}

export function isExpired(exp, now = Math.floor(Date.now() / 1000)) {
  const restante = secondsUntilExpiry(exp, now);
  return restante !== null && restante <= 0;
}
