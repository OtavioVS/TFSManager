# =====================================================================
#  Apontador de horas Azure DevOps - interface facil (menu interativo)
#  Uso: rode "apontar.cmd" (dois cliques) ou: powershell -File apontar.ps1
# =====================================================================
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
try { $OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new() } catch {}

function Titulo($txt) {
  Write-Host ""
  Write-Host ("=" * 60) -ForegroundColor DarkCyan
  Write-Host "  $txt" -ForegroundColor Cyan
  Write-Host ("=" * 60) -ForegroundColor DarkCyan
}

function Erro($txt)  { Write-Host $txt -ForegroundColor Red }
function Ok($txt)    { Write-Host $txt -ForegroundColor Green }
function Aviso($txt) { Write-Host $txt -ForegroundColor Yellow }
function Enter-Continuar { Read-Host "`nPressione Enter para voltar ao menu" | Out-Null }

# Grava UTF-8 SEM BOM (BOM quebraria o JSON.parse do Node no identities.json).
function Gravar-Utf8($caminho, $conteudo) {
  [System.IO.File]::WriteAllText($caminho, $conteudo, (New-Object System.Text.UTF8Encoding($false)))
}

# --- Pre-requisitos -------------------------------------------------
function Checar-Node {
  try { node --version | Out-Null } catch {
    Erro "Node.js nao encontrado. Instale o Node 20+ em https://nodejs.org e rode de novo."
    exit 1
  }
}

# --- Setup guiado na 1a vez ----------------------------------------
function Garantir-Configuracao {
  if (-not (Test-Path ".env")) {
    Titulo "Primeira configuracao (.env)"
    Write-Host "Vou criar seu arquivo .env. Tecle Enter para aceitar o padrao entre [colchetes]."
    $org  = Read-Host "URL da organizacao [https://tfsams.visualstudio.com]"
    if (-not $org)  { $org  = "https://tfsams.visualstudio.com" }
    $proj = Read-Host "Projeto [LCB-TI]"
    if (-not $proj) { $proj = "LCB-TI" }
    Write-Host "PAT (token) - gere em $org/_usersSettings/tokens com escopo 'Work Items: Read & Write'."
    $patSec = Read-Host "Cole seu PAT" -AsSecureString
    $pat = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
             [Runtime.InteropServices.Marshal]::SecureStringToBSTR($patSec))
    if (-not $pat) { Erro "PAT vazio. Abortando."; exit 1 }

    $envText = @"
AZDO_ORG_URL=$org
AZDO_PROJECT=$proj
AZDO_PAT=$pat
AZDO_API_VERSION=7.1

AZDO_ALLOWED_STATES=New,Active,Resolved,Closed
AZDO_TASKBOARD_COLUMN_MAP=New:New,Active:Active,Code Review:Resolved,Closed:Closed

AZDO_IDENTITIES_PATH=config/identities.json
AZDO_REQUIRE_ASSIGNED_TO_MATCH=true

MAX_HOURS_PER_COMMAND=8
MAX_HOURS_PER_DAY=8
REQUIRE_CONFIRMATION=false
AUDIT_LOG_PATH=logs/audit.jsonl

AZDO_DEMAND_NUMBER_FIELD=Custom.bef8a8bc-fe87-48b5-b28e-50656841f0eb

TIMEBOX_ENABLED=false
TIMEBOX_API_URL=https://amstl.agendaaqui.com.br/api
TIMEBOX_MINT_TOKEN=false
TIMEBOX_USER_ID=
TIMEBOX_AUTH_TOKEN=
TIMEBOX_ORGANIZATION_ID=
TIMEBOX_USER_NAME=
TIMEBOX_USER_DISPLAY_NAME=
TIMEBOX_APP_TOKEN=
"@
    Gravar-Utf8 (Join-Path $PSScriptRoot ".env") $envText
    Ok "Arquivo .env criado."
  }

  if (-not (Test-Path "config/identities.json")) {
    Titulo "Sua identidade"
    Write-Host "Pra validar que o card e seu, preciso do seu nome e e-mail do Azure DevOps."
    $nome  = Read-Host "Seu primeiro nome (ex.: Gabriel)"
    $email = Read-Host "Seu e-mail no Azure DevOps (ex.: nome@arcelormittal.com.br)"
    if (-not $nome -or -not $email) { Erro "Nome/e-mail vazios. Abortando."; exit 1 }
    $ident = @{ $nome = @{ displayName = $nome; azureDevOpsEmail = $email; aliases = @("eu","me","pra mim",$nome.ToLower()) } }
    if (-not (Test-Path "config")) { New-Item -ItemType Directory "config" | Out-Null }
    Gravar-Utf8 (Join-Path $PSScriptRoot "config/identities.json") ($ident | ConvertTo-Json -Depth 5)
    Ok "Identidade salva."
  }
}

