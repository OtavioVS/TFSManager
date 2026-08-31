# =====================================================================
#  Apontador de horas - Azure DevOps + Time Box
#  Interface amigavel (menu interativo)
#  Uso: dois cliques em "apontar.cmd" ou: powershell -File apontar.ps1
#
#  Dicas globais:
#   - Enter aceita o valor entre [colchetes]
#   - Digite 'v' em qualquer pergunta para voltar sem gravar nada
#   - Toda gravacao passa por uma simulacao antes
# =====================================================================
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
try { $OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new() } catch {}

# Sentinela para "usuario pediu para voltar" (nunca colide com texto real).
$script:VOLTAR = "__VOLTAR__"
$script:LARGURA = 60

# --- UI basica ------------------------------------------------------

function Linha($car = "=", $cor = "DarkCyan") {
  Write-Host ("  " + ($car * $script:LARGURA)) -ForegroundColor $cor
}

function Titulo($txt, $sub = "") {
  Write-Host ""
  Linha "=" "DarkCyan"
  Write-Host ("  " + $txt) -ForegroundColor Cyan
  if ($sub) { Write-Host ("  " + $sub) -ForegroundColor DarkGray }
  Linha "=" "DarkCyan"
}

function Ok($txt)    { Write-Host ("  [OK] " + $txt) -ForegroundColor Green }
function Erro($txt)  { Write-Host ("  [X] " + $txt) -ForegroundColor Red }
function Aviso($txt) { Write-Host ("  [!] " + $txt) -ForegroundColor Yellow }
function Info($txt)  { Write-Host ("  " + $txt) -ForegroundColor DarkGray }
function Passo($txt) { Write-Host ("  >> " + $txt) -ForegroundColor DarkCyan }

function Enter-Continuar { Read-Host "`n  Pressione Enter para voltar ao menu" | Out-Null }

# Pergunta com valor padrao entre [colchetes]. 'v' volta ($null no chamador).
function Perguntar($texto, $padrao = "") {
  $dica = if ($padrao) { " [$padrao]" } else { "" }
  $r = Read-Host ("  {0}{1}" -f $texto, $dica)
  if ($r -match '^(v|voltar)$') { return $script:VOLTAR }
  if (-not $r) { return $padrao }
  return $r.Trim()
}

function Confirmar($texto) {
  $r = Read-Host ("`n  " + $texto + " (s/n)")
  return ($r -match '^(s|sim|y|yes)$')
}

# Pergunta com validacao: repete ate valor valido ou 'v'.
function Perguntar-Validado($texto, $padrao, $regex, $mensagemErro) {
  while ($true) {
    $r = Perguntar $texto $padrao
    if ($r -eq $script:VOLTAR) { return $script:VOLTAR }
    if ($r -match $regex) { return $r }
    Erro $mensagemErro
  }
}

# Item de menu alinhado em duas colunas.
function Item-Menu($n, $nome, $desc) {
  Write-Host ("   [{0}] " -f $n) -NoNewline -ForegroundColor Yellow
  if ($desc) {
    Write-Host ($nome.PadRight(18)) -NoNewline -ForegroundColor White
    Write-Host $desc -ForegroundColor DarkGray
  } else {
    Write-Host $nome -ForegroundColor White
  }
}

function Secao-Menu($nome) {
  Write-Host ""
  Write-Host ("  " + $nome) -ForegroundColor Cyan
  Write-Host ("  " + ("-" * $script:LARGURA)) -ForegroundColor DarkCyan
}

# --- Utilidades -----------------------------------------------------

# Grava UTF-8 SEM BOM (BOM quebraria o JSON.parse do Node no identities.json).
function Gravar-Utf8($caminho, $conteudo) {
  [System.IO.File]::WriteAllText($caminho, $conteudo, (New-Object System.Text.UTF8Encoding($false)))
}

# --- Pre-requisitos -------------------------------------------------

function Checar-Node {
  try {
    $v = (node --version) 2>$null
    if (-not $v) { throw "sem node" }
    $maior = [int]($v.TrimStart('v').Split('.')[0])
    if ($maior -lt 20) {
      Erro "Node $v encontrado, mas e preciso o Node 20+ (https://nodejs.org)."
      exit 1
    }
  } catch {
    Erro "Node.js nao encontrado. Instale o Node 20+ em https://nodejs.org e rode de novo."
    exit 1
  }
}

