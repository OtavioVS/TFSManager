// Reconstroi "quanto foi lancado em cada dia" a partir do historico do card no TFS.
//
// O audit log local so conhece o que passou por esta instalacao: reinstalou, trocou
// de maquina ou lancou pela interface do TFS e a conta zera. O TFS, por outro lado,
// guarda toda alteracao de CompletedWork. Como este CLI escreve a data no comentario
// ("Refere-se ao dia AAAA-MM-DD"), da para recuperar o dia real de cada parcela.

const COMPLETED_WORK = "Microsoft.VSTS.Scheduling.CompletedWork";
const HISTORY = "System.History";
const DATA_NO_COMENTARIO = /Refere-se ao dia (\d{4}-\d{2}-\d{2})/;
// O TFS marca a revisao mais recente com esta data sentinela.
const REVISAO_ATUAL = "9999";

// Converte as revisoes de um work item em { "AAAA-MM-DD": horas }.
// Cada entrada vira { hours, exata } — exata=false quando a data saiu da data da
// revisao (lancamento feito fora deste CLI, sem comentario para ler).
export function hoursByDayFromUpdates(updates = [], options = {}) {
  const parcelas = [];

  for (const update of updates) {
    const campos = update?.fields || {};
    const completed = campos[COMPLETED_WORK];
    if (!completed) {
      continue;
    }

    const delta = toNumber(completed.newValue) - toNumber(completed.oldValue);
    if (delta === 0) {
      continue;
    }

    const comentario = campos[HISTORY]?.newValue || "";
    const doComentario = DATA_NO_COMENTARIO.exec(comentario)?.[1] || null;
    const dia = doComentario || diaDaRevisao(update);
    if (!dia) {
      continue;
    }

    if (delta > 0) {
      parcelas.push({
        dia,
        hours: delta,
        exata: Boolean(doComentario)
      });
      continue;
    }

    // Uma redução de CompletedWork invalida horas que haviam sido registradas
    // anteriormente. Remove primeiro as parcelas mais recentes.
    let correction = Math.abs(delta);
    for (let index = parcelas.length - 1; index >= 0 && correction > 0; index -= 1) {
      const parcela = parcelas[index];
      const removidas = Math.min(parcela.hours, correction);
      parcela.hours = arredondar(parcela.hours - removidas);
      correction = arredondar(correction - removidas);
    }
  }

  const currentCompleted = Number(options.currentCompleted);
  if (Number.isFinite(currentCompleted)) {
    let remaining = Math.max(0, arredondar(currentCompleted));
    for (let index = parcelas.length - 1; index >= 0 && remaining >= 0; index -= 1) {
      const parcela = parcelas[index];
      const mantidas = Math.min(parcela.hours, remaining);
      parcela.hours = mantidas;
      remaining = arredondar(remaining - mantidas);
    }
  }

  const totais = {};
  for (const parcela of parcelas) {
    if (parcela.hours <= 0) {
      continue;
    }
    const atual = totais[parcela.dia] || { hours: 0, exata: true };
    totais[parcela.dia] = {
      hours: arredondar(atual.hours + parcela.hours),
      exata: atual.exata && parcela.exata
    };
  }

  return totais;
}

// Junta audit, TFS e/ou Time Box pegando o maior valor de cada dia. O mesmo
// lancamento aparece em mais de uma fonte, entao somar contaria em dobro; o maior
// nunca subestima, que e o erro perigoso (subestimar liberaria passar de 8h).
// Cada fonte pode usar numero direto ou { hours, exata }.
export function mergeHoursByDay(...sources) {
  const fontes = sources.length > 0 ? sources : [{}];
  const dias = new Set(fontes.flatMap((source) => Object.keys(source || {})));
  const resultado = {};

  for (const dia of dias) {
    resultado[dia] = Math.max(
      ...fontes.map((source) => {
        const value = source?.[dia];
        return arredondar(typeof value === "object" && value !== null ? value.hours : value || 0);
      })
    );
  }

  return resultado;
}

// Dias cuja origem foi a data da revisao, e nao o comentario: a hora existe, mas o
// dia pode estar errado. Serve para avisar o usuario.
export function diasEstimados(doTfs = {}) {
  return Object.entries(doTfs)
    .filter(([, valor]) => !valor.exata)
    .map(([dia]) => dia)
    .sort();
}

function diaDaRevisao(update) {
  const data = String(update?.revisedDate || "").slice(0, 10);
  if (!data || data.startsWith(REVISAO_ATUAL)) {
    return null;
  }
  return data;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function arredondar(value) {
  return Math.round(value * 100) / 100;
}