# --- Descobre a pessoa configurada ---------------------------------
function Pessoa-Padrao {
  $json = Get-Content "config/identities.json" -Raw | ConvertFrom-Json
  $chaves = @($json.PSObject.Properties.Name)
  if ($chaves.Count -eq 1) { return $chaves[0] }
  Write-Host "Identidades disponiveis:"
  for ($i=0; $i -lt $chaves.Count; $i++) { Write-Host ("  [{0}] {1}" -f ($i+1), $chaves[$i]) }
  $sel = Read-Host "Escolha (numero)"
  $idx = [int]$sel - 1
  if ($idx -ge 0 -and $idx -lt $chaves.Count) { return $chaves[$idx] }
  return $chaves[0]
}

# --- Executa o CLI e captura saida ---------------------------------
function Rodar-CLI([string[]]$cliArgs) {
  return (& node "src/cli.js" @cliArgs 2>&1 | Out-String)
}

function Extrair-Json([string]$saida) {
  $i = $saida.IndexOf("{")
  if ($i -lt 0) { return $null }
  try { return ($saida.Substring($i) | ConvertFrom-Json) } catch { return $null }
}

function Mostrar-Plano($r) {
  if (-not $r) { return }
  if (-not $r.ok) {
    Erro "`nBLOQUEADO ($($r.stage)):"
    foreach ($e in $r.errors) { Erro "  - $e" }
    return
  }
  Write-Host "`nCard: " -NoNewline; Write-Host $r.workItem.title -ForegroundColor White
  Write-Host ("Responsavel: {0}" -f $r.workItem.assignedTo)
  $c = $r.changes
  Write-Host "`nO que vai mudar:" -ForegroundColor Yellow
  if ($c.completedWork) { Write-Host ("  Horas feitas : {0}h -> {1}h" -f $c.completedWork.from, $c.completedWork.to) }
  if ($c.remainingWork) { Write-Host ("  A fazer      : {0}h -> {1}h" -f $c.remainingWork.from, $c.remainingWork.to) }
  if ($c.state)         { Write-Host ("  Estado/coluna: {0} -> {1}" -f $c.state.from, $c.state.to) }
  $hist = ($r.operations | Where-Object { $_.path -eq "/fields/System.History" }).value
  if ($hist) { Write-Host ("  Comentario   : {0}" -f $hist) }
  if ($r.dailyHours) {
    $d = $r.dailyHours
    $origem = if ($null -ne $d.timeboxHours) {
      "Time Box: $($d.timeboxHours)h; audit local: $($d.auditHours)h"
    } else {
      "audit local: $($d.auditHours)h"
    }
    Write-Host ("  Limite diario: {0}; depois deste lancamento: {1}h de {2}h" -f `
      $origem, $d.nextTotal, $d.maxHoursPerDay)
  }
  if ($r.timebox -and $r.timebox.enabled) {
    Write-Host ("  Timebox      : criar {0} min em {1} (semana {2})" -f `
      $r.timebox.appointment.workedMinutes, $r.timebox.appointment.workedAt, $r.timebox.appointment.workedWeek)
  }
  foreach ($w in $r.warnings) { Aviso "  (aviso) $w" }
}

