import { spawn } from 'child_process'
import { IS_WIN } from './platform'
import type { ShellChange } from './shell-changes'

/*
 * Prévenir l'Explorateur Windows qu'un dossier du lecteur a changé. Son volet de
 * navigation garde les sous-dossiers en mémoire et ne se met à jour que sur une
 * notification du shell (SHChangeNotify) : sans elle, un dossier supprimé sur le web
 * y reste affiché, même après F5. shell32 est appelé par PowerShell (pas de module
 * natif à embarquer) ; le script part encodé, les chemins par l'environnement — rien
 * de variable sur la ligne de commande.
 */

const EVENTS: Record<ShellChange['event'], number> = {
  mkdir: 0x00000008, // SHCNE_MKDIR
  rmdir: 0x00000010, // SHCNE_RMDIR
  updatedir: 0x00001000 // SHCNE_UPDATEDIR
}
const FLAGS = 0x0005 | 0x1000 // SHCNF_PATHW | SHCNF_FLUSH

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace MapliDrive -Name Shell -MemberDefinition '[DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern void SHChangeNotify(int eventId, uint flags, string item1, System.IntPtr item2);'
foreach ($line in ($env:MAPLI_SHELL_CHANGES -split "\`n")) {
  if (-not $line) { continue }
  $parts = $line -split "\`t", 2
  [MapliDrive.Shell]::SHChangeNotify([int]$parts[0], [uint32]${FLAGS}, $parts[1], [System.IntPtr]::Zero)
}
`

/** Envoie les notifications ; ne rejette jamais (au pire, l'Explorateur se met à jour plus tard). */
export function notifyShell(changes: ShellChange[]): Promise<void> {
  if (!IS_WIN || changes.length === 0) return Promise.resolve()

  const payload = changes.map((c) => `${EVENTS[c.event]}\t${c.path}`).join('\n')
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(SCRIPT, 'utf16le').toString('base64')
      ],
      { windowsHide: true, stdio: 'ignore', env: { ...process.env, MAPLI_SHELL_CHANGES: payload } }
    )
    const timer = setTimeout(() => {
      child.kill()
      resolve()
    }, 15_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
