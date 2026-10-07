#Requires -Version 7.2
<#
.SYNOPSIS
  Installateur de Mapli Drive sous Windows : installation silencieuse (WinFsp compris),
  démarrage de l'application installée, désinstallation.

.DESCRIPTION
  À lancer sur un poste sans WinFsp ni Mapli Drive (machine neuve de la CI) :
   1. rclone sans WinFsp : le message que montrerait l'application (explainFailure de
      src/main/drive-mount.ts) ;
   2. installation silencieuse (/S, celle des mises à jour) : durée, WinFsp installé par
      build/installer.nsh, fichiers en place (rclone.exe, explorer-notify.ps1) ;
   3. démarrage de l'application installée, sans appairage (app-startup.mjs) : temps et
      mémoire. app.mapli.fr est détourné vers 127.0.0.1 dans le fichier hosts : aucune
      requête vers la production (mise à jour automatique comprise) ;
   4. désinstallation silencieuse : durée, fichiers retirés, WinFsp gardé (il peut servir
      à d'autres logiciels).
  Sorties dans -OutDir : installateur.json, resume-installateur.md, app-windows.json ; le
  résumé est ajouté à $env:GITHUB_STEP_SUMMARY s'il existe.
#>
param(
  [Parameter(Mandatory)] [string] $Installer,
  [Parameter(Mandatory)] [string] $Rclone,
  [string] $OutDir = (Join-Path ([IO.Path]::GetTempPath()) 'mapli-bench'),
  [int] $Duration = 20
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Installer = (Resolve-Path $Installer).Path
$Rclone = (Resolve-Path $Rclone).Path
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

$Result = [ordered]@{ installateur = Split-Path -Leaf $Installer; tailleMo = [math]::Round((Get-Item -LiteralPath $Installer).Length / 1MB, 1) }
$Checks = [Collections.Generic.List[object]]::new()
function Add-Check([string] $Name, [bool] $Ok, [string] $Detail = '') {
  $Checks.Add([ordered]@{ nom = $Name; ok = $Ok; detail = $Detail })
  Write-Host "[$(if ($Ok) { 'OK' } else { 'ÉCHEC' })] $Name $Detail"
}
function Get-WinFspDir {
  $key = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\WinFsp' -ErrorAction SilentlyContinue
  if ($key -and $key.PSObject.Properties['InstallDir']) { $key.InstallDir } else { $null }
}
function Get-UninstallEntry {
  Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq 'Mapli Drive' } |
    Select-Object -First 1
}

# ── 1. rclone sans WinFsp ─────────────────────────────────────────────────
if (Get-WinFspDir) {
  Write-Host 'WinFsp est déjà installé : test « WinFsp absent » sauté.'
} else {
  $log = Join-Path $OutDir 'rclone-sans-winfsp.log'
  $config = Join-Path $OutDir 'rclone-vide.conf'
  Set-Content -LiteralPath $config -Value '' -NoNewline
  $info = [Diagnostics.ProcessStartInfo]::new($Rclone)
  foreach ($argument in @('mount', ':memory:', 'Y:', '--log-file', $log, '--log-level', 'NOTICE')) { $info.ArgumentList.Add($argument) }
  $info.Environment['RCLONE_CONFIG'] = $config
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $process = [Diagnostics.Process]::Start($info)
  if (-not $process.WaitForExit(30000)) { $process.Kill($true) }
  $tail = (Get-Content -LiteralPath $log -Tail 40 -ErrorAction SilentlyContinue) -join "`n"
  # Première règle de explainFailure() : /winfsp|cgofuse/i.
  Add-Check 'Sans WinFsp : l''application dit « WinFsp manquant »' ($tail -match '(?i)winfsp|cgofuse') ($tail -split "`n" | Select-Object -Last 1)
  $Result.sansWinFsp = $tail
}

# ── 2. Installation silencieuse ───────────────────────────────────────────
$clock = [Diagnostics.Stopwatch]::StartNew()
$setup = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
$Result.installationS = [math]::Round($clock.Elapsed.TotalSeconds, 1)
$Result.codeInstallation = $setup.ExitCode
$entry = Get-UninstallEntry
$dir = if ($entry -and $entry.PSObject.Properties['InstallLocation'] -and $entry.InstallLocation) { $entry.InstallLocation.Trim('"') } else { Join-Path $env:ProgramFiles 'Mapli Drive' }
$exe = Join-Path $dir 'Mapli Drive.exe'
$Result.dossier = $dir
$Result.version = if ($entry) { $entry.DisplayVersion } else { $null }
Add-Check 'Installation silencieuse' (($setup.ExitCode -eq 0) -and (Test-Path -LiteralPath $exe)) "code $($setup.ExitCode), $($Result.installationS) s"
foreach ($file in 'rclone.exe', 'explorer-notify.ps1') {
  # extraResources : resources/ de l'application → <installation>\resources\resources\.
  Add-Check "Fichier livré : $file" (Test-Path -LiteralPath (Join-Path $dir "resources\resources\$file"))
}
$winfsp = Get-WinFspDir
$Result.winfsp = if ($winfsp) { (Get-Item (Join-Path $winfsp 'bin\winfsp-x64.dll')).VersionInfo.FileVersion } else { $null }
Add-Check 'WinFsp installé par l''installateur' ([bool]$winfsp) "$($Result.winfsp)"

# ── 3. Démarrage de l'application installée ───────────────────────────────
# Aucune requête vers la production : app.mapli.fr → 127.0.0.1 (connexion refusée).
$hosts = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
Add-Content -LiteralPath $hosts -Value "`r`n127.0.0.1 app.mapli.fr`r`n::1 app.mapli.fr`r`n"
& ipconfig /flushdns | Out-Null
if (Test-Path -LiteralPath $exe) {
  & node (Join-Path $PSScriptRoot 'app-startup.mjs') --exe $exe --duration $Duration `
    --out (Join-Path $OutDir 'app-windows.json') --label 'Windows, application installée' | Out-Host
  Add-Check 'Démarrage de l''application installée' ($LASTEXITCODE -eq 0)
}

# ── 4. Désinstallation silencieuse ────────────────────────────────────────
$uninstaller = Join-Path $dir 'Uninstall Mapli Drive.exe'
if (Test-Path -LiteralPath $uninstaller) {
  $clock.Restart()
  Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait | Out-Null
  # Le désinstallateur de NSIS se relance depuis un dossier temporaire : on attend l'effet.
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  while ([DateTime]::UtcNow -lt $deadline -and ((Test-Path -LiteralPath $exe) -or (Get-UninstallEntry))) { Start-Sleep -Milliseconds 250 }
  $Result.desinstallationS = [math]::Round($clock.Elapsed.TotalSeconds, 1)
  Add-Check 'Désinstallation silencieuse' (-not (Test-Path -LiteralPath $exe) -and -not (Get-UninstallEntry)) "$($Result.desinstallationS) s"
  Add-Check 'WinFsp gardé après désinstallation' ([bool](Get-WinFspDir))
}

# ── Résultats ─────────────────────────────────────────────────────────────
$Result.verifications = $Checks
$Result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutDir 'installateur.json') -Encoding utf8

$lines = @(
  '### Installateur Windows'
  ''
  '| Mesure | Valeur |'
  '|---|---|'
  "| Installateur | $($Result.installateur) ($($Result.tailleMo) Mo) |"
  "| Installation silencieuse (WinFsp compris) | $($Result.installationS) s |"
  "| WinFsp installé | $($Result.winfsp) |"
  "| Désinstallation | $(if ($Result.Contains('desinstallationS')) { "$($Result.desinstallationS) s" } else { '—' }) |"
  ''
)
$failed = @($Checks | Where-Object { -not $_.ok })
$lines += "**Vérifications** : $($Checks.Count - $failed.Count) / $($Checks.Count) réussies."
$lines += @($failed | ForEach-Object { "- ÉCHEC — $($_.nom) : $($_.detail)" })
$lines += ''
$summary = $lines -join "`n"
Set-Content -LiteralPath (Join-Path $OutDir 'resume-installateur.md') -Value $summary -Encoding utf8
if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $summary -Encoding utf8 }
Write-Host $summary

if ($failed.Count -gt 0) { exit 1 }
exit 0