# Roda dry-run, mostra o plano, confirma e (se ok) grava direto.
function Apontar-DryRun-E-Aplicar($base, $card) {
  Write-Host "`nSimulando (nada e gravado ainda)..." -ForegroundColor DarkGray
  $saida = Rodar-CLI (@("--dry-run") + $base)
  $r = Extrair-Json $saida
  if (-not $r) { Erro "Nao entendi a resposta do servico:"; Write-Host $saida; return }
  Mostrar-Plano $r
  if (-not $r.ok) { return }

  $alvo = if ($r.timebox -and $r.timebox.enabled) { "Azure DevOps e Timebox" } else { "Azure DevOps" }
  $conf = Read-Host "`nConfirma e grava no $alvo? (s/n)"
  if ($conf -match '^(s|sim|y)$') {
    $saida2 = Rodar-CLI (@("--apply") + $base)
    $r2 = Extrair-Json $saida2
    if ($r2 -and $r2.ok) {
      Ok "`nAPLICADO! Card $card atualizado (rev $($r2.updatedWorkItem.rev))."
      Write-Host ("  Horas feitas: {0}h | A fazer: {1}h | Estado: {2}" -f `
        $r2.updatedWorkItem.completedWork, $r2.updatedWorkItem.remainingWork, $r2.updatedWorkItem.state)
      if ($r2.timebox -and $r2.timebox.stage -eq "applied") {
        Ok ("  Timebox: apontamento criado para {0} ({1} min)." -f `
          $r2.timebox.appointment.workedAt, $r2.timebox.appointment.workedMinutes)
      }
    } elseif ($r2 -and $r2.stage -eq "applied-with-timebox-error") {
      Aviso "`nPARCIAL: Azure DevOps foi atualizado, mas o Timebox falhou."
      Write-Host ("  Card $card atualizado (rev $($r2.updatedWorkItem.rev)).")
      Erro ("  Timebox: {0}" -f $r2.timebox.error)
    } else {
      Erro "Falhou ao aplicar:"; Write-Host $saida2
    }
  } else {
    Aviso "Cancelado. Nada foi gravado."
  }
}
# Chama o Haiku (via claude CLI) para interpretar texto livre -> JSON.
function Tem-Claude { return [bool](Get-Command claude -ErrorAction SilentlyContinue) }

function Interpretar-Com-Haiku($texto) {
  $hoje = (Get-Date).ToString("yyyy-MM-dd")
  $cult = [Globalization.CultureInfo]::GetCultureInfo("pt-BR")
  $dsem = (Get-Date).ToString("dddd", $cult)
  $prompt = @"
Voce extrai dados de um apontamento de horas no Azure DevOps. Hoje e $hoje ($dsem).
A pessoa descreveu o que fez num card. Extraia e devolva SOMENTE um JSON numa linha (sem markdown, sem texto antes ou depois):
{"hours": <numero ou null>, "date": "AAAA-MM-DD ou null", "column": "<New|Active|Code Review|Closed> ou null", "comment": "<texto ou null>"}

Regras:
- hours: numero de horas (ex: 4, 1.5). null se nao disser.
- date: resolva "hoje", "ontem", "anteontem", dias da semana, para AAAA-MM-DD. Se nao disser, use $hoje.
- column: so preencha se a pessoa pedir para mover o card. Mapeie: novo=New; comecei/em andamento/ativo=Active; revisao/code review/para revisar=Code Review; terminei/concluido/fechar=Closed. null se nao mencionar mover.
- comment: comentario livre se houver, senao null.

Descricao: "$texto"
"@
  Write-Host "Haiku interpretando..." -ForegroundColor DarkGray
  # O prompt vai pelo STDIN (o arg -p quebra com \n e aspas no Windows PowerShell 5.1).
  $out = ($prompt | claude -p --model claude-haiku-4-5-20251001 2>&1 | Out-String)
  return (Extrair-JsonBloco $out), $out
}

function Extrair-JsonBloco($texto) {
  $a = $texto.IndexOf("{"); $b = $texto.LastIndexOf("}")
  if ($a -lt 0 -or $b -le $a) { return $null }
  try { return ($texto.Substring($a, $b - $a + 1) | ConvertFrom-Json) } catch { return $null }
}