# --- Setup guiado na 1a vez ----------------------------------------

function Garantir-Configuracao {
  if (-not (Test-Path ".env")) {
    Titulo "Primeira configuracao" "vou criar seu arquivo .env; Enter aceita o [padrao]"
    $org  = Perguntar "URL da organizacao" "https://tfsams.visualstudio.com"
    $proj = Perguntar "Projeto" "LCB-TI"
    Info "Gere o PAT em: $org/_usersSettings/tokens"
    Info "Escopo necessario: 'Work Items: Read & Write'."
    $patSec = Read-Host "  Cole seu PAT" -AsSecureString
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
    Titulo "Sua identidade" "valida que o card e seu antes de gravar"
    $nome  = Perguntar "Seu primeiro nome (ex.: Gabriel)"
    $email = Perguntar "Seu e-mail no Azure DevOps (ex.: nome@empresa.com.br)"
    if (-not $nome -or -not $email -or $nome -eq $script:VOLTAR -or $email -eq $script:VOLTAR) {
      Erro "Nome/e-mail vazios. Abortando."
      exit 1
    }
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
  Titulo "Escolha a identidade"
  for ($i=0; $i -lt $chaves.Count; $i++) { Item-Menu ($i+1) $chaves[$i] "" }
  $sel = Perguntar "Escolha (numero)" "1"
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

# --- Plano de um card (dry-run) -------------------------------------

function Mostrar-Plano($r) {
  if (-not $r) { return }
  if (-not $r.ok) {
    Write-Host ""
    Linha "-" "Red"
    Erro "BLOQUEADO ($($r.stage)):"
    foreach ($e in $r.errors) { Write-Host ("     - $e") -ForegroundColor Red }
    Linha "-" "Red"
    return
  }
  Write-Host ""
  Linha "-" "DarkGray"
  Write-Host "  Card: " -NoNewline; Write-Host $r.workItem.title -ForegroundColor White
  Write-Host ("  Responsavel: {0}" -f $r.workItem.assignedTo)
  $c = $r.changes
  Write-Host ""
  Write-Host "  O que vai mudar:" -ForegroundColor Yellow
  if ($c.completedWork) { Write-Host ("    Horas feitas : {0}h -> {1}h" -f $c.completedWork.from, $c.completedWork.to) }
  if ($c.remainingWork) { Write-Host ("    A fazer      : {0}h -> {1}h" -f $c.remainingWork.from, $c.remainingWork.to) }
  if ($c.state)         { Write-Host ("    Estado/coluna: {0} -> {1}" -f $c.state.from, $c.state.to) }
  $hist = ($r.operations | Where-Object { $_.path -eq "/fields/System.History" }).value
  if ($hist) { Write-Host ("    Comentario   : {0}" -f $hist) }
  if ($r.dailyHours) {
    $d = $r.dailyHours
    $origem = if ($null -ne $d.timeboxHours) {
      "Time Box: $($d.timeboxHours)h; audit local: $($d.auditHours)h"
    } else {
      "audit local: $($d.auditHours)h"
    }
    Write-Host ("    Limite diario: {0}; depois: {1}h de {2}h" -f `
      $origem, $d.nextTotal, $d.maxHoursPerDay)
  }
  if ($r.timebox -and $r.timebox.enabled) {
    Write-Host ("    Time Box     : criar {0} min em {1} (semana {2})" -f `
      $r.timebox.appointment.workedMinutes, $r.timebox.appointment.workedAt, $r.timebox.appointment.workedWeek)
  }
  foreach ($w in $r.warnings) { Aviso $w }
  Linha "-" "DarkGray"
}

# Roda dry-run, mostra o plano, confirma e (se ok) grava direto.
function Apontar-DryRun-E-Aplicar($base, $card) {
  Passo "Simulando (nada e gravado ainda)..."
  $saida = Rodar-CLI (@("--dry-run") + $base)
  $r = Extrair-Json $saida
  if (-not $r) { Erro "Nao entendi a resposta do servico:"; Write-Host $saida; return }
  Mostrar-Plano $r
  if (-not $r.ok) { return }

  $alvo = if ($r.timebox -and $r.timebox.enabled) { "Azure DevOps e Time Box" } else { "Azure DevOps" }
  if (Confirmar "Confirma e grava no $alvo?") {
    Passo "Gravando..."
    $saida2 = Rodar-CLI (@("--apply") + $base)
    $r2 = Extrair-Json $saida2
    if ($r2 -and $r2.ok) {
      Write-Host ""
      Linha "-" "Green"
      Ok "APLICADO! Card $card atualizado (rev $($r2.updatedWorkItem.rev))."
      Write-Host ("     Horas feitas: {0}h | A fazer: {1}h | Estado: {2}" -f `
        $r2.updatedWorkItem.completedWork, $r2.updatedWorkItem.remainingWork, $r2.updatedWorkItem.state)
      if ($r2.timebox -and $r2.timebox.stage -eq "applied") {
        Ok ("Time Box: apontamento criado para {0} ({1} min)." -f `
          $r2.timebox.appointment.workedAt, $r2.timebox.appointment.workedMinutes)
      }
      Linha "-" "Green"
    } elseif ($r2 -and $r2.stage -eq "applied-with-timebox-error") {
      Aviso "PARCIAL: Azure DevOps foi atualizado, mas o Time Box falhou."
      Write-Host ("     Card $card atualizado (rev $($r2.updatedWorkItem.rev)).")
      Erro ("Time Box: {0}" -f $r2.timebox.error)
    } else {
      Erro "Falhou ao aplicar:"; Write-Host $saida2
    }
  } else {
    Aviso "Cancelado. Nada foi gravado."
  }
}

# --- Interpretacao com Haiku (claude CLI) ---------------------------

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
  Passo "Interpretando com Haiku..."
  # O prompt vai pelo STDIN (o arg -p quebra com \n e aspas no Windows PowerShell 5.1).
  $out = ($prompt | claude -p --model claude-haiku-4-5-20251001 2>&1 | Out-String)
  return (Extrair-JsonBloco $out), $out
}

