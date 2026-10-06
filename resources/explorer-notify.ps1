# Mapli Drive - notifications du shell Windows (SHChangeNotify) pour l'Explorateur.
#
# Lance une seule fois par Mapli Drive (-File, pas de commande encodee) et nourri par son
# entree standard. Chaque ligne : "<evenement>`t<chemin en base64 UTF-8>". Une ligne vide
# termine un lot : le script repond "ok". Il s'arrete quand Mapli Drive ferme l'entree.
#
# La fonction de shell32 est declaree en memoire (Reflection.Emit) : aucune compilation C#
# (pas d'Add-Type, pas de csc.exe, rien d'ecrit sur le disque). Entre deux lots, la memoire
# de travail est rendue au systeme.
#
# Fichier en ASCII : PowerShell 5.1 lit les scripts sans BOM dans la page de code du systeme.

$ErrorActionPreference = 'Stop'

$assemblyName = New-Object System.Reflection.AssemblyName 'MapliDriveShell'
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
  $assemblyName, [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('MapliDriveShell')
$type = $module.DefineType('MapliDriveShell.Native', 'Public, Class, Sealed, Abstract')

$notify = $type.DefinePInvokeMethod(
  'SHChangeNotify', 'shell32.dll', 'Public, Static, PinvokeImpl',
  [System.Reflection.CallingConventions]::Standard, [void],
  [Type[]] @([int], [uint32], [string], [IntPtr]),
  [System.Runtime.InteropServices.CallingConvention]::Winapi,
  [System.Runtime.InteropServices.CharSet]::Unicode)
$notify.SetImplementationFlags('PreserveSig')

$trim = $type.DefinePInvokeMethod(
  'SetProcessWorkingSetSize', 'kernel32.dll', 'Public, Static, PinvokeImpl',
  [System.Reflection.CallingConventions]::Standard, [bool],
  [Type[]] @([IntPtr], [IntPtr], [IntPtr]),
  [System.Runtime.InteropServices.CallingConvention]::Winapi,
  [System.Runtime.InteropServices.CharSet]::Auto)
$trim.SetImplementationFlags('PreserveSig')

$native = $type.CreateType()
$self = [System.Diagnostics.Process]::GetCurrentProcess().Handle
$utf8 = New-Object System.Text.UTF8Encoding $false

# SHCNF_PATHW (0x0005) | SHCNF_FLUSH (0x1000)
$flags = [uint32] 0x1005
# Evenements acceptes : SHCNE_MKDIR, SHCNE_RMDIR, SHCNE_UPDATEDIR.
$allowed = @(0x00000008, 0x00000010, 0x00001000)

function Send-Line([string] $text) {
  [Console]::Out.WriteLine($text)
  [Console]::Out.Flush()
}

function Free-Memory {
  [System.GC]::Collect()
  [void] $native::SetProcessWorkingSetSize($self, [IntPtr](-1), [IntPtr](-1))
}

function Send-Notification([string] $line) {
  $parts = $line.Split([char] 9)
  if ($parts.Length -ne 2) { return }
  $eventId = 0
  if (-not [int]::TryParse($parts[0], [ref] $eventId)) { return }
  if ($allowed -notcontains $eventId) { return }
  try {
    $path = $utf8.GetString([Convert]::FromBase64String($parts[1]))
    $native::SHChangeNotify($eventId, $flags, $path, [IntPtr]::Zero)
  } catch {
    # Chemin illisible : ignore, l'Explorateur se mettra a jour plus tard.
  }
}

Free-Memory
Send-Line 'ready'

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.Length -eq 0) {
    Free-Memory
    Send-Line 'ok'
  } else {
    Send-Notification $line
  }
}