# --- Acao: apontar inteligente (Haiku interpreta) -------------------
# Monta o comando a partir de uma frase em portugues. Devolve $null se nao
# conseguir entender, para o fluxo cair nas perguntas.
function Montar-Por-Descricao($card, $pessoa, $texto) {
  $res = Interpretar-Com-Haiku $texto
  $dados = $res[0]
  if (-not $dados) { Aviso "Nao entendi a frase; vou perguntar passo a passo."; return $null }

  $hours = $dados.hours
  if (-not $hours) { Aviso "Nao identifiquei as horas; vou perguntar passo a passo."; return $null }
  $hours = ("$hours") -replace ',','.'

  $hoje = (Get-Date).ToString("yyyy-MM-dd")
  $date = if ($dados.date) { "$($dados.date)" } else { $hoje }
  $colsOk = @("New","Active","Code Review","Closed")
  $column = if ($dados.column -and ($colsOk -contains "$($dados.column)")) { "$($dados.column)" } else { "" }
  $comment = if ($dados.comment) { "$($dados.comment)" } else { "" }

  Write-Host "`nEntendi:" -ForegroundColor Cyan
  Write-Host ("  Horas : {0}" -f $hours)
  Write-Host ("  Data  : {0}" -f $date)
  Write-Host ("  Coluna: {0}" -f ($(if ($column) { $column } else { "(nao mover)" })))
  if ($comment) { Write-Host ("  Coment: {0}" -f $comment) }

  $base = @("--work-item-id",$card,"--person",$pessoa,"--hours",$hours,"--date",$date)
  if ($column)  { $base += @("--column",$column) }
  if ($comment) { $base += @("--comment",$comment) }
  return ,$base
}

# --- Acao: listar ---------------------------------------------------
function Acao-Listar($pessoa) {
  Titulo "Ver meus cards"

  # Primeiro a semana, depois o status.
  $sprint = Read-Host "Sprint (ex.: 2026 W24) [Enter = todas]"

  Write-Host "`nStatus:"
  Write-Host "  [1] Abertos (New/Active/Resolved)   [Enter]"
  Write-Host "  [2] Todos, inclusive fechados"
  Write-Host "  [3] So New        [4] So Active"
  Write-Host "  [5] So Resolved   [6] So Closed"
  $opc = Read-Host "Escolha"
  $status = switch ($opc) {
    "2" { "todos" }
    "3" { "New" }
    "4" { "Active" }
    "5" { "Resolved" }
    "6" { "Closed" }
    default { "" }
  }

  $listArgs = @("--list","--person",$pessoa)
  if ($sprint) { $listArgs += @("--sprint",$sprint) }
  if ($status) { $listArgs += @("--status",$status) }

  Write-Host ""
  & node "src/cli.js" @listArgs
  Enter-Continuar
}

# --- Acao: visao mensal --------------------------------------------
function Acao-Visao-Mensal($pessoa) {
  Titulo "Visao mensal de horas"
  $mesAtual = (Get-Date).ToString("yyyy-MM")
  $mes = Read-Host "Mes (AAAA-MM) [Enter = $mesAtual]"
  if (-not $mes) { $mes = $mesAtual }
  if ($mes -notmatch '^\d{4}-(0[1-9]|1[0-2])$') {
    Erro "Mes invalido. Use AAAA-MM, por exemplo $mesAtual."
    Enter-Continuar
    return
  }

  Write-Host ""
  & node "src/cli.js" --month $mes --person $pessoa
  if ($LASTEXITCODE -ne 0) {
    Erro "`nNao foi possivel montar a visao mensal."
  }
  Enter-Continuar
}

