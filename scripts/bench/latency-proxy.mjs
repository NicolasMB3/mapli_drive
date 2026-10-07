#!/usr/bin/env node
/*
 * Relais HTTP local qui retarde chaque requête de N ms avant de la transmettre : le
 * serveur WebDAV du banc (sur la même machine, sans latence) se comporte alors comme un
 * serveur distant. Le corps des requêtes et des réponses passe en flux, sans copie.
 *
 * Usage : node scripts/bench/latency-proxy.mjs --listen 8091 --target 8090 --delay 30
 * (ports de 127.0.0.1). S'arrête avec son processus parent (le banc l'arrête à la fin).
 */
import http from 'node:http'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    listen: { type: 'string' },
    target: { type: 'string' },
    delay: { type: 'string', default: '30' }
  }
})
const listen = Number(values.listen)
const target = Number(values.target)
const delay = Number(values.delay)
if (!listen || !target || !(delay >= 0)) throw new Error('--listen, --target et --delay attendus')

// Connexions gardées vers le serveur : seule la latence ajoutée compte, pas les poignées de main.
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 })

const server = http.createServer((req, res) => {
  // Le corps attend dans le flux (personne ne le lit encore) pendant le délai.
  setTimeout(() => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: target,
        method: req.method,
        path: req.url,
        headers: req.headers,
        agent
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(res)
      }
    )
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502)
      res.end(String(error))
    })
    req.pipe(upstream)
  }, delay)
})

server.keepAliveTimeout = 60_000
server.listen(listen, '127.0.0.1', () => {
  console.log(`relais 127.0.0.1:${listen} → 127.0.0.1:${target}, +${delay} ms par requête`)
})
