import tls from 'tls'
import { session } from 'electron'
import WebSocket from 'ws'
import { parseProxyList, tunnelAgent } from './proxy'
import type { RealtimeSocket, SocketHandlers } from './realtime'

/*
 * Transport de la connexion temps réel : le paquet `ws` dans le processus principal.
 *
 * Pourquoi pas le WebSocket de Chromium (dans une fenêtre) ? Il gère nativement proxys et
 * certificats, mais il faudrait garder une fenêtre cachée en vie en permanence (60 à
 * 90 Mo, ralentie par Chromium quand elle est cachée) alors que l'application démarre le
 * plus souvent sans fenêtre. Ici :
 *  - proxy : celui que Chromium résout pour cette adresse (réglages système, PAC, WPAD),
 *    via session.resolveProxy(), traversé par un tunnel CONNECT (proxy.ts) ;
 *  - certificats : ceux de Node et ceux du magasin du système (autorités d'entreprise,
 *    proxys d'inspection TLS) ;
 *  - proxy SOCKS ou authentifié, WebSockets filtrés : la connexion échoue et le poste
 *    reste en interrogation de secours (qui passe, elle, par le réseau de Chromium).
 */

let certificates: string[] | null = null

/** Autorités de confiance : celles livrées avec Node plus celles du système (lues une fois). */
export function trustedCertificates(): string[] | undefined {
  if (certificates) return certificates
  try {
    const all = new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])
    certificates = [...all]
    return certificates
  } catch {
    // Magasin du système illisible : les autorités livrées avec Node suffisent en général.
    return undefined
  }
}

/** Le proxy que Chromium utiliserait pour cette adresse (même hôte en https/http). */
async function proxiesFor(url: URL): Promise<ReturnType<typeof parseProxyList>> {
  const probe = `${url.protocol === 'wss:' ? 'https' : 'http'}://${url.host}/`
  try {
    const entries = parseProxyList(await session.defaultSession.resolveProxy(probe))
    return entries.length > 0 ? entries : [{ kind: 'direct' }]
  } catch {
    return [{ kind: 'direct' }]
  }
}

export interface SocketOptions {
  userAgent: string
  /** Origine annoncée (celle de l'application web). */
  origin: string
}

export async function openRealtimeSocket(
  address: string,
  handlers: SocketHandlers,
  options: SocketOptions
): Promise<RealtimeSocket> {
  const url = new URL(address)
  const secure = url.protocol === 'wss:'
  const ca = secure ? trustedCertificates() : undefined
  const proxies = await proxiesFor(url)
  const direct = proxies.length === 1 && proxies[0].kind === 'direct'

  const socket = new WebSocket(address, {
    agent: direct ? undefined : tunnelAgent(proxies, { secure, ca, userAgent: options.userAgent }),
    ca,
    handshakeTimeout: 20_000,
    perMessageDeflate: false,
    maxPayload: 256 * 1024,
    followRedirects: false,
    origin: options.origin,
    headers: { 'User-Agent': options.userAgent }
  })

  socket.on('message', (data, isBinary) => {
    if (!isBinary) handlers.onMessage(data.toString())
  })
  socket.on('close', (code) => handlers.onClose(code))
  socket.on('error', (error) => handlers.onError(error))

  return {
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data)
    },
    close: (code = 1000, reason) => socket.close(code, reason),
    terminate: () => socket.terminate()
  }
}