# Monta o comando perguntando campo a campo.
function Montar-Por-Perguntas($card, $pessoa) {
  $horas = Read-Host "Horas (ate 8, ex.: 2 ou 1.5)"
  if ($horas -notmatch '^\d+([.,]\d+)?$') { Erro "Horas invalidas."; return $null }
  $horas = $horas -replace ',','.'

  $hoje = (Get-Date).ToString("yyyy-MM-dd")
  $data = Read-Host "Data (AAAA-MM-DD) [Enter = hoje $hoje]"
  if (-not $data) { $data = $hoje }

  Write-Host "Mover para: [1] New  [2] Active  [3] Code Review  [4] Closed  [5] nao mover"
  $opc = Read-Host "Escolha [Enter = nao mover]"
  $coluna = switch ($opc) { "1"{"New"} "2"{"Active"} "3"{"Code Review"} "4"{"Closed"} default {""} }

  $coment = Read-Host "Comentario (opcional) [Enter = automatico]"

  $base = @("--work-item-id",$card,"--person",$pessoa,"--hours",$horas,"--date",$data)
  if ($coluna) { $base += @("--column",$coluna) }
  if ($coment) { $base += @("--comment",$coment) }
  return ,$base
}

# --- Acao: apontar um card ------------------------------------------
# Um caminho so: se der, entende a frase em portugues; se nao, pergunta.
function Acao-Apontar($pessoa) {
  Titulo "Apontar um card"
  $card = Read-Host "ID do card (ex.: 1070143)"
  if ($card -notmatch '^\d+$') { Erro "ID invalido."; Enter-Continuar; return }

  $base = $null
  if (Tem-Claude) {
    Write-Host "`nEx.: '4h de ontem e move pra Active'" -ForegroundColor DarkGray
    $texto = Read-Host "Descreva em portugues [Enter = responder passo a passo]"
    if ($texto) { $base = Montar-Por-Descricao $card $pessoa $texto }
  }

  if (-not $base) { $base = Montar-Por-Perguntas $card $pessoa }
  if (-not $base) { Enter-Continuar; return }

  Apontar-DryRun-E-Aplicar $base $card
  Enter-Continuar
}

# --- Acao: lancar a sprint inteira -----------------------------------
function Acao-Fechar-Sprint($pessoa) {
  Titulo "Lancar a sprint inteira"
  Write-Host "Pega seus cards New e Active e usa as horas restantes de cada um."
  Write-Host "Se um card nao tiver estimativa, divide as horas livres da sprint pelo"
  Write-Host "total de cards. Resolved/Closed ficam de fora.`n"

  $sprint = Read-Host "Sprint (ex.: 2026 W24) [Enter = detectar a atual]"

  Write-Host "`nAo terminar cada card, mover para:"
  Write-Host "  [1] Closed   [2] Resolved   [3] Nao mover"
  $opc = Read-Host "Escolha [Enter = 1]"
  $estado = switch ($opc) { "2" { "Resolved" } "3" { "" } default { "Closed" } }

  $coment = Read-Host "`nComentario nos lancamentos (opcional) [Enter = automatico]"

  $base = @("--fill-sprint","--person",$pessoa)
  if ($sprint) { $base += @("--sprint",$sprint) }
  if ($estado) { $base += @("--state",$estado) }
  if ($coment) { $base += @("--comment",$coment) }

  Write-Host "`nSimulando (nada e gravado ainda)...`n" -ForegroundColor DarkGray
  & node "src/cli.js" @base
  if ($LASTEXITCODE -ne 0) { Erro "`nA simulacao falhou. Nada foi gravado."; Enter-Continuar; return }

  $conf = Read-Host "`nConfirma e grava tudo isso no Azure DevOps e no Time Box (quando ligado)? (s/n)"
  if ($conf -match '^(s|sim|y)$') {
    Write-Host ""
    & node "src/cli.js" @($base + @("--apply"))
    if ($LASTEXITCODE -eq 0) {
      Ok "`nSprint lancada!"
    } else {
      Erro "`nFalhou no meio do caminho. Veja acima ate onde foi gravado."
    }
  } else {
    Aviso "Cancelado. Nada foi gravado."
  }
  Enter-Continuar
}

