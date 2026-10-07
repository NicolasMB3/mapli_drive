import { systemClock, type Clock } from './clock'
import type { ShellChange } from './shell-changes'

/*
 * Prévenir l'Explorateur Windows qu'un dossier du lecteur a changé. Son volet de
 * navigation garde les sous-dossiers en mémoire et ne se met à jour que sur une
 * notification du shell (SHChangeNotify) : sans elle, un dossier supprimé sur le web y
 * reste affiché, même après F5.
 *
 * Un assistant PowerShell (resources/explorer-notify.ps1, lancé avec -File, sans commande
 * encodée ni compilation C#), nourri par son entrée standard ; les notifications sont
 * groupées par lots. Lancé à la première notification, il s'arrête après 5 min sans
 * notification : un PowerShell en attente garde plusieurs dizaines de Mo de mémoire engagée
 * (chargement de .NET ; mesuré par scripts/bench/windows-bench.ps1), pour des changements
 * faits ailleurs qui arrivent par rafales, et la nuit pas du tout. Le relancer coûte de
 * l'ordre d'une seconde, sans effet visible.
 * Sans Electron pour être testé : le lancement du processus est fourni par l'appelant
 * (drive-mount.ts).
 */

export const SHELL_EVENTS: Record<ShellChange['event'], number> = {
  mkdir: 0x00000008, // SHCNE_MKDIR
  rmdir: 0x00000010, // SHCNE_RMDIR
  updatedir: 0x00001000 // SHCNE_UPDATEDIR
}

/** Ce que ShellNotifier attend du processus lancé (ChildProcess, ou un double de test). */
export interface HelperProcess {
  stdin: {
    write(data: string): unknown
    end(): void
    /** Écriture vers un assistant déjà arrêté (EPIPE) : signalée ici, jamais levée. */
    on?(event: 'error', listener: (error: Error) => void): unknown
  } | null
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  once(event: 'exit', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(): unknown
}

export interface NotifierOptions {
  spawn(): HelperProcess
  clock?: Clock
  /** Notifications groupées pendant ce temps avant d'être envoyées. */
  batchMs?: number
  /** Sans « ok » de l'assistant dans ce délai, il est arrêté (relancé au lot suivant). */
  ackTimeoutMs?: number
  /** Sans « ready » dans ce délai, le démarrage compte comme un échec. */
  startTimeoutMs?: number
  /** Sans notification pendant ce temps, l'assistant s'arrête (relancé au besoin). */
  idleMs?: number
  /** Échecs de démarrage consécutifs avant d'abandonner pour la session. */
  maxStartFailures?: number
  log?(message: string): void
}

export const BATCH_MS = 250
export const ACK_TIMEOUT_MS = 15_000
/** Démarrage de PowerShell : une à deux secondes d'habitude, bien plus sous un antivirus zélé. */
export const START_TIMEOUT_MS = 30_000
export const IDLE_MS = 5 * 60_000
export const MAX_START_FAILURES = 3
/** Au-delà, le reste part au lot suivant (un lot de plus, 250 ms plus tard). */
export const MAX_BATCH = 200

/** Ligne du protocole : « <événement>\t<chemin en base64 UTF-8> » (aucun souci d'encodage de console). */
export function helperLine(change: ShellChange): string {
  return `${SHELL_EVENTS[change.event]}\t${Buffer.from(change.path, 'utf8').toString('base64')}`
}

/**
 * Arguments de powershell.exe pour l'assistant : un fichier de script livré avec
 * l'application (-File), sans profil ni commande encodée. RemoteSigned suffit pour un
 * script local (la stratégie par défaut des postes, « Restricted », l'interdirait).
 */
export function helperArgs(scriptPath: string): string[] {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'RemoteSigned',
    '-File',
    scriptPath
  ]
}

export class ShellNotifier {
  private readonly clock: Clock
  private readonly queue = new Map<string, ShellChange>()
  private helper: HelperProcess | null = null
  private ready = false
  private startFailures = 0
  private disabled = false
  private disposed = false
  private batchTimer: unknown = null
  private ackTimer: unknown = null
  private idleTimer: unknown = null
  private awaitingAcks = 0
  private stdoutBuffer = ''

  constructor(private readonly options: NotifierOptions) {
    this.clock = options.clock ?? systemClock
  }

  /** Ajoute des notifications au prochain lot ; ne bloque ni ne rejette jamais. */
  notify(changes: ShellChange[]): void {
    if (this.disabled || this.disposed || changes.length === 0) return
    for (const change of changes) this.queue.set(`${change.event}\t${change.path}`, change)
    this.clearIdle()
    this.scheduleBatch()
  }

  /** Fermeture de l'application : l'assistant s'arrête avec elle. */
  dispose(): void {
    this.disposed = true
    if (this.batchTimer !== null) this.clock.clearTimeout(this.batchTimer)
    this.batchTimer = null
    this.queue.clear()
    this.stopHelper()
  }

  get running(): boolean {
    return this.helper !== null
  }

