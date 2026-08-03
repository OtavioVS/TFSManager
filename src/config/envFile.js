import fs from "node:fs";
import path from "node:path";

// Atualiza (ou cria) chaves no .env preservando comentarios e as demais linhas.
// updates = { CHAVE: "valor" }. Chaves existentes sao substituidas no lugar;
// novas sao anexadas ao fim.
export function updateEnvFile(filePath, updates) {
  const resolved = path.resolve(filePath);
  const linhas = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8").split(/\r?\n/) : [];
  const pendentes = new Map(Object.entries(updates));

  const saida = linhas.map((linha) => {
    const igual = linha.indexOf("=");
    if (igual < 0 || linha.trim().startsWith("#")) {
      return linha;
    }
    const chave = linha.slice(0, igual).trim();
    if (pendentes.has(chave)) {
      const valor = pendentes.get(chave);
      pendentes.delete(chave);
      return `${chave}=${valor}`;
    }
    return linha;
  });

  for (const [chave, valor] of pendentes) {
    saida.push(`${chave}=${valor}`);
  }

  // Evita linha em branco duplicada no fim.
  const texto = saida.join("\n").replace(/\n{3,}$/g, "\n\n");
  fs.writeFileSync(resolved, texto.endsWith("\n") ? texto : `${texto}\n`, "utf8");
}
