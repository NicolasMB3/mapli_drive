#Requires -Version 7.2
<#
.SYNOPSIS
  Banc du lecteur Mapli Drive sous Windows : rclone + WinFsp avec les réglages de
  l'application, contre un serveur WebDAV local.

.DESCRIPTION
  Monte un lecteur exactement comme Mapli Drive (arguments et environnement produits par
  src/main/rclone-args.ts, via mount-args.mjs) sur un serveur `rclone serve webdav` local,
  puis mesure et vérifie :
   - montage (premier montage, pilote WinFsp à froid ; montages suivants), démontage ;
   - listes de 100 et 1 000 entrées (première lecture, puis cache) ;
   - lectures séquentielles 1 Mio et N Mio (froid, chaud, empreinte vérifiée), lecture
     partielle (64 Kio lus : combien téléchargés ?), quatre lectures en parallèle ;
   - écritures : 1 000 petits fichiers, un gros fichier (temps d'écriture pour
     l'application, puis délai jusqu'à l'envoi complet, contenu vérifié côté serveur) ;
   - enregistrement à la façon d'Excel (fichier temporaire, renommages, suppression) ;
   - renommages (fichier, dossier de 100 fichiers, casse seule), suppressions ;
   - suppression « vers la corbeille » comme l'Explorateur (recycle-delete.ps1) ;
   - noms accentués, emoji, caractères interdits sous Windows, chemin de plus de 260 ;
   - changement fait ailleurs : invisible tant que le dossier est en cache, visible après
     vfs/forget (délai mesuré) — c'est ce que fait l'application sur annonce du serveur ;
   - rclone : mémoire et processeur (repos, pic, par étape) ;
   - assistant de l'Explorateur (resources/explorer-notify.ps1) : démarrage, mémoire,
     lot de 200 notifications ;
   - messages d'échec de l'application (explainFailure de drive-mount.ts) : lettre déjà
     prise, jeton refusé ;
   - dossier du cache : propre au token (le nom du remote rclone en dépend).
  Modes : « disque » (réglage de l'application : disque fixe) et « reseau »
  (--network-mode, lecteur réseau), pour comparer.

  Le serveur local n'a pas la latence ni le coût de Mapli (PHP, chiffrement) : les
  chiffres mesurent ce que coûte le poste (WinFsp, rclone, cache). -LatencyMs ajoute un
  délai à chaque requête (latency-proxy.mjs) pour approcher un serveur distant.

  Sorties dans -OutDir : bench-windows-<mode>.json, resume-<mode>.md, journaux de rclone ;
  le résumé est ajouté à $env:GITHUB_STEP_SUMMARY s'il existe. Code de sortie 1 si une
  vérification échoue ou si une étape plante.

.EXAMPLE
  ./scripts/bench/windows-bench.ps1 -Mode disque -Rclone C:\outils\rclone.exe -OutDir C:\bench
#>
[CmdletBinding()]
param(
  [ValidateSet('disque', 'reseau')] [string] $Mode = 'disque',
  [Parameter(Mandatory)] [string] $Rclone,
  [string] $OutDir = (Join-Path ([IO.Path]::GetTempPath()) 'mapli-bench'),
  [ValidatePattern('^[D-Z]:$')] [string] $Letter = 'M:',
  [int] $LatencyMs = 0,
  [string] $ExtraArgs = '',
  [int] $SmallFiles = 1000,
  [int] $BigMiB = 100
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Invariant = [Globalization.CultureInfo]::InvariantCulture

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$Rclone = (Resolve-Path $Rclone).Path
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$Work = Join-Path $OutDir "travail-$Mode"
$SrvDir = Join-Path $Work 'serveur'
# Cache sur le disque du système, dans le profil local, comme l'application.
$CacheDir = Join-Path $env:LOCALAPPDATA "Mapli Drive Bench\$Mode\cache"
$EmptyConfig = Join-Path $Work 'rclone.conf'
$Root = "$Letter\"

# Options du mode « reseau » et options d'essai (-ExtraArgs), ajoutées à celles de l'application.
$Extra = @()
if ($Mode -eq 'reseau') { $Extra += '--network-mode' }
$Extra += @($ExtraArgs -split '\s+' | Where-Object { $_ })

$Result = [ordered]@{
  mode          = $Mode
  date          = (Get-Date).ToUniversalTime().ToString('o')
  latenceMs     = $LatencyMs
  optionsAjoutees = $Extra
  environnement = [ordered]@{}
  montage       = [ordered]@{}
  mesures       = [ordered]@{}
  rclone        = [ordered]@{}
  assistant     = @()
  observations  = [ordered]@{}
  verifications = [Collections.Generic.List[object]]::new()
  erreurs       = [Collections.Generic.List[object]]::new()
}
$Processes = [Collections.Generic.List[Diagnostics.Process]]::new()
$Substs = [Collections.Generic.List[string]]::new()
$Rng = [Security.Cryptography.RandomNumberGenerator]::Create()

# ── Outils ─────────────────────────────────────────────────────────────────

function Round1([double] $Value) { [math]::Round($Value, 1) }

function Fmt($Value, [string] $Unit = '') {
  if ($null -eq $Value) { return '—' }
  $text = if ($Value -is [double] -or $Value -is [single] -or $Value -is [decimal]) {
    ([double]$Value).ToString('0.0', $Invariant)
  } else { "$Value" }
  if ($Unit) { "$text $Unit" } else { $text }
}

# Les blocs passés aux fonctions ci-dessous voient les variables de l'appelant (portée
# dynamique de PowerShell) : les variables internes ont des noms préfixés pour ne pas
# les masquer.
function Measure-Ms([scriptblock] $Block, [ref] $Output) {
  $__sw = [Diagnostics.Stopwatch]::StartNew()
  $__out = & $Block
  $__sw.Stop()
  if ($Output) { $Output.Value = $__out }
  Round1 $__sw.Elapsed.TotalMilliseconds
}

# Attend que la condition soit vraie ; renvoie le délai (ms), ou $null après TimeoutMs.
function Wait-Until([scriptblock] $Condition, [int] $TimeoutMs = 30000, [int] $IntervalMs = 50) {
  $__sw = [Diagnostics.Stopwatch]::StartNew()
  while ($__sw.ElapsedMilliseconds -lt $TimeoutMs) {
    $__ok = $false
    try { $__ok = [bool](& $Condition) } catch { $__ok = $false }
    if ($__ok) { return Round1 $__sw.Elapsed.TotalMilliseconds }
    Start-Sleep -Milliseconds $IntervalMs
  }
  $null
}

# Vérification : ce qui doit marcher (un échec fait échouer le banc).
function Add-Check([string] $Name, [bool] $Ok, [string] $Detail = '') {
  $Result.verifications.Add([ordered]@{ nom = $Name; ok = $Ok; detail = $Detail })
  $mark = if ($Ok) { 'OK' } else { 'ÉCHEC' }
  Write-Host "[$mark] $Name $Detail"
}

# Observation : un comportement à connaître (corbeille, messages…), sans verdict.
function Add-Observation([string] $Key, $Value) {
  $Result.observations[$Key] = $Value
  Write-Host "[observation] $Key : $($Value | ConvertTo-Json -Compress -Depth 4)"
}

# Propriété facultative d'une réponse JSON (absente : $null, même en mode strict).
function Get-Prop($Object, [string] $Name) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -ne $property) { $property.Value } else { $null }
}

function Invoke-Step([string] $Name, [scriptblock] $Block) {
  Write-Host "::group::$Name"
  try {
    & $Block
  } catch {
    $message = $_.Exception.Message
    $Result.erreurs.Add([ordered]@{ etape = $Name; message = $message; ligne = $_.InvocationInfo.ScriptLineNumber })
    Write-Host "::warning::$Name : $message"
  } finally {
    Write-Host '::endgroup::'
  }
}

function Get-FreePort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}

function New-RandomBytes([int] $Size) {
  $bytes = [byte[]]::new($Size)
  $Rng.GetBytes($bytes)
  , $bytes
}