  private scheduleBatch(): void {
    if (this.batchTimer === null)
      this.batchTimer = this.clock.setTimeout(() => this.flush(), this.options.batchMs ?? BATCH_MS)
  }

  private flush(): void {
    this.batchTimer = null
    if (this.disabled || this.disposed || this.queue.size === 0) return
    const batch = [...this.queue].slice(0, MAX_BATCH)
    for (const [key] of batch) this.queue.delete(key)
    // Le surplus d'une grosse rafale part au lot suivant : rien n'est perdu.
    if (this.queue.size > 0) this.scheduleBatch()

    const helper = this.helper ?? this.startHelper()
    if (!helper?.stdin) return
    try {
      helper.stdin.write(`${batch.map(([, change]) => helperLine(change)).join('\n')}\n\n`)
    } catch (error) {
      this.log(`envoi impossible : ${error instanceof Error ? error.message : String(error)}`)
      this.stopHelper()
      return
    }
    this.awaitingAcks += 1
    if (this.ackTimer === null) this.armAck()
  }

  private startHelper(): HelperProcess | null {
    let helper: HelperProcess
    try {
      helper = this.options.spawn()
    } catch (error) {
      this.onStartFailure(error instanceof Error ? error.message : String(error))
      return null
    }
    this.helper = helper
    this.ready = false
    this.stdoutBuffer = ''
    this.awaitingAcks = 0

    helper.stdout?.on('data', (chunk) => this.onOutput(helper, chunk.toString()))
    helper.stdin?.on?.('error', () => {
      if (this.helper !== helper) return
      const started = this.ready
      this.stopHelper()
      if (!started) this.onStartFailure('entrée fermée')
    })
    // Écoute permanente : une erreur de processus sans écouteur arrêterait l'application.
    helper.on('error', (error) => {
      if (this.helper !== helper) return
      this.helper = null
      this.clearAck()
      this.clearIdle()
      this.onStartFailure(error.message)
    })
    helper.once('exit', (code) => {
      if (this.helper !== helper) return
      this.helper = null
      this.clearAck()
      this.clearIdle()
      if (!this.ready) this.onStartFailure(`code ${code}`)
    })
    return helper
  }

  private onOutput(helper: HelperProcess, text: string): void {
    if (this.helper !== helper) return
    this.stdoutBuffer += text
    let index: number
    while ((index = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      if (line === 'ready') {
        this.ready = true
        this.startFailures = 0
        // Démarré : le lot en attente a maintenant le délai ordinaire pour répondre.
        if (this.ackTimer !== null) {
          this.clearAck()
          this.armAck()
        }
      } else if (line === 'ok') {
        this.awaitingAcks = Math.max(0, this.awaitingAcks - 1)
        this.clearAck()
        if (this.awaitingAcks > 0) this.armAck()
        else this.armIdle()
      }
    }
  }

  private armAck(): void {
    const starting = !this.ready
    this.ackTimer = this.clock.setTimeout(
      () => {
        this.ackTimer = null
        this.stopHelper()
        // Jamais prêt (PowerShell bloqué au chargement, poste saturé) : compté comme un échec
        // de démarrage, pour finir par abandonner au lieu de relancer sans fin.
        if (starting) this.onStartFailure('démarrage trop long')
        // Assistant bloqué (Explorateur figé ?) : arrêté, relancé au prochain lot.
        else this.log('assistant de notification sans réponse : arrêté')
      },
      starting
        ? (this.options.startTimeoutMs ?? START_TIMEOUT_MS)
        : (this.options.ackTimeoutMs ?? ACK_TIMEOUT_MS)
    )
  }

  private clearAck(): void {
    if (this.ackTimer !== null) this.clock.clearTimeout(this.ackTimer)
    this.ackTimer = null
  }

  /** Plus rien à envoyer : l'assistant s'arrêtera s'il reste inoccupé. */
  private armIdle(): void {
    this.clearIdle()
    if (this.queue.size > 0 || this.batchTimer !== null) return
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = null
      if (this.awaitingAcks === 0 && this.queue.size === 0) this.stopHelper()
    }, this.options.idleMs ?? IDLE_MS)
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) this.clock.clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private onStartFailure(reason: string): void {
    this.startFailures += 1
    this.log(`assistant de notification indisponible (${reason})`)
    if (this.startFailures >= (this.options.maxStartFailures ?? MAX_START_FAILURES)) {
      // Stratégie d'exécution imposée, PowerShell absent… : l'Explorateur se mettra à jour seul.
      this.disabled = true
      this.queue.clear()
    }
  }

  private stopHelper(): void {
    const helper = this.helper
    this.helper = null
    this.clearAck()
    this.clearIdle()
    this.awaitingAcks = 0
    if (!helper) return
    try {
      helper.stdin?.end()
    } catch {
      // déjà fermé
    }
    try {
      helper.kill()
    } catch {
      // déjà arrêté
    }
  }

  private log(message: string): void {
    this.options.log?.(`[Explorateur] ${message}`)
  }
}
