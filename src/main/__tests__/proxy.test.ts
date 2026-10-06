import http from 'http'
import net from 'net'
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { parseProxyList, tunnelAgent } from '../proxy'

describe('réponse de session.resolveProxy()', () => {
  it('garde les proxys HTTP(S) et la connexion directe, dans l’ordre', () => {
    expect(parseProxyList('DIRECT')).toEqual([{ kind: 'direct' }])
    expect(parseProxyList('PROXY proxy.corp:8080; HTTPS secure.corp:443; DIRECT')).toEqual([
      { kind: 'http', host: 'proxy.corp', port: 8080 },
      { kind: 'https', host: 'secure.corp', port: 443 },
      { kind: 'direct' }
    ])
    expect(parseProxyList('PROXY [::1]:3128')).toEqual([{ kind: 'http', host: '::1', port: 3128 }])
  })

  it('écarte SOCKS et ce qui est illisible', () => {
    expect(parseProxyList('SOCKS5 socks.corp:1080; SOCKS socks.corp:1080')).toEqual([])
    expect(parseProxyList('PROXY sans-port; PROXY hote:99999; QUIC q:443')).toEqual([])
  })
})

describe('tunnel CONNECT jusqu’au serveur temps réel', () => {
  const closers: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (closers.length) await closers.pop()?.()
  })

  function listen(server: http.Server | net.Server): Promise<number> {
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
      closers.push(() => new Promise((done) => server.close(() => done())))
    })
  }

  async function echoServer(): Promise<number> {
    const server = http.createServer()
    const wss = new WebSocketServer({ server })
    wss.on('connection', (socket) => socket.on('message', (data) => socket.send(`écho ${data}`)))
    closers.push(
      () =>
        new Promise((done) => {
          for (const client of wss.clients) client.terminate()
          wss.close(() => done())
        })
    )
    return listen(server)
  }

  /** Proxy HTTP minimal : accepte CONNECT et relaie les octets ; compte les tunnels ouverts. */
  async function connectProxy(): Promise<{ port: number; tunnels: string[] }> {
    const tunnels: string[] = []
    const proxy = http.createServer((_req, res) => res.writeHead(405).end())
    proxy.on('connect', (req, client, head) => {
      tunnels.push(req.url ?? '')
      const [host, port] = (req.url ?? '').split(':')
      const upstream = net.connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
    })
    return { port: await listen(proxy), tunnels }
  }

  function exchange(url: string, agent: http.Agent): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { agent, handshakeTimeout: 5_000 })
      socket.once('open', () => socket.send('ping'))
      socket.once('message', (data) => {
        socket.close()
        resolve(data.toString())
      })
      socket.once('error', reject)
    })
  }

  it('passe par le proxy du poste', async () => {
    const serverPort = await echoServer()
    const proxy = await connectProxy()
    const agent = tunnelAgent([{ kind: 'http', host: '127.0.0.1', port: proxy.port }], {
      secure: false
    })
    expect(await exchange(`ws://127.0.0.1:${serverPort}/app/key`, agent)).toBe('écho ping')
    expect(proxy.tunnels).toEqual([`127.0.0.1:${serverPort}`])
  })

  it('proxy injoignable : entrée suivante (connexion directe), comme Chromium', async () => {
    const serverPort = await echoServer()
    const closed = net.createServer()
    const deadPort = await listen(closed)
    await new Promise<void>((done) => closed.close(() => done()))
    closers.pop()
    const agent = tunnelAgent(
      [{ kind: 'http', host: '127.0.0.1', port: deadPort }, { kind: 'direct' }],
      { secure: false }
    )
    expect(await exchange(`ws://127.0.0.1:${serverPort}/app/key`, agent)).toBe('écho ping')
  })

  it('proxy qui refuse le tunnel : échec (le poste reste en interrogation de secours)', async () => {
    const serverPort = await echoServer()
    const proxy = http.createServer()
    proxy.on('connect', (_req, client) =>
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
    )
    const port = await listen(proxy)
    const agent = tunnelAgent([{ kind: 'http', host: '127.0.0.1', port }], { secure: false })
    await expect(exchange(`ws://127.0.0.1:${serverPort}/app/key`, agent)).rejects.toThrow(/407/)
  })
})