function New-Secret([int] $Size) { [Convert]::ToHexString((New-RandomBytes $Size)).ToLowerInvariant() }

# Écrit $Size octets aléatoires par blocs de 1 Mio ; renvoie leur empreinte SHA-256.
function Write-RandomFile([string] $Path, [long] $Size) {
  $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
  $buffer = [byte[]]::new(1MB)
  $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None, 1MB)
  try {
    $left = $Size
    while ($left -gt 0) {
      $count = [int][math]::Min($left, $buffer.Length)
      $Rng.GetBytes($buffer, 0, $count)
      $stream.Write($buffer, 0, $count)
      $hash.AppendData($buffer, 0, $count)
      $left -= $count
    }
  } finally {
    $stream.Dispose()
  }
  [Convert]::ToHexString($hash.GetHashAndReset())
}

# Lecture séquentielle par blocs de 1 Mio (comme une copie), empreinte SHA-256.
function Get-Sha([string] $Path) {
  $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite, 1MB, [IO.FileOptions]::SequentialScan)
  try { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)) } finally { $stream.Dispose() }
}

function Test-Dir([string] $Path) { [IO.Directory]::Exists($Path) }
function Test-File([string] $Path) { [IO.File]::Exists($Path) }

# Fichiers d'un dossier du serveur (0 s'il n'existe pas).
function Get-ServerCount([string] $Relative) {
  $dir = Join-Path $SrvDir $Relative
  if (-not (Test-Dir $dir)) { return 0 }
  [IO.Directory]::GetFiles($dir).Count
}

function Get-ProcSample([Diagnostics.Process] $Process) {
  $Process.Refresh()
  [ordered]@{
    memoireTravailMo = Round1 ($Process.WorkingSet64 / 1MB)
    memoirePriveeMo  = Round1 ($Process.PrivateMemorySize64 / 1MB)
    picTravailMo     = Round1 ($Process.PeakWorkingSet64 / 1MB)
    picPriveeMo      = Round1 ($Process.PeakPagedMemorySize64 / 1MB)
    cpuMs            = Round1 $Process.TotalProcessorTime.TotalMilliseconds
    threads          = $Process.Threads.Count
    handles          = $Process.HandleCount
  }
}

function Get-CpuMs([Diagnostics.Process] $Process) {
  $Process.Refresh()
  $Process.TotalProcessorTime.TotalMilliseconds
}

# Nom tel que l'Explorateur le voit : WinFsp décale les caractères interdits sous Windows
# en U+F000 + caractère (même règle que explorerName() dans src/main/shell-changes.ts).
function ConvertTo-ExplorerName([string] $Name) {
  $builder = [Text.StringBuilder]::new()
  foreach ($c in $Name.ToCharArray()) {
    $code = [int]$c
    if (($code -gt 0 -and $code -lt 32) -or '"*:<>?\|'.Contains($c)) {
      [void]$builder.Append([char](0xF000 -bor $code))
    } else {
      [void]$builder.Append($c)
    }
  }
  $builder.ToString()
}

# Message que montrerait l'application après un échec de montage : même ordre et mêmes
# expressions que explainFailure() dans src/main/drive-mount.ts.
function Get-AppExplanation([string] $Log) {
  if ($Log -match '(?i)winfsp|cgofuse') { return 'WinFsp manquant' }
  if ($Log -match '(?i)401|unauthori') { return 'poste refusé' }
  if ($Log -match '(?i)already in use|mountpoint .* exists|is already mounted') { return 'lettre déjà utilisée' }
  if ($Log -match '(?i)no such host|connection refused|timeout|i/o timeout') { return 'Mapli injoignable' }
  'échec générique'
}

function Get-LogTail([string] $Path, [int] $Lines = 40) {
  if (-not (Test-File $Path)) { return '' }
  (Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction SilentlyContinue) -join "`n"
}

# ── Serveur WebDAV local ───────────────────────────────────────────────────

function Start-Rclone([string[]] $Arguments, [hashtable] $Environment = @{}) {
  $info = [Diagnostics.ProcessStartInfo]::new($Rclone)
  foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
  $info.Environment['RCLONE_CONFIG'] = $EmptyConfig
  foreach ($key in $Environment.Keys) { $info.Environment[$key] = [string]$Environment[$key] }
  $info.UseShellExecute = $false
  # Comme `windowsHide: true` de Node : pas de console.
  $info.CreateNoWindow = $true
  $process = [Diagnostics.Process]::Start($info)
  $Processes.Add($process)
  $process
}

function Start-DavServer([string] $Directory, [int] $Port, [string[]] $More = @()) {
  $log = Join-Path $OutDir "serveur-$Mode-$Port.log"
  $process = Start-Rclone (@('serve', 'webdav', $Directory, '--addr', "127.0.0.1:$Port", '--log-file', $log, '--log-level', 'NOTICE') + $More)
  $ready = Wait-Until {
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -Method Head -TimeoutSec 2 | Out-Null
      $true
    } catch {
      # 401 (serveur avec mot de passe) : il répond, c'est prêt.
      $null -ne $_.Exception.Response
    }
  } 20000 100
  if ($null -eq $ready) { throw "serveur WebDAV injoignable sur le port $Port" }
  $process
}

# Requête au serveur, comme le ferait un autre poste ou le web (changement « fait ailleurs »).
function Invoke-Dav([string] $Method, [string] $Relative, [byte[]] $Body = $null) {
  $escaped = ($Relative.Split('/') | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'
  $parameters = @{ Uri = "http://127.0.0.1:$($script:ServerPort)/$escaped"; CustomMethod = $Method; TimeoutSec = 30 }
  if ($null -ne $Body) {
    $parameters.Body = $Body
    $parameters.ContentType = 'application/octet-stream'
  }
  Invoke-WebRequest @parameters | Out-Null
}

# ── Montage, comme drive-mount.ts ──────────────────────────────────────────

# Lance rclone comme drive-mount.ts, puis attend la lettre et la première liste de la
# racine (-NoWait : rend la main dès le lancement).
function Start-Mount([string] $Token, [string] $Tag, [string] $MountPoint = $Letter, [string] $DavUrl = $script:DavUrl, [int] $WaitMs = 30000, [switch] $NoWait) {
  $rcPort = Get-FreePort
  $rcUser = New-Secret 12
  $rcPass = New-Secret 24
  $spec = Join-Path $Work "montage-$Tag.json"
  $log = Join-Path $OutDir "rclone-$Mode-$Tag.log"
  $env:MAPLI_BENCH_TOKEN = $Token
  $env:MAPLI_BENCH_RC_USER = $rcUser
  $env:MAPLI_BENCH_RC_PASS = $rcPass
  try {
    & node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON (Join-Path $PSScriptRoot 'mount-args.mjs') `
      --out $spec --dav-url $DavUrl --mount-point $MountPoint --cache-dir $CacheDir `
      --log-file $log --config $EmptyConfig --rc-port $rcPort | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "mount-args.mjs a échoué (code $LASTEXITCODE)" }
  } finally {
    Remove-Item Env:MAPLI_BENCH_TOKEN, Env:MAPLI_BENCH_RC_USER, Env:MAPLI_BENCH_RC_PASS -ErrorAction SilentlyContinue
  }
  $specification = Get-Content -Raw -LiteralPath $spec | ConvertFrom-Json
  $environment = @{}
  foreach ($property in $specification.env.PSObject.Properties) { $environment[$property.Name] = $property.Value }

  $clock = [Diagnostics.Stopwatch]::StartNew()
  $process = Start-Rclone (@($specification.args) + $Extra) $environment
  $root = "$MountPoint\"
  $letterMs = $null
  $listMs = $null
  while (-not $NoWait -and $clock.ElapsedMilliseconds -lt $WaitMs -and -not $process.HasExited) {
    if ($null -eq $letterMs -and (Test-Dir $root)) { $letterMs = Round1 $clock.Elapsed.TotalMilliseconds }
    if ($null -ne $letterMs) {
      try {
        [void][IO.Directory]::GetFileSystemEntries($root)
        $listMs = Round1 $clock.Elapsed.TotalMilliseconds
        break
      } catch { }
    }
    Start-Sleep -Milliseconds 20
  }
  [pscustomobject]@{
    Tag = $Tag; MountPoint = $MountPoint; Process = $process; Log = $log
    RcPort = $rcPort; RcUser = $rcUser; RcPass = $rcPass
    LetterMs = $letterMs; ListMs = $listMs; Ok = $null -ne $listMs
  }
}