# --- Acao: criar tarefas filhas de uma user story --------------------
function Acao-Criar-Tarefas {
  Titulo "Criar tarefas de uma user story"
  $story = Read-Host "ID da user story (ex.: 12345)"
  if ($story -notmatch '^\d+$') {
    Erro "ID invalido."
    Enter-Continuar
    return
  }

  $fases = Read-Host "Fases (develop,homologation,deployment) [Enter = todas]"
  $base = @("--create-tasks", "--user-story-id", $story)
  if ($fases) { $base += @("--phases", $fases) }

  Write-Host "`nSimulando (nada e gravado ainda)..." -ForegroundColor DarkGray
  $saida = Rodar-CLI (@("--dry-run") + $base)
  $r = Extrair-Json $saida
  if (-not $r) {
    Erro "Nao entendi a resposta do servico:"
    Write-Host $saida
    Enter-Continuar
    return
  }
  if (-not $r.ok) {
    Erro "`nBLOQUEADO ($($r.stage)):"
    foreach ($e in $r.errors) { Erro "  - $e" }
    Enter-Continuar
    return
  }

  Write-Host "`nUser story: $($r.userStory.title)" -ForegroundColor White
  Write-Host "Tipo: $($r.userStory.type)"
  Write-Host "Tarefas que serao criadas:" -ForegroundColor Yellow
  foreach ($task in $r.tasks) {
    Write-Host ("  [{0}] {1}" -f $task.phaseLabel, $task.title)
  }

  $conf = Read-Host "`nConfirma e cria essas tarefas no Azure DevOps? (s/n)"
  if ($conf -match '^(s|sim|y)$') {
    $saida2 = Rodar-CLI (@("--apply") + $base)
    $r2 = Extrair-Json $saida2
    if ($r2 -and $r2.ok) {
      Ok "`nTarefas criadas com sucesso:"
      foreach ($task in $r2.created) {
        Ok ("  #{0} [{1}] {2}" -f $task.id, $task.phaseLabel, $task.title)
      }
    } else {
      Erro "Falhou ao criar as tarefas:"
      Write-Host $saida2
    }
  } else {
    Aviso "Cancelado. Nada foi gravado."
  }
  Enter-Continuar
}

# --- Acao: configuracao ---------------------------------------------
function Acao-Configuracao {
  Titulo "Configuracao"
  & node "src/cli.js" --config-status

  Write-Host "`n  [1] Refazer a configuracao do zero"
  if ($script:temVariasIdentidades) { Write-Host "  [2] Trocar identidade" }
  Write-Host "  [Enter] Voltar"
  $op = Read-Host "`nEscolha"

  if ($op -eq "1") {
    Aviso "`nIsso recomeca o setup. O .env atual vira .env.bak (nada e perdido)."
    $conf = Read-Host "Confirma? (s/n)"
    if ($conf -match '^(s|sim|y)$') {
      if (Test-Path ".env") { Move-Item ".env" ".env.bak" -Force }
      if (Test-Path "config/identities.json") { Move-Item "config/identities.json" "config/identities.json.bak" -Force }
      Garantir-Configuracao
      $script:pessoa = Pessoa-Padrao
      Ok "Configuracao refeita."
    } else {
      Aviso "Cancelado. Nada mudou."
    }
  } elseif ($op -eq "2" -and $script:temVariasIdentidades) {
    $script:pessoa = Pessoa-Padrao
  }

  Enter-Continuar
}

# --- Acao: status do Time Box Control -------------------------------
function Acao-Timebox {
  Titulo "Time Box Control"
  & node "src/cli.js" --timebox-status

  Write-Host "`n  [1] Colar token novo do navegador"
  Write-Host "  [2] Tentar modo automatico (somente backend antigo)"
  Write-Host "  [Enter] Voltar"
  $op = Read-Host "`nEscolha"

  if ($op -eq "1") {
    Write-Host "`nComo pegar o token:" -ForegroundColor DarkGray
    Write-Host "  1) Abra o Time Box Control no Azure DevOps" -ForegroundColor DarkGray
    Write-Host "  2) F12 -> aba Network -> clique em qualquer chamada para amstl.agendaaqui.com.br" -ForegroundColor DarkGray
    Write-Host "  3) Em Headers, copie o valor de 'Authorization' (comeca com 'Bearer eyJ...')" -ForegroundColor DarkGray
    $token = Read-Host "`nCole aqui o token"
    if (-not $token) { Aviso "Nada colado."; Enter-Continuar; return }

    Write-Host ""
    & node "src/cli.js" --timebox-token "$token"
  } elseif ($op -eq "2") {
    Write-Host ""
    & node "src/cli.js" --timebox-setup
  }

  Enter-Continuar
}