function Extrair-JsonBloco($texto) {
  $a = $texto.IndexOf("{"); $b = $texto.LastIndexOf("}")
  if ($a -lt 0 -or $b -le $a) { return $null }
  try { return ($texto.Substring($a, $b - $a + 1) | ConvertFrom-Json) } catch { return $null }
}

# --- Montagem do apontamento avulso ---------------------------------

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

  Write-Host ""
  Linha "-" "DarkGray"
  Write-Host "  Entendi:" -ForegroundColor Cyan
  Write-Host ("    Horas     : {0}" -f $hours)
  Write-Host ("    Data      : {0}" -f $date)
  Write-Host ("    Coluna    : {0}" -f ($(if ($column) { $column } else { "(nao mover)" })))
  if ($comment) { Write-Host ("    Comentario: {0}" -f $comment) }
  Linha "-" "DarkGray"

  $base = @("--work-item-id",$card,"--person",$pessoa,"--hours",$hours,"--date",$date)
  if ($column)  { $base += @("--column",$column) }
  if ($comment) { $base += @("--comment",$comment) }
  return ,$base
}

# Monta o comando perguntando campo a campo.
function Montar-Por-Perguntas($card, $pessoa) {
  $horas = Perguntar-Validado "Horas (ate 8, ex.: 2 ou 1.5)" "" '^\d+([.,]\d+)?$' "Horas invalidas - use numero, ex.: 4 ou 1.5"
  if ($horas -eq $script:VOLTAR) { return $null }
  $horas = $horas -replace ',','.'

  $hoje = (Get-Date).ToString("yyyy-MM-dd")
  $data = Perguntar-Validado "Data (AAAA-MM-DD)" $hoje '^\d{4}-\d{2}-\d{2}$' "Data invalida - use AAAA-MM-DD"
  if ($data -eq $script:VOLTAR) { return $null }

  Write-Host ""
  Info "Mover o card para:"
  Item-Menu "1" "New" ""
  Item-Menu "2" "Active" ""
  Item-Menu "3" "Code Review" ""
  Item-Menu "4" "Closed" ""
  $opc = Perguntar "Mover para" "nao mover"
  if ($opc -eq $script:VOLTAR) { return $null }
  $coluna = switch ($opc) { "1"{"New"} "2"{"Active"} "3"{"Code Review"} "4"{"Closed"} default {""} }

  $coment = Perguntar "Comentario (opcional)"
  if ($coment -eq $script:VOLTAR) { return $null }

  $base = @("--work-item-id",$card,"--person",$pessoa,"--hours",$horas,"--date",$data)
  if ($coluna) { $base += @("--column",$coluna) }
  if ($coment) { $base += @("--comment",$coment) }
  return ,$base
}