function Invoke-Rc($Mount, [string] $Endpoint, [hashtable] $Body = @{}) {
  $auth = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($Mount.RcUser):$($Mount.RcPass)"))
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($Mount.RcPort)/$Endpoint" -Headers @{ Authorization = $auth } `
    -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Compress -Depth 5) -TimeoutSec 30
}

function Get-PendingUploads($Mount) {
  $stats = Invoke-Rc $Mount 'vfs/stats'
  [int]$stats.diskCache.uploadsInProgress + [int]$stats.diskCache.uploadsQueued
}

# Démontage comme l'application : core/quit, 15 s au plus, puis arrêt forcé.
function Stop-Mount($Mount) {
  if ($null -eq $Mount -or $Mount.Process.HasExited) { return $null }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  try { Invoke-Rc $Mount 'core/quit' | Out-Null } catch { }
  $exited = $Mount.Process.WaitForExit(15000)
  $exitMs = Round1 $clock.Elapsed.TotalMilliseconds
  if (-not $exited) { try { $Mount.Process.Kill($true) } catch { } }
  $root = "$($Mount.MountPoint)\"
  $goneMs = Wait-Until { -not (Test-Dir $root) } 15000 25
  [ordered]@{ arretMs = $exitMs; lettreRetireeMs = $goneMs; arretForce = -not $exited }
}

# ── Préparation des données du serveur (avant son démarrage) ───────────────

Remove-Item -Recurse -Force -LiteralPath $Work, $CacheDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Work, $SrvDir, $CacheDir | Out-Null
Set-Content -LiteralPath $EmptyConfig -Value '' -NoNewline
if (Test-Dir $Root) { throw "La lettre $Letter est déjà utilisée sur ce poste." }

$Hashes = @{}
$prepMs = Measure-Ms {
  foreach ($count in 100, 1000) {
    $dir = New-Item -ItemType Directory -Force -Path (Join-Path $SrvDir "liste-$count")
    $content = New-RandomBytes 1024
    for ($i = 0; $i -lt $count; $i++) {
      [IO.File]::WriteAllBytes((Join-Path $dir.FullName ('Bulletin de paie {0:D4}.pdf' -f $i)), $content)
    }
  }
  $read = (New-Item -ItemType Directory -Force -Path (Join-Path $SrvDir 'lecture')).FullName
  $Hashes['1M'] = Write-RandomFile (Join-Path $read 'petit.bin') 1MB
  $Hashes['gros'] = Write-RandomFile (Join-Path $read 'gros.bin') ($BigMiB * 1MB)
  $Hashes['partiel'] = Write-RandomFile (Join-Path $read 'partiel.bin') ($BigMiB * 1MB)
  for ($i = 1; $i -le 4; $i++) { $Hashes["parallele-$i"] = Write-RandomFile (Join-Path $read "parallele-$i.bin") 32MB }

  $rename = (New-Item -ItemType Directory -Force -Path (Join-Path $SrvDir 'renommage\dossier-100')).FullName
  for ($i = 0; $i -lt 100; $i++) { [IO.File]::WriteAllText((Join-Path $rename "f-$i.txt"), "fichier $i") }
  [IO.File]::WriteAllText((Join-Path $SrvDir 'renommage\a.txt'), 'a')
  [IO.File]::WriteAllText((Join-Path $SrvDir 'renommage\casse.txt'), 'casse')

  $delete = (New-Item -ItemType Directory -Force -Path (Join-Path $SrvDir 'suppression')).FullName
  for ($i = 0; $i -lt 100; $i++) { [IO.File]::WriteAllText((Join-Path $delete "f-$i.txt"), "fichier $i") }
  for ($d = 0; $d -lt 10; $d++) {
    $sub = (New-Item -ItemType Directory -Force -Path (Join-Path $SrvDir "suppression-arbre\d-$d")).FullName
    for ($i = 0; $i -lt 10; $i++) { [IO.File]::WriteAllText((Join-Path $sub "f-$i.txt"), "fichier $d-$i") }
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $SrvDir 'corbeille') | Out-Null
  [IO.File]::WriteAllText((Join-Path $SrvDir 'corbeille\supprime-moi.txt'), 'à supprimer vers la corbeille')
  New-Item -ItemType Directory -Force -Path (Join-Path $SrvDir 'office') | Out-Null
  $Hashes['office-avant'] = Write-RandomFile (Join-Path $SrvDir 'office\Budget.xlsx') 200KB
  New-Item -ItemType Directory -Force -Path (Join-Path $SrvDir 'distant'), (Join-Path $SrvDir 'noms') | Out-Null
  [IO.File]::WriteAllText((Join-Path $SrvDir 'distant\existant.txt'), 'déjà là')
}
$Result.mesures.preparationMs = $prepMs