function Acao-Ajuda {
  Titulo "Ajuda / Exemplos"
  Write-Host @"
[1] LANCAR A SPRINT  - o caminho normal, resolve tudo de uma vez.
    Aperta Enter na pergunta da sprint (ele acha a atual sozinho),
    escolhe Closed, confere e confirma. Ele lanca as horas que faltam
    em todos os seus cards abertos, ate 8h por dia, e fecha os cards.

[2] APONTAR UM CARD  - para lancar horas soltas num card so.
    Se voce tiver o 'claude' CLI, da pra escrever "4h de ontem e move
    pra Active". Senao (ou se apertar Enter), ele pergunta campo a campo.

[3] VER MEUS CARDS   - lista o que esta aberto, com o ID de cada um.

[4] VISAO MENSAL      - consulta o Time Box dia a dia, mostra o que falta
    para 8h e destaca qualquer dia que passou do limite.

[5] CRIAR TAREFAS     - le uma user story e cria tarefas filhas para
    desenvolvimento, homologacao e implantacao (fases selecionaveis).

Regras que ele aplica sozinho:
  - Maximo 8 horas por dia, consultando tambem o Time Box antes de gravar.
  - Fim de semana nunca recebe hora.
  - AVISA quando as horas caem em dia que ainda nao aconteceu.
  - Sempre SIMULA antes; so grava depois do seu 's'.

Pela linha de comando:
  node src/cli.js --list
  node src/cli.js --month 2026-07
  node src/cli.js --fill-sprint --state Closed
  node src/cli.js --fill-sprint --sprint "2026 W24" --state Closed
  node src/cli.js --create-tasks --user-story-id 12345 --phases develop,homologation
"@
  Enter-Continuar
}

# --- Loop principal -------------------------------------------------
Checar-Node
Garantir-Configuracao
$script:pessoa = Pessoa-Padrao
# "Trocar identidade" so aparece (dentro de Configuracao) com mais de uma cadastrada.
$script:temVariasIdentidades = @((Get-Content "config/identities.json" -Raw | ConvertFrom-Json).PSObject.Properties.Name).Count -gt 1

$rodando = $true
while ($rodando) {
  Clear-Host
  Titulo "Apontador de Horas - Azure DevOps"
  Write-Host ("Operando como: {0}`n" -f $script:pessoa) -ForegroundColor Green
  Write-Host "  [1] Lancar a sprint      " -NoNewline
  Write-Host "tudo que falta, e fecha os cards" -ForegroundColor DarkGray
  Write-Host "  [2] Apontar um card      " -NoNewline
  Write-Host "horas num card so" -ForegroundColor DarkGray
  Write-Host "  [3] Ver meus cards"
  Write-Host "  [4] Visao mensal         " -NoNewline
  Write-Host "horas por dia e limite de 8h" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  [5] Criar tarefas        " -NoNewline
  Write-Host "cards filhos de uma user story" -ForegroundColor DarkGray
  Write-Host "  [6] Configuracao         " -NoNewline
  Write-Host "servidor, token, limites" -ForegroundColor DarkGray
  Write-Host "  [7] Time Box Control     " -NoNewline
  Write-Host "status da integracao" -ForegroundColor DarkGray
  Write-Host "  [8] Ajuda"
  Write-Host "  [0] Sair"
  $op = Read-Host "`nEscolha"
  switch ($op) {
    "1" { Acao-Fechar-Sprint $script:pessoa }
    "2" { Acao-Apontar $script:pessoa }
    "3" { Acao-Listar $script:pessoa }
    "4" { Acao-Visao-Mensal $script:pessoa }
    "5" { Acao-Criar-Tarefas }
    "6" { Acao-Configuracao }
    "7" { Acao-Timebox }
    "8" { Acao-Ajuda }
    "0" { Write-Host "Ate mais!" -ForegroundColor Cyan; $rodando = $false }
    default { Aviso "Opcao invalida."; Start-Sleep -Milliseconds 800 }
  }
}