# --- Acao: apontar um card ------------------------------------------

function Acao-Apontar($pessoa) {
  Titulo "Apontar um card" "horas avulsas; digite 'v' para voltar"
  $card = Perguntar-Validado "ID do card (ex.: 1070143)" "" '^\d+$' "ID invalido - somente numeros."
  if ($card -eq $script:VOLTAR) { return }

  $base = $null
  if (Tem-Claude) {
    Write-Host ""
    Info "Com o claude CLI instalado, voce pode descrever em portugues."
    Info "Ex.: '4h de ontem e move pra Active'"
    $texto = Perguntar "Descreva [Enter = responder passo a passo]"
    if ($texto -eq $script:VOLTAR) { return }
    if ($texto) { $base = Montar-Por-Descricao $card $pessoa $texto }
  }

  if (-not $base) { $base = Montar-Por-Perguntas $card $pessoa }
  if (-not $base) { Enter-Continuar; return }

  Apontar-DryRun-E-Aplicar $base $card
  Enter-Continuar
}

# --- Acao: lancar a sprint inteira -----------------------------------

function Acao-Fechar-Sprint($pessoa) {
  Titulo "Lancar a sprint inteira" "cards New/Active; horas livres divididas entre eles"
  Info "Pega seus cards New e Active e usa as horas restantes de cada um."
  Info "Se um card nao tiver estimativa, divide as horas livres da sprint"
  Info "pelo total de cards. Resolved/Closed ficam de fora."
  Write-Host ""

  $sprint = Perguntar "Sprint (ex.: 2026 W24)" "detectar a atual"
  if ($sprint -eq $script:VOLTAR) { return }
  if ($sprint -eq "detectar a atual") { $sprint = "" }

  $estado = Escolher-Estado-Final
  if ($estado -eq $script:VOLTAR) { return }

  $coment = Perguntar "Comentario nos lancamentos (opcional)"
  if ($coment -eq $script:VOLTAR) { return }

  $base = @("--fill-sprint","--person",$pessoa)
  if ($sprint) { $base += @("--sprint",$sprint) }
  if ($estado) { $base += @("--state",$estado) }
  if ($coment) { $base += @("--comment",$coment) }

  Confirmar-E-Aplicar-Lote $base "Sprint lancada!" "Azure DevOps e no Time Box (quando ligado)"
  Enter-Continuar
}

# --- Acao: lancar o mes inteiro -------------------------------------

function Acao-Fechar-Mes($pessoa) {
  Titulo "Lancar o mes inteiro" "board Kanban mensal; 8h por dia util"
  Info "Distribui as horas pelos dias uteis do mes, respeitando 8h/dia."
  Info "Usa os cards New e Active da iteracao mensal e desconta horas"
  Info "ja lancadas em outras sprints no mesmo mes."
  Write-Host ""

  $mesAtual = (Get-Date).ToString("yyyy-MM")
  $mes = Perguntar-Validado "Mes (AAAA-MM)" $mesAtual '^\d{4}-(0[1-9]|1[0-2])$' "Mes invalido - use AAAA-MM, por exemplo $mesAtual."
  if ($mes -eq $script:VOLTAR) { return }

  $partes = $mes.Split("-")
  $iteracaoPadrao = "{0} M{1}" -f $partes[0], $partes[1]
  $iteracao = Perguntar "Iteracao mensal" $iteracaoPadrao
  if ($iteracao -eq $script:VOLTAR) { return }

  $estado = Escolher-Estado-Final
  if ($estado -eq $script:VOLTAR) { return }

  $coment = Perguntar "Comentario nos lancamentos (opcional)"
  if ($coment -eq $script:VOLTAR) { return }

  $base = @("--fill-month","--month",$mes,"--sprint",$iteracao,"--person",$pessoa)
  if ($estado) { $base += @("--state",$estado) }
  if ($coment) { $base += @("--comment",$coment) }

  Confirmar-E-Aplicar-Lote $base "Mes lancado!" "Azure DevOps e no Time Box (quando ligado)"
  Enter-Continuar
}