try {
  # ── Environnement ──────────────────────────────────────────────────────────
  Invoke-Step 'Environnement' {
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    $Result.environnement.systeme = "$($os.Caption) $($os.Version)"
    $Result.environnement.processeur = "$($cpu.Name.Trim()) ($([Environment]::ProcessorCount) cœurs logiques)"
    $Result.environnement.memoireGo = Round1 ($os.TotalVisibleMemorySize / 1MB)
    $Result.environnement.powershell = "$($PSVersionTable.PSVersion)"
    $Result.environnement.node = (& node --version)
    $Result.environnement.rclone = ((& $Rclone version) | Select-Object -First 1)
    $winfsp = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\WinFsp' -ErrorAction Stop).InstallDir
    $Result.environnement.winfsp = (Get-Item (Join-Path $winfsp 'bin\winfsp-x64.dll')).VersionInfo.FileVersion
    try {
      $defender = Get-MpComputerStatus
      $Result.environnement.antivirusTempsReel = [bool]$defender.RealTimeProtectionEnabled
    } catch {
      $Result.environnement.antivirusTempsReel = $null
    }
  }

  # ── Serveur (et relais de latence) ─────────────────────────────────────────
  $script:ServerPort = Get-FreePort
  $Server = Start-DavServer $SrvDir $script:ServerPort
  $script:DavUrl = "http://127.0.0.1:$($script:ServerPort)/"
  if ($LatencyMs -gt 0) {
    $proxyPort = Get-FreePort
    $info = [Diagnostics.ProcessStartInfo]::new((Get-Command node).Source)
    foreach ($argument in @((Join-Path $PSScriptRoot 'latency-proxy.mjs'), '--listen', "$proxyPort", '--target', "$($script:ServerPort)", '--delay', "$LatencyMs")) { $info.ArgumentList.Add($argument) }
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $Processes.Add([Diagnostics.Process]::Start($info))
    if ($null -eq (Wait-Until { try { Invoke-WebRequest -Uri "http://127.0.0.1:$proxyPort/" -Method Head -TimeoutSec 2 | Out-Null; $true } catch { $null -ne $_.Exception.Response } } 15000 100)) {
      throw 'relais de latence injoignable'
    }
    $script:DavUrl = "http://127.0.0.1:$proxyPort/"
  }

  # Noms permis sur le web et le Mac mais interdits sous Windows : créés par le serveur.
  $ForbiddenNames = @('Réunion 12:30.txt', 'Pourquoi ?.txt', '"Devis" <A|B> *.txt')
  Invoke-Step 'Noms interdits sous Windows, créés côté serveur' {
    foreach ($name in $ForbiddenNames) { Invoke-Dav 'PUT' "noms/$name" ([Text.Encoding]::UTF8.GetBytes($name)) }
  }

  $TokenA = New-Secret 20
  $TokenB = New-Secret 20

  # ── Montages successifs : temps à froid, dossier du cache selon le token ─────
  Invoke-Step 'Montage à froid et dossier du cache' {
    $first = Start-Mount $TokenA 'froid'
    $Result.montage.premier = [ordered]@{ lettreMs = $first.LetterMs; premiereListeMs = $first.ListMs }
    Add-Check 'Premier montage' $first.Ok "lettre $(Fmt $first.LetterMs 'ms'), liste $(Fmt $first.ListMs 'ms')"
    if ($first.Ok) {
      $pathA = (Invoke-Rc $first 'vfs/stats').diskCache.path
      $Result.montage.demontagePremier = Stop-Mount $first
      $second = Start-Mount $TokenB 'autre-jeton'
      $Result.montage.second = [ordered]@{ lettreMs = $second.LetterMs; premiereListeMs = $second.ListMs }
      $pathB = if ($second.Ok) { (Invoke-Rc $second 'vfs/stats').diskCache.path } else { $null }
      Stop-Mount $second | Out-Null
      $Result.observations.cacheParJeton = [ordered]@{ jetonA = $pathA; jetonB = $pathB; different = $pathA -ne $pathB }
      Write-Host "Cache (jeton A) : $pathA"
      Write-Host "Cache (jeton B) : $pathB"
    } else {
      Write-Host (Get-LogTail $first.Log)
      Stop-Mount $first | Out-Null
    }
  }

  # ── Montage de travail ─────────────────────────────────────────────────────
  $script:Mount = Start-Mount $TokenA 'principal'
  $Result.montage.principal = [ordered]@{ lettreMs = $script:Mount.LetterMs; premiereListeMs = $script:Mount.ListMs }
  Add-Check 'Montage' $script:Mount.Ok "lettre $(Fmt $script:Mount.LetterMs 'ms'), liste $(Fmt $script:Mount.ListMs 'ms')"
  if (-not $script:Mount.Ok) {
    Write-Host (Get-LogTail $script:Mount.Log)
    throw 'Le lecteur ne s''est pas monté : voir le journal de rclone.'
  }
  $RcloneProcess = $script:Mount.Process
  if ($Result.observations.Contains('cacheParJeton')) {
    $samePath = (Invoke-Rc $script:Mount 'vfs/stats').diskCache.path
    $Result.observations.cacheParJeton.memeJetonMemeDossier = $samePath -eq $Result.observations.cacheParJeton.jetonA
  }

  Invoke-Step 'Volume vu par Windows' {
    $drive = [IO.DriveInfo]::new($Letter.Substring(0, 1))
    $Result.observations.volume = [ordered]@{
      type = "$($drive.DriveType)"; systemeDeFichiers = $drive.DriveFormat; nom = $drive.VolumeLabel
      totalGo = Round1 ($drive.TotalSize / 1GB); libreGo = Round1 ($drive.AvailableFreeSpace / 1GB)
    }
    $volumeInfo = (& fsutil fsinfo volumeinfo $Letter 2>&1) -join "`n"
    $Result.observations.volume.fsutil = $volumeInfo
    $Result.observations.volume.sensibleCasse = $volumeInfo -match '(?i)case-sensitive'
    $Result.observations.volume.netUse = ((& net use 2>&1) -join "`n")
  }

  Invoke-Step 'Repos après montage' {
    Start-Sleep -Seconds 3
    $Result.rclone.apresMontage = Get-ProcSample $RcloneProcess
    $cpu0 = Get-CpuMs $RcloneProcess
    Start-Sleep -Seconds 10
    $Result.rclone.cpuAuReposMsPar10s = Round1 ((Get-CpuMs $RcloneProcess) - $cpu0)
  }

  # ── Listes ─────────────────────────────────────────────────────────────────
  Invoke-Step 'Listes de dossiers' {
    foreach ($count in 100, 1000) {
      $path = "$Letter\liste-$count"
      foreach ($pass in 'premiere', 'cache') {
        $found = $null
        $ms = Measure-Ms {
          $n = 0
          foreach ($entry in [IO.DirectoryInfo]::new($path).EnumerateFileSystemInfos()) {
            # Taille et date, comme l'affichage « Détails » de l'Explorateur.
            if ($entry -is [IO.FileInfo]) { [void]$entry.Length }
            [void]$entry.LastWriteTimeUtc
            $n++
          }
          $n
        } ([ref]$found)
        $Result.mesures["liste$count-$pass-ms"] = $ms
        if ($pass -eq 'premiere') { Add-Check "Liste de $count entrées" ($found -eq $count) "$found trouvées en $(Fmt $ms 'ms')" }
      }
    }
  }

  # ── Lectures ───────────────────────────────────────────────────────────────
  Invoke-Step 'Lectures séquentielles' {
    $local = (New-Item -ItemType Directory -Force -Path (Join-Path $Work 'copies')).FullName
    foreach ($file in @(@{ nom = 'petit.bin'; cle = '1M'; mio = 1 }, @{ nom = 'gros.bin'; cle = 'gros'; mio = $BigMiB })) {
      $source = "$Letter\lecture\$($file.nom)"
      foreach ($pass in 'froid', 'chaud') {
        $target = Join-Path $local "$pass-$($file.nom)"
        # Copie vers le disque local (CopyFileEx, comme l'Explorateur).
        $ms = Measure-Ms { [IO.File]::Copy($source, $target, $true) }
        $Result.mesures["lecture-$($file.cle)-$pass-ms"] = $ms
        $Result.mesures["lecture-$($file.cle)-$pass-mioParS"] = Round1 ($file.mio / ($ms / 1000))
        if ($pass -eq 'froid') {
          $same = (Get-Sha $target) -eq $Hashes[$file.cle]
          Add-Check "Lecture de $($file.mio) Mio (contenu intact)" $same "$(Fmt $ms 'ms')"
        }
      }
    }
  }

  Invoke-Step 'Lecture partielle (64 Kio d''un gros fichier)' {
    $before = [long](Invoke-Rc $script:Mount 'core/stats').bytes
    $stream = [IO.FileStream]::new("$Letter\lecture\partiel.bin", [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite, 4096)
    try {
      $buffer = [byte[]]::new(64KB)
      [void]$stream.Read($buffer, 0, $buffer.Length)
    } finally {
      $stream.Dispose()
    }
    # Le téléchargement anticipé s'arrête après 5 s sans lecteur (vfscache/downloaders).
    Start-Sleep -Seconds 7
    $after = [long](Invoke-Rc $script:Mount 'core/stats').bytes
    $Result.mesures['lecturePartielle-telechargeMio'] = Round1 (($after - $before) / 1MB)
  }

  Invoke-Step 'Lectures en parallèle (4 × 32 Mio)' {
    $files = 1..4 | ForEach-Object { "$Letter\lecture\parallele-$_.bin" }
    $ms = Measure-Ms {
      $files | ForEach-Object -ThrottleLimit 4 -Parallel {
        $stream = [IO.FileStream]::new($_, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite, 1MB, [IO.FileOptions]::SequentialScan)
        try { [void][Security.Cryptography.SHA256]::HashData($stream) } finally { $stream.Dispose() }
      }
    }
    $Result.mesures['lectureParallele-ms'] = $ms
    $Result.mesures['lectureParallele-mioParS'] = Round1 (128 / ($ms / 1000))
    $Result.rclone.apresLectures = Get-ProcSample $RcloneProcess
  }

  # ── Écritures ──────────────────────────────────────────────────────────────
  Invoke-Step "Écriture de $SmallFiles petits fichiers" {
    $relative = "ecriture-$SmallFiles"
    $dir = "$Letter\$relative"
    [void][IO.Directory]::CreateDirectory($dir)
    $content = New-RandomBytes 4096
    $cpu0 = Get-CpuMs $RcloneProcess
    $writeMs = Measure-Ms {
      for ($i = 0; $i -lt $SmallFiles; $i++) {
        [IO.File]::WriteAllBytes("$dir\note-$('{0:D4}' -f $i).txt", $content)
      }
    }
    $sentMs = Wait-Until { (Get-PendingUploads $script:Mount) -eq 0 -and (Get-ServerCount $relative) -eq $SmallFiles } 900000 200
    $Result.mesures['petitsFichiers-ecritureMs'] = $writeMs
    $Result.mesures['petitsFichiers-envoiCompletMs'] = if ($null -ne $sentMs) { Round1 ($writeMs + $sentMs) } else { $null }
    $Result.mesures['petitsFichiers-fichiersParS'] = if ($null -ne $sentMs) { Round1 ($SmallFiles / (($writeMs + $sentMs) / 1000)) } else { $null }
    $Result.rclone.cpuPetitsFichiersMs = Round1 ((Get-CpuMs $RcloneProcess) - $cpu0)
    Add-Check "Envoi de $SmallFiles petits fichiers" ($null -ne $sentMs) "écrits en $(Fmt $writeMs 'ms'), envoyés $(Fmt $sentMs 'ms') plus tard"
  }

  Invoke-Step "Écriture d'un fichier de $BigMiB Mio" {
    [void][IO.Directory]::CreateDirectory("$Letter\gros-envoi")
    $hash = $null
    $writeMs = Measure-Ms { Write-RandomFile "$Letter\gros-envoi\gros.bin" ($BigMiB * 1MB) } ([ref]$hash)
    $serverFile = Join-Path $SrvDir 'gros-envoi\gros.bin'
    $sentMs = Wait-Until { (Get-PendingUploads $script:Mount) -eq 0 -and (Test-File $serverFile) -and (Get-Item -LiteralPath $serverFile).Length -eq ($BigMiB * 1MB) } 900000 200
    $Result.mesures['grosFichier-ecritureMs'] = $writeMs
    $Result.mesures['grosFichier-envoiCompletMs'] = if ($null -ne $sentMs) { Round1 ($writeMs + $sentMs) } else { $null }
    $same = ($null -ne $sentMs) -and ((Get-Sha $serverFile) -eq $hash)
    Add-Check "Envoi d'un fichier de $BigMiB Mio (contenu intact)" $same "écrit en $(Fmt $writeMs 'ms'), envoyé $(Fmt $sentMs 'ms') plus tard"
    $Result.rclone.apresEcritures = Get-ProcSample $RcloneProcess
  }

  Invoke-Step 'Enregistrement à la façon d''Excel' {
    # Excel écrit un temporaire sans extension, renomme l'original en .tmp, renomme le
    # temporaire, puis supprime l'ancien : le document doit garder son nom et son contenu.
    $dir = "$Letter\office"
    $content = New-RandomBytes 200KB
    $expected = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($content))
    $ms = Measure-Ms {
      [IO.File]::WriteAllBytes("$dir\5A3C2B10", $content)
      [IO.File]::Move("$dir\Budget.xlsx", "$dir\3D8E1F22.tmp")
      [IO.File]::Move("$dir\5A3C2B10", "$dir\Budget.xlsx")
      [IO.File]::Delete("$dir\3D8E1F22.tmp")
    }
    $serverFile = Join-Path $SrvDir 'office\Budget.xlsx'
    $settled = Wait-Until { (Get-PendingUploads $script:Mount) -eq 0 -and (Get-Sha $serverFile) -eq $expected } 60000 200
    $left = @([IO.Directory]::GetFiles((Join-Path $SrvDir 'office')) | ForEach-Object { Split-Path -Leaf $_ })
    $Result.mesures['excel-enregistrementMs'] = $ms
    Add-Check 'Enregistrement façon Excel' (($null -ne $settled) -and $left.Count -eq 1) "serveur : $($left -join ', ')"
  }

  # ── Renommages et suppressions ─────────────────────────────────────────────
  Invoke-Step 'Renommages' {
    $ms = Measure-Ms { [IO.File]::Move("$Letter\renommage\a.txt", "$Letter\renommage\b.txt") }
    $Result.mesures['renommageFichierMs'] = $ms
    $ok = $null -ne (Wait-Until { (Test-File (Join-Path $SrvDir 'renommage\b.txt')) -and -not (Test-File (Join-Path $SrvDir 'renommage\a.txt')) } 10000)
    Add-Check 'Renommage d''un fichier' $ok "$(Fmt $ms 'ms')"

    $ms = Measure-Ms { [IO.Directory]::Move("$Letter\renommage\dossier-100", "$Letter\renommage\dossier-100-renomme") }
    $Result.mesures['renommageDossier100Ms'] = $ms
    $ok = $null -ne (Wait-Until { (Get-ServerCount 'renommage\dossier-100-renomme') -eq 100 -and -not (Test-Dir (Join-Path $SrvDir 'renommage\dossier-100')) } 10000)
    Add-Check 'Renommage d''un dossier de 100 fichiers' $ok "$(Fmt $ms 'ms')"

    # Casse seule : « casse.txt » → « CASSE.txt ». WinFsp le refuse (« le fichier existe
    # déjà ») : observé, sans verdict. L'essentiel est vérifié : rien n'est perdu.
    $serverNames = { @([IO.Directory]::GetFiles((Join-Path $SrvDir 'renommage')) | ForEach-Object { Split-Path -Leaf $_ }) }
    $caseError = $null
    try {
      $ms = Measure-Ms { [IO.File]::Move("$Letter\renommage\casse.txt", "$Letter\renommage\CASSE.txt") }
      $Result.mesures['renommageCasseMs'] = $ms
    } catch {
      $caseError = $_.Exception.InnerException.Message ?? $_.Exception.Message
    }
    $renamed = $null -ne (Wait-Until { $n = & $serverNames; ($n -ccontains 'CASSE.txt') -and -not ($n -ccontains 'casse.txt') } 5000)
    Add-Observation 'renommageCasse' ([ordered]@{ renomme = $renamed; erreur = $caseError; serveur = @(& $serverNames) })
    Add-Check 'Renommage de la casse seule : aucun fichier perdu' (@(& $serverNames | Where-Object { $_ -ieq 'casse.txt' }).Count -eq 1) "serveur : $((& $serverNames) -join ', ')"
  }

  Invoke-Step 'Suppressions' {
    $files = [IO.Directory]::GetFiles("$Letter\suppression")
    $ms = Measure-Ms { foreach ($file in $files) { [IO.File]::Delete($file) } }
    $Result.mesures['suppression100FichiersMs'] = $ms
    Add-Check 'Suppression de 100 fichiers' ($null -ne (Wait-Until { (Get-ServerCount 'suppression') -eq 0 } 10000)) "$(Fmt $ms 'ms')"

    $ms = Measure-Ms { [IO.Directory]::Delete("$Letter\suppression-arbre", $true) }
    $Result.mesures['suppressionArbreMs'] = $ms
    Add-Check 'Suppression d''une arborescence (10 × 10)' ($null -ne (Wait-Until { -not (Test-Dir (Join-Path $SrvDir 'suppression-arbre')) } 10000)) "$(Fmt $ms 'ms')"
  }

  Invoke-Step 'Suppression vers la corbeille (comme l''Explorateur)' {
    $target = "$Letter\corbeille\supprime-moi.txt"
    $output = Join-Path $Work 'corbeille.json'
    $process = Start-Process pwsh -ArgumentList @('-NoProfile', '-STA', '-File', (Join-Path $PSScriptRoot 'recycle-delete.ps1'), '-Path', $target) `
      -PassThru -NoNewWindow -RedirectStandardOutput $output
    $finished = $process.WaitForExit(60000)
    if (-not $finished) { try { $process.Kill($true) } catch { } }
    $answer = if ($finished -and (Test-File $output)) { Get-Content -Raw -LiteralPath $output | ConvertFrom-Json } else { $null }
    $serverBin = Join-Path $SrvDir '$RECYCLE.BIN'
    # @(…) autour du if : sinon une liste vide devient $null (et .Count échoue en mode strict).
    $binFiles = @(if (Test-Dir $serverBin) { Get-ChildItem -LiteralPath $serverBin -Recurse -Force -File | ForEach-Object { $_.FullName.Substring($SrvDir.Length + 1) } })
    $stillThere = Test-File (Join-Path $SrvDir 'corbeille\supprime-moi.txt')
    $inWindowsBin = Get-Prop $answer 'dansLaCorbeille'
    $outcome = if (-not $finished) { 'bloqué (boîte de dialogue ?)' }
      elseif ($binFiles.Count -gt 0) { 'déplacé dans $RECYCLE.BIN sur le serveur' }
      elseif ($stillThere) { 'toujours sur le serveur' }
      elseif ($inWindowsBin) { 'dans la corbeille de Windows' }
      else { 'supprimé du serveur (pas de corbeille Windows)' }
    Add-Observation 'corbeille' ([ordered]@{
        resultat = $outcome; code = Get-Prop $answer 'code'; dansLaCorbeilleWindows = $inWindowsBin
        dossierCorbeilleServeur = Test-Dir $serverBin; fichiersCorbeilleServeur = $binFiles
        visibleSurLeLecteur = Test-Dir (Join-Path $Root '$RECYCLE.BIN')
      })
  }

  # ── Noms et chemins ────────────────────────────────────────────────────────
  Invoke-Step 'Noms accentués, emoji, chemin long' {
    $folder = 'Comptabilité – été 2026 📁'
    $file = 'Facture n°12 (copie) #3 & 50 %.txt'
    [void][IO.Directory]::CreateDirectory("$Letter\$folder")
    [IO.File]::WriteAllText("$Letter\$folder\$file", 'contenu accentué é à ç')
    $ok = $null -ne (Wait-Until { (Get-PendingUploads $script:Mount) -eq 0 -and (Test-File (Join-Path $SrvDir "$folder\$file")) } 30000 100)
    Add-Check 'Noms accentués et emoji (vers le serveur)' $ok "$folder\$file"

    $deep = "$Letter\long\" + ((1..6 | ForEach-Object { 'Dossier très long numéro ' + $_ + ' ' + ('x' * 20) }) -join '\')
    [void][IO.Directory]::CreateDirectory($deep)
    $path = "$deep\Document au nom lui aussi assez long pour dépasser.txt"
    [IO.File]::WriteAllText($path, 'chemin long')
    $relative = $path.Substring(3)
    $ok = $null -ne (Wait-Until { (Get-PendingUploads $script:Mount) -eq 0 -and (Test-File (Join-Path $SrvDir $relative)) } 30000 100)
    Add-Check "Chemin de $($path.Length) caractères" ($ok -and [IO.File]::ReadAllText($path) -eq 'chemin long')
  }

  Invoke-Step 'Noms interdits sous Windows, vus sur le lecteur' {
    $listed = @([IO.Directory]::GetFiles("$Letter\noms") | ForEach-Object { Split-Path -Leaf $_ })
    foreach ($name in $ForbiddenNames) {
      $expected = ConvertTo-ExplorerName $name
      $readable = $false
      try { $readable = [IO.File]::ReadAllText("$Letter\noms\$expected") -eq $name } catch { }
      Add-Check "« $name » (U+F0xx) lisible" (($listed -contains $expected) -and $readable)
    }
  }

  # ── Changements faits ailleurs ─────────────────────────────────────────────
  Invoke-Step 'Changement fait ailleurs : délai d''apparition' {
    [void][IO.Directory]::GetFileSystemEntries("$Letter\distant")
    Invoke-Dav 'PUT' 'distant/nouveau.txt' ([Text.Encoding]::UTF8.GetBytes('ajouté sur le web'))
    Start-Sleep -Seconds 2
    # Attendu : invisible (liste en cache 10 min) — c'est pourquoi l'application oublie le dossier.
    Add-Observation 'visibleSansOubliApres2s' (Test-File "$Letter\distant\nouveau.txt")

    $clock = [Diagnostics.Stopwatch]::StartNew()
    Invoke-Rc $script:Mount 'vfs/forget' @{ dir = 'distant' } | Out-Null
    $shown = Wait-Until { Test-File "$Letter\distant\nouveau.txt" } 10000 10
    $Result.mesures['distant-apparitionApresOubliMs'] = if ($null -ne $shown) { Round1 $clock.Elapsed.TotalMilliseconds } else { $null }
    Add-Check 'Fichier ajouté ailleurs visible après vfs/forget' ($null -ne $shown) "$(Fmt $Result.mesures['distant-apparitionApresOubliMs'] 'ms')"

    Invoke-Dav 'DELETE' 'distant/nouveau.txt'
    $clock.Restart()
    Invoke-Rc $script:Mount 'vfs/forget' @{ dir = 'distant' } | Out-Null
    $gone = Wait-Until { -not (Test-File "$Letter\distant\nouveau.txt") } 10000 10
    $Result.mesures['distant-disparitionApresOubliMs'] = if ($null -ne $gone) { Round1 $clock.Elapsed.TotalMilliseconds } else { $null }
    Add-Check 'Fichier supprimé ailleurs disparu après vfs/forget' ($null -ne $gone)

    # Nouveau dossier à la racine, « tout oublier » (plan « all » de l'application). rclone
    # épingle la liste d'un dossier qui contient un envoi en attente ou un fichier créé et
    # encore ouvert (la racine, dès qu'il y en a un quelque part) : l'application fait alors
    # relire la racine par « file=.mapli-relire » (invalidation.ts, relistParams), comme ici.
    Invoke-Dav 'MKCOL' 'Nouveau dossier distant'
    $clock.Restart()
    Invoke-Rc $script:Mount 'vfs/forget' | Out-Null
    Invoke-Rc $script:Mount 'vfs/forget' @{ file = '.mapli-relire' } | Out-Null
    $shown = Wait-Until { Test-Dir "$Letter\Nouveau dossier distant" } 10000 10
    $Result.mesures['distant-dossierRacineApresToutOublierMs'] = if ($null -ne $shown) { Round1 $clock.Elapsed.TotalMilliseconds } else { $null }
    if ($null -eq $shown) {
      # Diagnostic : qui garde l'ancienne liste de la racine, rclone ou Windows ?
      $diag = [ordered]@{
        surLeServeur = Test-Dir (Join-Path $SrvDir 'Nouveau dossier distant')
        racineListeeParWindows = @([IO.Directory]::GetDirectories("$Letter\") | ForEach-Object { Split-Path -Leaf $_ })
      }
      $diag.visibleApresListe = Test-Dir "$Letter\Nouveau dossier distant"
      Invoke-Rc $script:Mount 'vfs/refresh' | Out-Null
      $diag.visibleApresVfsRefreshMs = Wait-Until { Test-Dir "$Letter\Nouveau dossier distant" } 5000 10
      $diag.visibleApres30s = $null -ne (Wait-Until { Test-Dir "$Letter\Nouveau dossier distant" } 30000 100)
      Add-Observation 'dossierRacineDiagnostic' $diag
    }
    Add-Check 'Dossier créé ailleurs visible après « tout oublier »' ($null -ne $shown)
  }

  # ── Assistant de l'Explorateur ─────────────────────────────────────────────
  Invoke-Step 'Assistant de l''Explorateur (PowerShell 5.1)' {
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $helperScript = Join-Path $Repo 'resources\explorer-notify.ps1'
    $runs = @()
    foreach ($run in 'premier', 'second') {
      # Mêmes arguments que helperArgs() (src/main/explorer-notify.ts).
      $info = [Diagnostics.ProcessStartInfo]::new($powershell)
      foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', $helperScript)) { $info.ArgumentList.Add($argument) }
      $info.UseShellExecute = $false
      $info.CreateNoWindow = $true
      $info.RedirectStandardInput = $true
      $info.RedirectStandardOutput = $true
      $clock = [Diagnostics.Stopwatch]::StartNew()
      $helper = [Diagnostics.Process]::Start($info)
      $Processes.Add($helper)
      $task = $helper.StandardOutput.ReadLineAsync()
      $ready = $task.Wait(60000) -and $task.Result -eq 'ready'
      $readyMs = Round1 $clock.Elapsed.TotalMilliseconds
      Start-Sleep -Milliseconds 500
      $idle = Get-ProcSample $helper

      # Lot de 200 notifications (UPDATEDIR) sur de vrais chemins du lecteur, comme l'application.
      $paths = @($Root) + @([IO.Directory]::GetDirectories($Root)) + @(1..200 | ForEach-Object { "$Letter\Dossier $_" })
      $lines = $paths | Select-Object -First 200 | ForEach-Object { "4096`t" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_)) }
      $clock.Restart()
      $helper.StandardInput.Write((($lines -join "`n") + "`n`n"))
      $helper.StandardInput.Flush()
      $task = $helper.StandardOutput.ReadLineAsync()
      $acked = $task.Wait(30000) -and $task.Result -eq 'ok'
      $batchMs = Round1 $clock.Elapsed.TotalMilliseconds
      Start-Sleep -Milliseconds 300
      $after = Get-ProcSample $helper
      $helper.StandardInput.Close()
      $exited = $helper.WaitForExit(10000)
      if (-not $exited) { try { $helper.Kill() } catch { } }
      $runs += [ordered]@{ lancement = $run; pretMs = $readyMs; pret = $ready; auRepos = $idle; lot200Ms = $batchMs; lotAcquitte = $acked; apresLot = $after; arretPropre = $exited }
      Add-Check "Assistant de l'Explorateur ($run lancement)" ($ready -and $acked -and $exited) "prêt en $(Fmt $readyMs 'ms'), 200 notifications en $(Fmt $batchMs 'ms')"
    }
    $Result.assistant = $runs
  }

  # ── Bilan de rclone, démontage ─────────────────────────────────────────────
  Invoke-Step 'Bilan de rclone' {
    $core = Invoke-Rc $script:Mount 'core/stats'
    $vfs = Invoke-Rc $script:Mount 'vfs/stats'
    $Result.rclone.fin = Get-ProcSample $RcloneProcess
    $Result.rclone.erreurs = Get-Prop $core 'errors'
    $Result.rclone.derniereErreur = Get-Prop $core 'lastError'
    $Result.rclone.transferts = Get-Prop $core 'transfers'
    $Result.rclone.octetsTransferesMio = Round1 ([double](Get-Prop $core 'bytes') / 1MB)
    $cache = $vfs.diskCache
    $Result.rclone.cache = [ordered]@{
      occupeMio = Round1 ([double](Get-Prop $cache 'bytesUsed') / 1MB); fichiers = Get-Prop $cache 'files'
      enErreur = Get-Prop $cache 'erroredFiles'; plein = Get-Prop $cache 'outOfSpace'; chemin = Get-Prop $cache 'path'
    }
    Add-Check 'Aucun envoi en échec dans le cache' ([int](Get-Prop $cache 'erroredFiles') -eq 0) "$(Get-Prop $cache 'erroredFiles') en échec"
  }
  $unmount = Stop-Mount $script:Mount
  $Result.montage.demontage = $unmount
  $unmountMs = if ($null -ne $unmount) { $unmount.arretMs } else { $null }
  Add-Check 'Démontage propre (core/quit)' (($null -ne $unmount) -and -not $unmount.arretForce) "$(Fmt $unmountMs 'ms')"
  $errorLines = @(Get-Content -LiteralPath $script:Mount.Log -ErrorAction SilentlyContinue | Where-Object { $_ -match 'ERROR|CRITICAL' })
  $Result.rclone.lignesErreurJournal = $errorLines.Count
  $Result.rclone.extraitErreurs = @($errorLines | Select-Object -First 10)

  # ── Messages et contrôles de l'application en cas d'échec ──────────────────
  Invoke-Step 'Lettre déjà prise par autre chose' {
    # Une clé USB ou un lecteur réseau a pris la lettre pendant que l'application était
    # fermée : rclone échoue. Que verrait l'application ? drive-mount.ts juge le lecteur
    # prêt dès que « M:\ » répond (probePath, premier essai après 400 ms).
    $letter = @('Y:', 'X:', 'W:', 'V:') | Where-Object { -not (Test-Dir "$_\") } | Select-Object -First 1
    $substDir = (New-Item -ItemType Directory -Force -Path (Join-Path $Work 'subst')).FullName
    & subst $letter $substDir
    $Substs.Add($letter)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $attempt = Start-Mount (New-Secret 20) 'lettre-prise' $letter -NoWait
    Start-Sleep -Milliseconds 400
    $believedMounted = (-not $attempt.Process.HasExited) -and (Test-Dir "$letter\")
    $exited = $attempt.Process.WaitForExit(20000)
    $exitMs = Round1 $clock.Elapsed.TotalMilliseconds
    if (-not $exited) { Stop-Mount $attempt | Out-Null }
    $tail = Get-LogTail $attempt.Log 60
    $explanation = Get-AppExplanation $tail
    Add-Observation 'lettrePrise' ([ordered]@{
        lettre = $letter; rcloneArreteApresMs = if ($exited) { $exitMs } else { $null }
        applicationCroitLeLecteurMonte = $believedMounted; messageMontre = $explanation; journal = $tail
      })
    & subst $letter /D
    [void]$Substs.Remove($letter)
  }

  Invoke-Step 'Jeton refusé (401) : ce que voit l''application' {
    # controller.ts vérifie le token quand la dernière erreur de rclone (core/stats) parle de
    # 401 : est-ce le cas quand le serveur refuse une liste de dossier ?
    $authDir = (New-Item -ItemType Directory -Force -Path (Join-Path $Work 'serveur-protege')).FullName
    $authPort = Get-FreePort
    $authServer = Start-DavServer $authDir $authPort @('--user', 'banc', '--pass', (New-Secret 16))
    $letter = @('X:', 'W:', 'V:', 'U:') | Where-Object { -not (Test-Dir "$_\") } | Select-Object -First 1
    $attempt = Start-Mount (New-Secret 20) 'jeton-refuse' $letter "http://127.0.0.1:$authPort/" 20000
    $listError = $null
    try { [void][IO.Directory]::GetFileSystemEntries("$letter\Clients") } catch { $listError = $_.Exception.Message }
    $core = $null
    if (-not $attempt.Process.HasExited) { try { $core = Invoke-Rc $attempt 'core/stats' } catch { } }
    $lastError = "$(Get-Prop $core 'lastError')"
    Add-Observation 'jetonRefuse' ([ordered]@{
        lettreApparue = $null -ne $attempt.LetterMs; racineLisible = $attempt.Ok; erreurDeListe = $listError
        erreursComptees = Get-Prop $core 'errors'; derniereErreur = $lastError
        detecteParApplication = $lastError -match '(?i)\b401\b|unauthori[sz]ed'
        journal = Get-LogTail $attempt.Log 20
      })
    Stop-Mount $attempt | Out-Null
    try { $authServer.Kill() } catch { }
  }

  if ($Mode -eq 'disque') {
    Invoke-Step 'Serveur muet : combien de temps une application reste bloquée' {
      # Serveur qui accepte la connexion sans jamais répondre (surcharge, panne) : chaque
      # requête attend --timeout, et rclone la refait --low-level-retries fois. Pendant ce
      # temps, l'application qui lit le dossier (l'Explorateur) est figée. Mesuré dans une
      # tâche à part, plafonné : le banc lui-même ne doit jamais rester bloqué.
      $limitS = 100
      $mutePort = Get-FreePort
      $info = [Diagnostics.ProcessStartInfo]::new((Get-Command node).Source)
      foreach ($argument in @('-e', "require('net').createServer(() => {}).listen($mutePort, '127.0.0.1')")) { $info.ArgumentList.Add($argument) }
      $info.UseShellExecute = $false
      $info.CreateNoWindow = $true
      $mute = [Diagnostics.Process]::Start($info)
      $Processes.Add($mute)
      Start-Sleep -Milliseconds 500
      $letter = @('W:', 'V:', 'U:', 'T:') | Where-Object { -not (Test-Dir "$_\") } | Select-Object -First 1
      $attempt = Start-Mount (New-Secret 20) 'serveur-muet' $letter "http://127.0.0.1:$mutePort/" -NoWait
      $probe = Start-ThreadJob -ArgumentList "$letter\" -ScriptBlock {
        param($root)
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while (-not [IO.Directory]::Exists($root) -and $clock.ElapsedMilliseconds -lt 30000) { Start-Sleep -Milliseconds 50 }
        $appeared = $clock.ElapsedMilliseconds
        $clock.Restart()
        try {
          [void][IO.Directory]::GetFileSystemEntries($root)
          "liste obtenue après $($clock.ElapsedMilliseconds) ms (lettre après $appeared ms)"
        } catch {
          "erreur après $($clock.ElapsedMilliseconds) ms (lettre après $appeared ms) : $($_.Exception.Message)"
        }
      }
      $finished = Wait-Job $probe -Timeout $limitS
      $answer = if ($finished) { "$(Receive-Job $probe)" } else { "toujours bloquée après $limitS s" }
      # Arrêter rclone débloque l'appel en cours (WinFsp le fait échouer).
      Stop-Mount $attempt | Out-Null
      Remove-Job $probe -Force -ErrorAction SilentlyContinue
      try { $mute.Kill() } catch { }
      Add-Observation 'serveurMuet' ([ordered]@{ plafondS = $limitS; listeDeLaRacine = $answer })
    }
  }
} catch {
  $Result.erreurs.Add([ordered]@{ etape = 'banc'; message = $_.Exception.Message; ligne = $_.InvocationInfo.ScriptLineNumber })
  Write-Host "::error::$($_.Exception.Message)"
} finally {
  foreach ($letter in @($Substs)) { & subst $letter /D 2>$null }
  foreach ($process in $Processes) {
    try { if (-not $process.HasExited) { $process.Kill($true) } } catch { }
  }
}

# ── Résultats ──────────────────────────────────────────────────────────────

$jsonPath = Join-Path $OutDir "bench-windows-$Mode.json"
$Result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $jsonPath -Encoding utf8

$md = [Text.StringBuilder]::new()
function Md([string] $Line = '') { [void]$md.AppendLine($Line) }
function Row([string] $Label, $Value, [string] $Unit = '') { Md "| $Label | $(Fmt $Value $Unit) |" }
$m = $Result.mesures

$title = "### Lecteur Windows — mode « $Mode »"
if ($LatencyMs -gt 0) { $title += " — latence +$LatencyMs ms" }
if ($Extra.Count -gt 0) { $title += " — options : $($Extra -join ' ')" }
Md $title
Md ''
Md "$($Result.environnement['systeme']) · $($Result.environnement['processeur']) · rclone $($Result.environnement['rclone']) · WinFsp $($Result.environnement['winfsp']) · antivirus temps réel : $($Result.environnement['antivirusTempsReel'])"
Md ''
Md '| Mesure | Valeur |'
Md '|---|---|'
if ($Result.montage.Contains('premier')) { Row 'Premier montage (pilote à froid) : lettre / première liste' "$(Fmt $Result.montage.premier.lettreMs) / $(Fmt $Result.montage.premier.premiereListeMs)" 'ms' }
if ($Result.montage.Contains('principal')) { Row 'Montage : lettre / première liste' "$(Fmt $Result.montage.principal.lettreMs) / $(Fmt $Result.montage.principal.premiereListeMs)" 'ms' }
foreach ($key in @($m.Keys)) {
  $unit = if ($key -like '*ms') { 'ms' } elseif ($key -like '*mioParS') { 'Mio/s' } elseif ($key -like '*Mio') { 'Mio' } elseif ($key -like '*fichiersParS') { 'fichiers/s' } else { '' }
  Row $key $m[$key] $unit
}
if ($Result.montage.Contains('demontage') -and $Result.montage.demontage) { Row 'Démontage (core/quit)' $Result.montage.demontage.arretMs 'ms' }
foreach ($phase in 'apresMontage', 'apresLectures', 'apresEcritures', 'fin') {
  if ($Result.rclone.Contains($phase)) {
    $sample = $Result.rclone[$phase]
    Row "rclone $phase : mémoire de travail / privée / pic privé" "$(Fmt $sample.memoireTravailMo) / $(Fmt $sample.memoirePriveeMo) / $(Fmt $sample.picPriveeMo)" 'Mo'
  }
}
if ($Result.rclone.Contains('cpuAuReposMsPar10s')) { Row 'rclone au repos : processeur sur 10 s' $Result.rclone.cpuAuReposMsPar10s 'ms' }
foreach ($run in @($Result.assistant)) {
  if ($run -is [Collections.IDictionary]) {
    Row "Assistant Explorateur ($($run.lancement)) : prêt / lot de 200" "$(Fmt $run.pretMs) / $(Fmt $run.lot200Ms)" 'ms'
    Row "Assistant Explorateur ($($run.lancement)) : mémoire privée au repos" $run.auRepos.memoirePriveeMo 'Mo'
  }
}
Md ''
# Texte d'une cellule de tableau (ni retour à la ligne ni barre verticale).
function Cell($Value) { if ($null -eq $Value) { '—' } else { "$Value" -replace '[\r\n|]+', ' ' } }
$o = $Result.observations
Md '| Observation | Résultat |'
Md '|---|---|'
if ($o.Contains('volume')) { Md "| Volume vu par Windows | $(Cell $o.volume.type), $(Cell $o.volume.systemeDeFichiers), sensible à la casse : $(Cell $o.volume.sensibleCasse) |" }
if ($o.Contains('corbeille')) { Md "| Suppr dans l'Explorateur (FOF_ALLOWUNDO) | $(Cell $o.corbeille.resultat) |" }
if ($o.Contains('visibleSansOubliApres2s')) { Md "| Fichier ajouté ailleurs, visible sans vfs/forget après 2 s | $(Cell $o.visibleSansOubliApres2s) |" }
if ($o.Contains('cacheParJeton')) { Md "| Dossier du cache : autre token → autre dossier / même token → même dossier | $(Cell $o.cacheParJeton.different) / $(Cell $o.cacheParJeton.memeJetonMemeDossier) |" }
if ($o.Contains('lettrePrise')) { Md "| Lettre prise par autre chose : l'application croit le lecteur monté / message | $(Cell $o.lettrePrise.applicationCroitLeLecteurMonte) / $(Cell $o.lettrePrise.messageMontre) |" }
if ($o.Contains('serveurMuet')) { Md "| Serveur muet : liste de la racine | $(Cell $o.serveurMuet.listeDeLaRacine) |" }
if ($o.Contains('jetonRefuse')) { Md "| Jeton refusé (liste en 401) : détecté par l'application | $(Cell $o.jetonRefuse.detecteParApplication) (dernière erreur : $(Cell $o.jetonRefuse.derniereErreur)) |" }
Md ''
$failed = @($Result.verifications | Where-Object { -not $_.ok })
Md "**Vérifications** : $($Result.verifications.Count - $failed.Count) / $($Result.verifications.Count) réussies."
foreach ($check in $failed) { Md "- ÉCHEC — $($check.nom) : $($check.detail)" }
foreach ($problem in $Result.erreurs) { Md "- ERREUR — $($problem.etape) : $($problem.message) (ligne $($problem.ligne))" }
Md ''

$summary = $md.ToString()
Set-Content -LiteralPath (Join-Path $OutDir "resume-$Mode.md") -Value $summary -Encoding utf8
if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $summary -Encoding utf8 }
Write-Host $summary

# Code de sortie explicite : sinon celui de la dernière commande native (subst, fsutil…).
if ($failed.Count -gt 0 -or $Result.erreurs.Count -gt 0) { exit 1 }
exit 0
