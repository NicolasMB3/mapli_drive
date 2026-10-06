import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { helperArgs, helperLine, ShellNotifier, type HelperProcess } from '../explorer-notify'

const ROOT = 'M:' + String.fromCharCode(92) // « M:\ »

class FakeHelper extends EventEmitter implements HelperProcess {
  readonly written: string[] = []
  readonly output = new EventEmitter()
  ended = false
  killed = false
  readonly stdin = {
    write: (data: string) => {
      this.written.push(data)
      return true
    },
    end: () => {
      this.ended = true
    }
  }
  readonly stdout = {
    on: (event: 'data', listener: (chunk: Buffer | string) => void) =>
      this.output.on(event, listener)
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  say(line: string): void {
    this.output.emit('data', Buffer.from(`${line}\r\n`))
  }

  /** Lignes du protocole reçues, lots séparés par une ligne vide. */
  batches(): string[][] {
    return this.written
      .join('')
      .split('\n\n')
      .filter(Boolean)
      .map((batch) => batch.split('\n'))
  }
}

function setup() {
  const helpers: FakeHelper[] = []
  const notifier = new ShellNotifier({
    spawn: () => {
      const helper = new FakeHelper()
      helpers.push(helper)
      return helper
    }
  })
  return { notifier, helpers }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('assistant de notification de l’Explorateur', () => {
  it('encode chaque notification en une ligne sûre (événement, chemin en base64 UTF-8)', () => {
    const line = helperLine({ event: 'updatedir', path: `${ROOT}Comptabilité` })
    const [event, path] = line.split('\t')
    expect(event).toBe('4096')
    expect(Buffer.from(path, 'base64').toString('utf8')).toBe(`${ROOT}Comptabilité`)
    expect(line).not.toMatch(/[\r\n]/)
    expect(helperLine({ event: 'rmdir', path: ROOT }).startsWith('16\t')).toBe(true)
    expect(helperLine({ event: 'mkdir', path: ROOT }).startsWith('8\t')).toBe(true)
  })

  it('lance un seul assistant et groupe les notifications par lot, sans doublon', async () => {
    const { notifier, helpers } = setup()
    notifier.notify([{ event: 'updatedir', path: `${ROOT}Clients` }])
    notifier.notify([
      { event: 'updatedir', path: `${ROOT}Clients` },
      { event: 'rmdir', path: `${ROOT}Archives` }
    ])
    expect(helpers).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(250)

    expect(helpers).toHaveLength(1)
    expect(helpers[0].batches()).toEqual([
      [
        helperLine({ event: 'updatedir', path: `${ROOT}Clients` }),
        helperLine({ event: 'rmdir', path: `${ROOT}Archives` })
      ]
    ])

    helpers[0].say('ready')
    helpers[0].say('ok')
    notifier.notify([{ event: 'mkdir', path: `${ROOT}Devis` }])
    await vi.advanceTimersByTimeAsync(250)
    expect(helpers).toHaveLength(1)
    expect(helpers[0].batches()).toHaveLength(2)
  })

  it('relance l’assistant s’il s’est arrêté, au lot suivant', async () => {
    const { notifier, helpers } = setup()
    notifier.notify([{ event: 'updatedir', path: ROOT }])
    await vi.advanceTimersByTimeAsync(250)
    helpers[0].say('ready')
    helpers[0].emit('exit', 0)

    notifier.notify([{ event: 'updatedir', path: ROOT }])
    await vi.advanceTimersByTimeAsync(250)
    expect(helpers).toHaveLength(2)
  })

  it('arrête un assistant qui ne répond plus (15 s sans « ok »)', async () => {
    const { notifier, helpers } = setup()
    notifier.notify([{ event: 'updatedir', path: ROOT }])
    await vi.advanceTimersByTimeAsync(250)
    helpers[0].say('ready')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(helpers[0].killed).toBe(true)
    expect(notifier.running).toBe(false)
  })

  it('abandonne pour la session après trois échecs de démarrage (stratégie imposée…)', async () => {
    const { notifier, helpers } = setup()
    for (let i = 0; i < 3; i++) {
      notifier.notify([{ event: 'updatedir', path: ROOT }])
      await vi.advanceTimersByTimeAsync(250)
      helpers[i].emit('exit', 1)
    }
    notifier.notify([{ event: 'updatedir', path: ROOT }])
    await vi.advanceTimersByTimeAsync(250)
    expect(helpers).toHaveLength(3)
  })

  it('s’arrête avec l’application', async () => {
    const { notifier, helpers } = setup()
    notifier.notify([{ event: 'updatedir', path: ROOT }])
    await vi.advanceTimersByTimeAsync(250)
    notifier.dispose()
    expect(helpers[0].ended).toBe(true)
    expect(helpers[0].killed).toBe(true)
    notifier.notify([{ event: 'updatedir', path: ROOT }])
    await vi.advanceTimersByTimeAsync(250)
    expect(helpers).toHaveLength(1)
  })
})

const SCRIPT = join(__dirname, '../../../resources/explorer-notify.ps1')

describe.runIf(process.platform === 'win32')('assistant réel (Windows)', () => {
  it('démarre sans rien compiler, notifie et accuse réception de chaque lot', async () => {
    vi.useRealTimers()
    const powershell = join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    const child = spawn(powershell, helperArgs(SCRIPT), {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const lines: string[] = []
    const acked = new Promise<void>((resolve, reject) => {
      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        let index: number
        while ((index = buffer.indexOf('\n')) >= 0) {
          lines.push(buffer.slice(0, index).trim())
          buffer = buffer.slice(index + 1)
          if (lines.includes('ok')) resolve()
        }
      })
      child.once('exit', (code) => reject(new Error(`assistant arrêté (code ${code})`)))
      setTimeout(() => reject(new Error('pas de réponse')), 15_000)
    })
    // Dossier temporaire au nom accentué : le chemin passe en base64, sans souci d'encodage.
    const folder = mkdtempSync(join(tmpdir(), 'Comptabilité-'))
    try {
      child.stdin.write(`${helperLine({ event: 'updatedir', path: folder })}\nligne invalide\n\n`)
      await acked
      expect(lines).toEqual(['ready', 'ok'])
    } finally {
      child.stdin.end()
      rmSync(folder, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('script de l’assistant', () => {
  const script = readFileSync(SCRIPT, 'utf8')

  it('ne compile rien et n’exécute rien de reçu', () => {
    const code = script
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/Add-Type|Invoke-Expression|iex\b|EncodedCommand|csc\.exe/i)
    expect(code).toContain('DefinePInvokeMethod')
  })

  it('reste en ASCII (PowerShell 5.1 lit les scripts sans BOM dans la page de code du système)', () => {
    expect([...script].every((c) => c.charCodeAt(0) < 128)).toBe(true)
  })
})