# Estado final comum aos fechamentos de sprint/mes.
function Escolher-Estado-Final {
  Write-Host ""
  Info "Ao terminar cada card, mover para:"
  Item-Menu "1" "Closed" ""
  Item-Menu "2" "Resolved" ""
  Item-Menu "3" "Nao mover" ""
  $opc = Perguntar "Escolha" "1"
  if ($opc -eq $script:VOLTAR) { return $script:VOLTAR }
  $estado = switch ($opc) { "2" { "Resolved" } "3" { "" } default { "Closed" } }
  return $estado
}

# Simula, mostra a saida do CLI, confirma e aplica (lote: sprint/mes).
function Confirmar-E-Aplicar-Lote($base, $msgSucesso, $alvo) {
  Write-Host ""
  Passo "Simulando (nada e gravado ainda)..."
  Write-Host ""
  & node "src/cli.js" @base
  if ($LASTEXITCODE -ne 0) { Erro "A simulacao falhou. Nada foi gravado."; return }

  if (Confirmar "Confirma e grava tudo isso no $alvo?") {
    Write-Host ""
    & node "src/cli.js" @($base + @("--apply"))
    if ($LASTEXITCODE -eq 0) {
      Write-Host ""
      Linha "-" "Green"
      Ok $msgSucesso
      Linha "-" "Green"
    } else {
      Erro "Falhou no meio do caminho. Veja acima ate onde foi gravado."
    }
  } else {
    Aviso "Cancelado. Nada foi gravado."
  }
}

# --- Acao: listar ---------------------------------------------------

function Acao-Listar($pessoa) {
  Titulo "Meus cards" "filtro por sprint e status; 'v' volta"

  $sprint = Perguntar "Sprint (ex.: 2026 W24)" "todas"
  if ($sprint -eq $script:VOLTAR) { return }
  if ($sprint -eq "todas") { $sprint = "" }

  Write-Host ""
  Info "Status:"
  Item-Menu "1" "Abertos" "New/Active/Resolved [padrao]"
  Item-Menu "2" "Todos" "inclusive fechados"
  Item-Menu "3" "So New" ""
  Item-Menu "4" "So Active" ""
  Item-Menu "5" "So Resolved" ""
  Item-Menu "6" "So Closed" ""
  $opc = Perguntar "Escolha" "1"
  if ($opc -eq $script:VOLTAR) { return }
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
  Titulo "Visao mensal de horas" "o que falta para 8h em cada dia"
  $mesAtual = (Get-Date).ToString("yyyy-MM")
  $mes = Perguntar-Validado "Mes (AAAA-MM)" $mesAtual '^\d{4}-(0[1-9]|1[0-2])$' "Mes invalido - use AAAA-MM, por exemplo $mesAtual."
  if ($mes -eq $script:VOLTAR) { return }

  Write-Host ""
  & node "src/cli.js" --month $mes --person $pessoa
  if ($LASTEXITCODE -ne 0) {
    Erro "Nao foi possivel montar a visao mensal."
  }
  Enter-Continuar
}

# --- Acao: criar tarefas filhas de uma user story --------------------

