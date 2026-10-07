#Requires -Version 7.2
<#
.SYNOPSIS
  rclone et WinFsp pour le banc : mêmes versions, mêmes sources et mêmes empreintes que la
  CI de publication.

.DESCRIPTION
  Les versions et les empreintes SHA-256 sont lues dans .github/workflows/build.yml (une
  seule source : le banc mesure ce qui part chez les clients). Un fichier dont l'empreinte
  diffère est supprimé et le script échoue.

.PARAMETER RcloneDest
  Chemin de rclone.exe à écrire.

.PARAMETER WinFspMsi
  Chemin du paquet MSI de WinFsp à écrire (facultatif).

.PARAMETER InstallWinFsp
  Installe WinFsp comme l'installateur de Mapli Drive (build/installer.nsh).
#>
param(
  [Parameter(Mandatory)] [string] $RcloneDest,
  [string] $WinFspMsi = '',
  [switch] $InstallWinFsp
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$workflow = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../../.github/workflows/build.yml')

function Get-BuildValue([string] $Name) {
  $match = [regex]::Match($workflow, "(?m)^\s*$Name\s*:\s*(\S+)\s*$")
  if (-not $match.Success) { throw "build.yml : $Name introuvable" }
  $match.Groups[1].Value
}

function Save-Verified([string] $Url, [string] $Path, [string] $Sha256) {
  Invoke-WebRequest -Uri $Url -OutFile $Path
  $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $Sha256.ToLowerInvariant()) {
    Remove-Item -LiteralPath $Path -Force
    throw "$Url : empreinte inattendue ($hash)"
  }
}

$version = Get-BuildValue 'RCLONE_VERSION'
$temp = Join-Path ([IO.Path]::GetTempPath()) "mapli-rclone-$version"
New-Item -ItemType Directory -Force -Path $temp, (Split-Path -Parent $RcloneDest) | Out-Null
$zip = Join-Path $temp 'rclone.zip'
Save-Verified "https://downloads.rclone.org/$version/rclone-$version-windows-amd64.zip" $zip (Get-BuildValue 'RCLONE_SHA256_WINDOWS')
Expand-Archive -LiteralPath $zip -DestinationPath $temp -Force
Copy-Item -LiteralPath (Join-Path $temp "rclone-$version-windows-amd64\rclone.exe") -Destination $RcloneDest -Force
Write-Host "rclone $version : $RcloneDest"

if ($WinFspMsi) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $WinFspMsi) | Out-Null
  Save-Verified (Get-BuildValue 'WINFSP_URL') $WinFspMsi (Get-BuildValue 'WINFSP_SHA256')
  Write-Host "WinFsp : $WinFspMsi"
  if ($InstallWinFsp) {
    # Comme build/installer.nsh : silencieux, sans redémarrage, tous les composants.
    $msi = Start-Process msiexec.exe -ArgumentList @('/i', "`"$WinFspMsi`"", '/qn', '/norestart', 'INSTALLLEVEL=1000') -Wait -PassThru
    if ($msi.ExitCode -notin 0, 3010) { throw "WinFsp : installation en échec (code $($msi.ExitCode))" }
    Write-Host "WinFsp installé : $((Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\WinFsp').InstallDir)"
  }
}
