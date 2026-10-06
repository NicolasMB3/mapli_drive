import http from 'http'
import https from 'https'
import net from 'net'
import tls from 'tls'
import type { Duplex } from 'stream'

/*
 * Passage par le proxy du poste pour la connexion temps réel (WebSocket). Le proxy est
 * celui que Chromium résout pour l'API (réglages système, PAC, WPAD : voir
 * realtime-socket.ts) ; ici, sans Electron pour être testé : lecture de sa réponse et
 * tunnel HTTP CONNECT. Les proxys SOCKS ou à authentification ne sont pas gérés : le
 * poste reste alors en interrogation de secours, qui passe par le réseau de Chromium.
 */

export type ProxyServer = { kind: 'http' | 'https'; host: string; port: number }
export type ProxyEntry = { kind: 'direct' } | ProxyServer

/**
 * Réponse de session.resolveProxy() (« PROXY hôte:port; DIRECT ») → entrées utilisables,
 * dans l'ordre. SOCKS, QUIC et le reste sont ignorés.
 */
export function parseProxyList(value: string): ProxyEntry[] {
  const entries: ProxyEntry[] = []
  for (const part of value.split(';')) {
    const [type, address] = part.trim().split(/\s+/, 2)
    const kind = type?.toUpperCase()
    if (kind === 'DIRECT') {
      entries.push({ kind: 'direct' })
      continue
    }
    if ((kind !== 'PROXY' && kind !== 'HTTPS') || !address) continue
    const match = /^(\[[0-9a-fA-F:.]+\]|[^:\s[\]]+):(\d{1,5})$/.exec(address)
    if (!match) continue
    const port = Number(match[2])
    if (port < 1 || port > 65_535) continue
    entries.push({
      kind: kind === 'HTTPS' ? 'https' : 'http',
      host: match[1].replace(/^\[|\]$/g, ''),
      port
    })
  }
  return entries
}

export interface TunnelOptions {
  /** TLS jusqu'au serveur (wss://) au bout du tunnel. */
  secure: boolean
  /** Autorités de certification acceptées (celles du système comprises). */
  ca?: string[]
  timeoutMs?: number
  userAgent?: string
}

const DEFAULT_TIMEOUT_MS = 15_000

function secureSocket(options: tls.ConnectionOptions & { host: string }): tls.TLSSocket {
  return tls.connect({
    ...options,
    servername: net.isIP(options.host) ? undefined : options.host,
    ALPNProtocols: ['http/1.1']
  })
}

/** Attend qu'une connexion soit prête (ou en erreur), dans un délai donné. */
function ready<T extends net.Socket>(socket: T, event: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => socket.destroy(new Error('connexion : délai dépassé')),
      timeoutMs
    )
    const onError = (error: Error): void => {
      clearTimeout(timer)
      reject(error)
    }
    socket.once('error', onError)
    socket.once(event, () => {
      clearTimeout(timer)
      socket.off('error', onError)
      resolve(socket)
    })
  })
}

/** Ouvre un tunnel CONNECT vers hôte:port à travers un proxy, puis TLS jusqu'au serveur. */
export function connectThroughProxy(
  proxy: ProxyServer,
  host: string,
  port: number,
  options: TunnelOptions
): Promise<Duplex> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const authority = `${host.includes(':') ? `[${host}]` : host}:${port}`
    const request = (proxy.kind === 'https' ? https : http).request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      agent: false,
      timeout: timeoutMs,
      headers: {
        Host: authority,
        ...(options.userAgent ? { 'User-Agent': options.userAgent } : {})
      },
      ...(proxy.kind === 'https' ? { servername: proxy.host, ca: options.ca } : {})
    })
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`proxy : CONNECT refusé (${response.statusCode})`))
        return
      }
      socket.setTimeout(0)
      if (!options.secure) {
        resolve(socket)
        return
      }
      ready(secureSocket({ socket, host, ca: options.ca }), 'secureConnect', timeoutMs).then(
        resolve,
        reject
      )
    })
    request.once('timeout', () => request.destroy(new Error('proxy : délai dépassé')))
    request.once('error', reject)
    request.end()
  })
}

type Opener = (host: string, port: number) => Promise<Duplex>
type Created = (error: Error | null, socket: Duplex) => void

/** Connexion créée de façon asynchrone, remise à l'agent par son rappel (API des agents Node). */
function createAsync(
  open: Opener,
  secure: boolean,
  request: http.ClientRequestArgs,
  done?: Created
) {
  const host = request.hostname || request.host || 'localhost'
  const port = Number(request.port) || (secure ? 443 : 80)
  open(host, port).then(
    (socket) => done?.(null, socket),
    // En cas d'échec, l'agent de Node n'attend que l'erreur.
    (error: Error) => (done as ((error: Error) => void) | undefined)?.(error)
  )
  return undefined
}

class HttpsTunnelAgent extends https.Agent {
  constructor(private readonly open: Opener) {
    super({ keepAlive: false })
  }

  createConnection(request: https.RequestOptions, done?: Created): undefined {
    return createAsync(this.open, true, request, done)
  }
}

class HttpTunnelAgent extends http.Agent {
  constructor(private readonly open: Opener) {
    super({ keepAlive: false })
  }

  createConnection(request: http.ClientRequestArgs, done?: Created): undefined {
    return createAsync(this.open, false, request, done)
  }
}

/**
 * Agent pour la poignée de main WebSocket : essaie les proxys dans l'ordre (puis la
 * connexion directe si la liste la prévoit), comme Chromium.
 */
export function tunnelAgent(proxies: ProxyEntry[], options: TunnelOptions): http.Agent {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const direct = (host: string, port: number): Promise<Duplex> =>
    options.secure
      ? ready(secureSocket({ host, port, ca: options.ca }), 'secureConnect', timeoutMs)
      : ready(net.connect({ host, port }), 'connect', timeoutMs)

  const open: Opener = async (host, port) => {
    let last: Error = new Error('proxy : aucune route utilisable')
    for (const proxy of proxies) {
      try {
        return proxy.kind === 'direct'
          ? await direct(host, port)
          : await connectThroughProxy(proxy, host, port, options)
      } catch (error) {
        last = error instanceof Error ? error : new Error(String(error))
      }
    }
    throw last
  }

  return options.secure ? new HttpsTunnelAgent(open) : new HttpTunnelAgent(open)
}