function Acao-Criar-Tarefas {
  Titulo "Criar tarefas de uma user story" "develop, homologation e deployment"
  $story = Perguntar-Validado "ID da user story (ex.: 12345)" "" '^\d+$' "ID invalido - somente numeros."
  if ($story -eq $script:VOLTAR) { return }

  $fases = Perguntar "Fases (develop,homologation,deployment)" "todas"
  if ($fases -eq $script:VOLTAR) { return }
  if ($fases -eq "todas") { $fases = "" }

  $base = @("--create-tasks", "--user-story-id", $story)
  if ($fases) { $base += @("--phases", $fases) }

  Passo "Simulando (nada e gravado ainda)..."
  $saida = Rodar-CLI (@("--dry-run") + $base)
  $r = Extrair-Json $saida
  if (-not $r) {
    Erro "Nao entendi a resposta do servico:"
    Write-Host $saida
    Enter-Continuar
    return
  }
  if (-not $r.ok) {
    Write-Host ""
    Linha "-" "Red"
    Erro "BLOQUEADO ($($r.stage)):"
    foreach ($e in $r.errors) { Write-Host ("     - $e") -ForegroundColor Red }
    Linha "-" "Red"
    Enter-Continuar
    return
  }

  Write-Host ""
  Linha "-" "DarkGray"
  Write-Host "  User story: $($r.userStory.title)" -ForegroundColor White
  Write-Host "  Tipo: $($r.userStory.type)"
  Write-Host ""
  Write-Host "  Tarefas que serao criadas:" -ForegroundColor Yellow
  foreach ($task in $r.tasks) {
    Write-Host ("    [{0}] {1}" -f $task.phaseLabel, $task.title)
  }
  Linha "-" "DarkGray"

  if (Confirmar "Confirma e cria essas tarefas no Azure DevOps?") {
    $saida2 = Rodar-CLI (@("--apply") + $base)
    $r2 = Extrair-Json $saida2
    if ($r2 -and $r2.ok) {
      Write-Host ""
      Linha "-" "Green"
      Ok "Tarefas criadas com sucesso:"
      foreach ($task in $r2.created) {
        Write-Host ("     #{0} [{1}] {2}" -f $task.id, $task.phaseLabel, $task.title) -ForegroundColor Green
      }
      Linha "-" "Green"
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
  Titulo "Configuracao" "conexao, limites e identidade"
  & node "src/cli.js" --config-status

  Write-Host ""
  Item-Menu "1" "Refazer setup" "recomeca do zero (.env vira .env.bak)"
  if ($script:temVariasIdentidades) { Item-Menu "2" "Trocar identidade" "" }
  Info "Enter para voltar."
  $op = Perguntar "Escolha"
  if ($op -eq $script:VOLTAR -or -not $op) { Enter-Continuar; return }

  if ($op -eq "1") {
    Aviso "Isso recomeca o setup. O .env atual vira .env.bak (nada e perdido)."
    if (Confirmar "Confirma?") {
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
  Titulo "Time Box Control" "integracao que grava hora por dia"
  & node "src/cli.js" --timebox-status

  Write-Host ""
  Item-Menu "1" "Colar token novo" "pega no F12 do navegador"
  Item-Menu "2" "Modo automatico" "somente backend antigo"
  Info "Enter para voltar."
  $op = Perguntar "Escolha"
  if ($op -eq $script:VOLTAR -or -not $op) { Enter-Continuar; return }

  if ($op -eq "1") {
    Write-Host ""
    Info "Como pegar o token:"
    Info "  1) Abra o Time Box Control no Azure DevOps"
    Info "  2) F12 -> aba Network -> clique em qualquer chamada para amstl.agendaaqui.com.br"
    Info "  3) Em Headers, copie o valor de 'Authorization' (comeca com 'Bearer ')"
    $token = Read-Host "`n  Cole aqui o token"
    if (-not $token) { Aviso "Nada colado."; Enter-Continuar; return }

    Write-Host ""
    & node "src/cli.js" --timebox-token "$token"
  } elseif ($op -eq "2") {
    Write-Host ""
    & node "src/cli.js" --timebox-setup
  }

  Enter-Continuar
}

# --- Acao: ajuda ----------------------------------------------------

function Acao-Ajuda {
  Titulo "Ajuda / exemplos"
  Write-Host @"
  LANCAR
    [1] Sprint - o caminho classico: Enter na pergunta da sprint (ele acha
        a atual sozinho), escolhe Closed, confere e confirma. Lanca as horas
        que faltam em todos os cards abertos, ate 8h por dia, e fecha tudo.
    [2] Mes - para o board Kanban mensal: usa a iteracao "2026 M08",
        distribui nos dias uteis do mes e desconta horas de outras sprints.
    [3] Um card - horas avulsas. Com o 'claude' CLI, escreva em portugues
        ("4h de ontem e move pra Active"); sem ele, responde passo a passo.

  CONSULTAR
    [4] Meus cards - lista o que esta aberto, com o ID de cada um.
    [5] Visao mensal - mostra dia a dia o que falta para 8h e excessos.

  REGRAS AUTOMATICAS
    - Maximo 8 horas por dia, conferindo tambem o Time Box antes de gravar.
    - Fim de semana nunca recebe hora.
    - Avisa quando as horas caem em dia que ainda nao aconteceu.
    - Sempre SIMULA antes; so grava depois do seu 's'.

  NAVEGACAO
    - Enter aceita o valor entre [colchetes].
    - Digite 'v' em qualquer pergunta para voltar sem gravar nada.

  PELA LINHA DE COMANDO
    node src/cli.js --list
    node src/cli.js --month 2026-08
    node src/cli.js --fill-sprint --state Closed
    node src/cli.js --fill-month --month 2026-08 --state Closed
    node src/cli.js --fill-sprint --sprint "2026 W24" --state Closed
    node src/cli.js --create-tasks --user-story-id 12345 --phases develop,homologation
"@
  Enter-Continuar
}

# --- Banner inicial -------------------------------------------------

function Status-Timebox {
  if (Test-Path ".env") {
    $linha = Get-Content ".env" | Where-Object { $_ -match '^TIMEBOX_ENABLED=' } | Select-Object -First 1
    if ($linha -match '=(.*)$') { return ($Matches[1].Trim() -match '^(1|true|yes|sim)$') }
  }
  return $false
}

function Banner-Inicial($pessoa) {
  $hoje = Get-Date
  $cult = [Globalization.CultureInfo]::GetCultureInfo("pt-BR")
  $dataFmt = $hoje.ToString("dddd, dd 'de' MMMM 'de' yyyy", $cult)

  Write-Host ""
  Linha "=" "Cyan"
  Write-Host "   APONTADOR DE HORAS" -ForegroundColor White
  Write-Host "   Azure DevOps + Time Box" -ForegroundColor DarkGray
  Linha "=" "Cyan"
  Write-Host ("   Operando como : ") -NoNewline -ForegroundColor DarkGray
  Write-Host $pessoa -ForegroundColor Green
  Write-Host ("   Hoje          : {0}" -f $dataFmt) -ForegroundColor DarkGray
  if (Status-Timebox) {
    Write-Host "   Time Box      : LIGADO (grava no Azure e no Time Box)" -ForegroundColor DarkGray
  } else {
    Write-Host "   Time Box      : desligado (grava so no Azure DevOps)" -ForegroundColor DarkGray
  }
  Linha "-" "DarkCyan"
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
  Banner-Inicial $script:pessoa

  Secao-Menu "LANCAR"
  Item-Menu "1" "Lancar a sprint" "completa a sprint e fecha os cards"
  Item-Menu "2" "Lancar o mes" "board mensal, dias uteis, 8h/dia"
  Item-Menu "3" "Apontar um card" "horas avulsas, com IA opcional"

  Secao-Menu "CONSULTAR"
  Item-Menu "4" "Meus cards" "lista por sprint e status"
  Item-Menu "5" "Visao mensal" "o que falta em cada dia do mes"

  Secao-Menu "FERRAMENTAS"
  Item-Menu "6" "Criar tarefas" "tasks filhas de uma user story"
  Item-Menu "7" "Configuracao" "servidor, token, identidade"
  Item-Menu "8" "Time Box" "status e renovacao do token"
  Item-Menu "9" "Ajuda" "exemplos e regras"
  Write-Host ""
  Item-Menu "0" "Sair" ""

  $op = Read-Host "`n  Escolha"
  switch ($op) {
    "1" { Acao-Fechar-Sprint $script:pessoa }
    "2" { Acao-Fechar-Mes $script:pessoa }
    "3" { Acao-Apontar $script:pessoa }
    "4" { Acao-Listar $script:pessoa }
    "5" { Acao-Visao-Mensal $script:pessoa }
    "6" { Acao-Criar-Tarefas }
    "7" { Acao-Configuracao }
    "8" { Acao-Timebox }
    "9" { Acao-Ajuda }
    "0" { Write-Host "`n  Ate mais!" -ForegroundColor Cyan; $rodando = $false }
    default { Aviso "Opcao invalida - escolha um numero do menu."; Start-Sleep -Milliseconds 900 }
  }
}
