#!/usr/bin/env node
/*
 * Banc du lecteur Mapli Drive sous macOS : `rclone nfsmount` avec les réglages de
 * l'application (src/main/rclone-args.ts, importé tel quel : Node 22.18 et suivants lisent
 * le TypeScript), contre un serveur WebDAV local (`rclone serve webdav`) placé derrière un
 * relais que le banc commande — latence ajoutée, serveur muet, serveur arrêté. Mesure et
 * vérifie :
 *  - montage (délai jusqu'au volume utilisable), démontage ;
 *  - opérations de fichiers (scripts/bench-macos/bench-files.mjs) ;
 *  - changement fait ailleurs : invisible tant que le dossier est en cache, visible après
 *    vfs/forget (délai) — c'est ce que fait l'application sur annonce du serveur ;
 *  - noms à accents décomposés (NFD, écrits par le Finder) : composés (NFC) sur le serveur ;
 *  - attributs étendus (fichier téléchargé) : la copie passe, « ._ » envoyé ;
 *  - mémoire et processeur de rclone au repos ;
 *  - pannes (sauf --sans-pannes) : serveur arrêté, serveur muet, rclone tué net — durée
 *    de blocage d'un `ls`, volume démonté d'office (deadtimeout) ou non, reprise.
 * Les pannes font afficher par macOS « Connexions au serveur interrompues » : à lancer en
 * CI, pas sur un poste où quelqu'un travaille. Le relais tourne dans ce processus : tout
 * accès au volume y est donc asynchrone (un appel bloquant figerait le relais, et rclone
 * avec lui).
 *
 * Usage : node scripts/bench/macos-bench.mjs --rclone <binaire> --out <dossier>
 *           [--latence 0] [--sans-pannes] [--options "--buffer-size 4M"]
 * Sorties : <dossier>/bench-macos-lecteur.json, journaux de rclone ; résumé Markdown ajouté
 * à $GITHUB_STEP_SUMMARY s'il existe. Code de sortie 1 si une vérification échoue.
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { rcloneMountEnv, rcloneNfsMountArgs } from '../../src/main/rclone-args.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { values } = parseArgs({
  options: {
    rclone: { type: 'string' },
    out: { type: 'string' },
    latence: { type: 'string', default: '0' },
    'sans-pannes': { type: 'boolean', default: false },
    options: { type: 'string', default: '' }
  }
})
if (!values.rclone || !values.out) {
  console.error('Usage : macos-bench.mjs --rclone <binaire> --out <dossier> [--latence ms]')
  process.exit(2)
}
const RCLONE = resolve(values.rclone)
const OUT = resolve(values.out)
const LATENCY = Number(values.latence) || 0
const EXTRA = values.options.split(/\s+/).filter(Boolean)
mkdirSync(OUT, { recursive: true })

// Chemin réel (/var → /private/var) : celui que la table des montages affiche.
const work = realpathSync(mkdtempSync(join(tmpdir(), 'mapli-bench-mac-')))
const srv = join(work, 'serveur')
const mountPoint = join(work, 'Mapli')
const cacheDir = join(work, 'cache')
for (const dir of [srv, mountPoint, cacheDir]) mkdirSync(dir, { recursive: true })
const configFile = join(work, 'rclone.conf')
writeFileSync(configFile, '')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const round = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : null)
const now = () => performance.now()
const children = []

const result = {
  date: new Date().toISOString(),
  macos: execFileSync('sw_vers', ['-productVersion']).toString().trim(),
  darwin: release(),
  rclone: execFileSync(RCLONE, ['version']).toString().split('\n')[0],
  latenceMs: LATENCY,
  optionsAjoutees: EXTRA,
  montage: {},
  fichiers: null,
  visibilite: {},
  noms: {},
  attributs: {},
  ressources: {},
  pannes: {},
  verifications: [],
  erreurs: []
}

function check(name, ok, detail = '') {
  result.verifications.push({ nom: name, ok, detail })
  console.log(`[${ok ? 'OK' : 'ÉCHEC'}] ${name} ${detail}`)
}

function freePort() {
  return new Promise((done, fail) => {
    const server = net.createServer()
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

// ── Serveur WebDAV local, derrière un relais commandé par le banc ───────────

const serverPort = await freePort()
const server = spawn(
  RCLONE,
  [
    'serve',
    'webdav',
    srv,
    '--addr',
    `127.0.0.1:${serverPort}`,
    '--log-file',
    join(OUT, 'rclone-serveur.log'),
    '--log-level',
    'NOTICE'
  ],
  { stdio: 'ignore' }
)
children.push(server)

/** Relais : « pass » (avec la latence demandée), « mute » (répond jamais), arrêté (refus). */
const relay = {
  mode: 'pass',
  port: await freePort(),
  server: null,
  sockets: new Set(),
  agent: new http.Agent({ keepAlive: true, maxSockets: 64 }),
  start() {
    this.server = http.createServer((req, res) => {
      if (this.mode === 'mute') return // la requête reste sans réponse
      setTimeout(() => {
        const upstream = http.request(
          {
            host: '127.0.0.1',
            port: serverPort,
            method: req.method,
            path: req.url,
            headers: req.headers,
            agent: this.agent
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
      }, LATENCY)
    })
    this.server.keepAliveTimeout = 60_000
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    return new Promise((done) => this.server.listen(this.port, '127.0.0.1', done))
  },
  stop() {
    for (const socket of this.sockets) socket.destroy()
    return new Promise((done) => this.server.close(() => done()))
  }
}
await relay.start()
for (let i = 0; i < 100; i++) {
  try {
    execFileSync('curl', ['-s', '-o', '/dev/null', `http://127.0.0.1:${serverPort}/`])
    break
  } catch {
    await sleep(100)
  }
}

// ── Montage, avec les réglages de l'application ─────────────────────────────

const rc = {
  port: await freePort(),
  user: randomBytes(6).toString('hex'),
  pass: randomBytes(12).toString('hex')
}
let rclone = null

function mounted() {
  try {
    return execFileSync('/sbin/mount').toString().includes(` on ${mountPoint} (nfs`)
  } catch {
    return false
  }
}

async function rcCall(command, params = {}, timeoutMs = 5000) {
  const response = await fetch(`http://127.0.0.1:${rc.port}/${command}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${rc.user}:${rc.pass}`).toString('base64')}`
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) throw new Error(`${command} : HTTP ${response.status}`)
  return response.json()
}

/** Commande lancée à part, arrêtée au bout du délai : durée, code, sortie d'erreur. */
function timed(command, args, timeoutMs) {
  return new Promise((done) => {
    const started = now()
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let timedOut = false
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      done({
        ms: round(now() - started),
        code,
        signal,
        timedOut,
        stderr: stderr.trim().slice(0, 300)
      })
    })
  })
}

async function mount(tag) {
  const options = {
    davUrl: `http://127.0.0.1:${relay.port}/`,
    token: 'jeton-de-banc',
    mountPoint,
    volumeName: 'Mapli',
    rcPort: rc.port,
    rcUser: rc.user,
    rcPass: rc.pass,
    cacheDir,
    cacheSizeGb: 10,
    logFile: join(OUT, `rclone-${tag}.log`),
    configFile,
    userAgent: 'MapliDrive/banc'
  }
  const args = [...rcloneNfsMountArgs(options), ...EXTRA]
  const started = now()
  rclone = spawn(RCLONE, args, { env: rcloneMountEnv(options), stdio: 'ignore' })
  children.push(rclone)
  while (now() - started < 30_000 && rclone.exitCode === null) {
    if (mounted()) break
    await sleep(50)
  }
  const mountedMs = mounted() ? round(now() - started) : null
  const listed = await timed('ls', [mountPoint], 30_000)
  return { mountedMs, readyMs: listed.code === 0 ? round(now() - started) : null, args }
}

/** Requête faite « ailleurs » (comme le web ou un autre poste) : droit au serveur, sans le relais. */
async function dav(method, path, body) {
  const url = `http://127.0.0.1:${serverPort}/${path.split('/').map(encodeURIComponent).join('/')}`
  const response = await fetch(url, { method, body })
  if (response.status >= 300) throw new Error(`${method} ${path} : HTTP ${response.status}`)
}

async function settled(limitMs = 120_000) {
  const started = now()
  await sleep(200)
  while (now() - started < limitMs) {
    const stats = await rcCall('vfs/stats')
    const pending =
      (stats.diskCache?.uploadsInProgress ?? 0) + (stats.diskCache?.uploadsQueued ?? 0)
    if (pending === 0) return round(now() - started)
    await sleep(200)
  }
  return null
}

async function until(condition, limitMs, intervalMs = 100) {
  const started = now()
  while (now() - started < limitMs) {
    if (await condition()) return round(now() - started)
    await sleep(intervalMs)
  }
  return null
}

const listing = (dir) => readdir(dir).catch(() => null)

function sample(pid) {
  try {
    const [rss, cpu] = execFileSync('ps', ['-o', 'rss=,%cpu=', '-p', String(pid)])
      .toString()
      .trim()
      .split(/\s+/)
      .map(Number)
    return { rssMo: round(rss / 1024), cpu }
  } catch {
    return null
  }
}

async function unmount() {
  const started = now()
  try {
    await rcCall('core/quit')
  } catch {
    // déjà arrêté
  }
  const gone = await until(() => !mounted(), 15_000)
  if (!gone && mounted()) execFileSync('/sbin/umount', ['-f', mountPoint])
  return round(now() - started)
}

// ── Banc ────────────────────────────────────────────────────────────────────

let exitCode = 0
try {
  // Montage
  const first = await mount('montage')
  result.montage = {
    premierMs: first.mountedMs,
    utilisableMs: first.readyMs,
    arguments: first.args
  }
  check('montage', first.readyMs !== null, `${first.readyMs} ms`)
  if (first.readyMs === null) throw new Error('montage impossible')
  await sleep(2000)
  const idle = []
  for (let i = 0; i < 10; i++) {
    idle.push(sample(rclone.pid))
    await sleep(1000)
  }
  result.ressources.repos = {
    rssMo: idle.at(-1)?.rssMo ?? null,
    cpuMoyen: round(idle.reduce((sum, s) => sum + (s?.cpu ?? 0), 0) / idle.length)
  }

  // Opérations de fichiers
  const filesOut = join(OUT, 'fichiers-macos.json')
  const files = await new Promise((done) => {
    const child = spawn(
      process.execPath,
      [
        join(ROOT, 'scripts/bench-macos/bench-files.mjs'),
        mountPoint,
        '--rc',
        `http://${rc.user}:${rc.pass}@127.0.0.1:${rc.port}`,
        '--label',
        'macOS (CI)',
        '--out',
        filesOut
      ],
      { stdio: 'inherit' }
    )
    child.on('exit', (code) => done(code))
  })
  check('opérations de fichiers', files === 0 && existsSync(filesOut))
  if (existsSync(filesOut)) result.fichiers = JSON.parse(readFileSync(filesOut, 'utf8')).results
  result.ressources.apresFichiers = sample(rclone.pid)

  // Changement fait ailleurs
  const dir = 'Visibilité'
  await mkdir(join(mountPoint, dir))
  await settled()
  const onServer = await until(() => existsSync(join(srv, dir)), 10_000)
  check('dossier créé sur le serveur', onServer !== null, `${onServer} ms`)
  await readdir(join(mountPoint, dir))
  await dav('PUT', `${dir}/distant.txt`, 'ajouté ailleurs')
  await sleep(8000)
  const hidden = !((await listing(join(mountPoint, dir))) ?? []).includes('distant.txt')
  result.visibilite.invisibleSansOubli8s = hidden
  await rcCall('vfs/forget', { dir })
  const shown = await until(
    async () => ((await listing(join(mountPoint, dir))) ?? []).includes('distant.txt'),
    60_000
  )
  result.visibilite.ajoutVisibleApresOubliMs = shown
  check(
    'ajout fait ailleurs visible après vfs/forget',
    shown !== null && shown < 15_000,
    `${shown} ms`
  )
  await dav('DELETE', `${dir}/distant.txt`)
  await rcCall('vfs/forget', { dir })
  const removed = await until(
    async () =>
      !((await listing(join(mountPoint, dir))) ?? ['distant.txt']).includes('distant.txt'),
    60_000
  )
  result.visibilite.suppressionVisibleApresOubliMs = removed
  check('suppression faite ailleurs visible après vfs/forget', removed !== null, `${removed} ms`)

  // Noms décomposés (NFD) → composés (NFC) sur le serveur
  const nfd = 'Réunion équipe.txt'.normalize('NFD')
  await writeFile(join(mountPoint, dir, nfd), 'compte rendu')
  await settled()
  const names = readdirSync(join(srv, dir))
  const nfc = names.includes('Réunion équipe.txt'.normalize('NFC'))
  result.noms = { nfcSurLeServeur: nfc, nomsServeur: names }
  check('nom à accents décomposés reçu composé (NFC)', nfc)

  // Attributs étendus : un fichier « téléchargé » se copie
  const source = join(work, 'telecharge.pdf')
  writeFileSync(source, randomBytes(50_000))
  execFileSync('xattr', ['-w', 'com.apple.quarantine', '0083;66f0c000;Safari;', source])
  const copied = await timed('cp', [source, join(mountPoint, dir)], 30_000)
  await settled()
  result.attributs = {
    copie: copied,
    appleDoubleSurLeServeur: readdirSync(join(srv, dir)).filter((n) => n.startsWith('._'))
  }
  check('copie d’un fichier téléchargé (attributs étendus)', copied.code === 0, copied.stderr)

  // Démontage ordinaire et remontage (cache conservé)
  result.montage.demontageMs = await unmount()
  const second = await mount('remontage')
  result.montage.remontageMs = second.readyMs
  check('remontage', second.readyMs !== null, `${second.readyMs} ms`)

  if (!values['sans-pannes']) {
    // Serveur arrêté : connexion refusée
    await dav('MKCOL', 'Panne arrêt')
    await dav('PUT', 'Panne arrêt/a.txt', 'a')
    await rcCall('vfs/forget', {})
    await relay.stop()
    const refused = await timed('ls', [join(mountPoint, 'Panne arrêt')], 150_000)
    const stillMounted = mounted()
    await relay.start()
    const recovered = await timed('ls', [join(mountPoint, 'Panne arrêt')], 60_000)
    result.pannes.serveurArrete = {
      ls: refused,
      volumeToujoursMonte: stillMounted,
      reprise: recovered
    }
    console.log('[panne] serveur arrêté', JSON.stringify(result.pannes.serveurArrete))

    // Serveur muet : la connexion s'établit, la réponse ne vient jamais
    await dav('MKCOL', 'Panne muet')
    relay.mode = 'mute'
    const watchStarted = now()
    let unmountedAt = null
    const watcher = setInterval(() => {
      if (unmountedAt === null && !mounted()) unmountedAt = round(now() - watchStarted)
    }, 500)
    const mute = await timed('ls', [join(mountPoint, 'Panne muet')], 150_000)
    clearInterval(watcher)
    relay.mode = 'pass'
    result.pannes.serveurMuet = { ls: mute, demonteDOfficeApresMs: unmountedAt }
    console.log('[panne] serveur muet', JSON.stringify(result.pannes.serveurMuet))
    if (!mounted()) {
      try {
        await rcCall('core/quit', {}, 2000)
      } catch {
        // rclone a pu partir avec le volume
      }
      await sleep(1000)
      const again = await mount('apres-muet')
      result.pannes.serveurMuet.remontageMs = again.readyMs
    }

    // rclone tué net : sans l'application pour démonter, combien de temps tout reste figé ?
    await dav('MKCOL', 'Panne rclone')
    const killedAt = now()
    rclone.kill('SIGKILL')
    let goneAt = null
    const watcher2 = setInterval(() => {
      if (goneAt === null && !mounted()) goneAt = round(now() - killedAt)
    }, 500)
    const dead = await timed('ls', [join(mountPoint, 'Panne rclone')], 120_000)
    clearInterval(watcher2)
    let forcedMs = null
    if (mounted()) {
      const started = now()
      try {
        execFileSync('/sbin/umount', ['-f', mountPoint], { timeout: 20_000 })
      } catch {
        // compté plus bas
      }
      forcedMs = round(now() - started)
    }
    result.pannes.rcloneTue = {
      ls: dead,
      demonteDOfficeApresMs: goneAt,
      umountForceMs: forcedMs,
      volumeEncoreMonte: mounted()
    }
    console.log('[panne] rclone tué', JSON.stringify(result.pannes.rcloneTue))
    check('volume libéré après la mort de rclone', !mounted())
  } else {
    result.montage.demontageFinalMs = await unmount()
  }
} catch (error) {
  result.erreurs.push(String(error?.stack ?? error))
  console.error(error)
  exitCode = 1
} finally {
  if (mounted()) {
    try {
      execFileSync('/sbin/umount', ['-f', mountPoint], { timeout: 20_000 })
    } catch {
      // rien de plus à faire
    }
  }
  for (const child of children) if (child.exitCode === null) child.kill()
  await relay.stop().catch(() => undefined)
  relay.agent.destroy()
}

if (result.verifications.some((v) => !v.ok)) exitCode = 1
writeFileSync(join(OUT, 'bench-macos-lecteur.json'), JSON.stringify(result, null, 2))

const ms = (value) => (value === null || value === undefined ? '—' : `${value} ms`)
const failure = (f) =>
  f
    ? `${f.ls.timedOut ? `toujours bloqué après ${f.ls.ms} ms` : `rendu en ${f.ls.ms} ms (code ${f.ls.code})`}`
    : '—'
const lines = [
  `### macOS — lecteur (rclone nfsmount, ${result.macos}, latence ${LATENCY} ms)`,
  '',
  `- Montage : ${ms(result.montage.utilisableMs)} (remontage ${ms(result.montage.remontageMs)}), démontage ${ms(result.montage.demontageMs)}`,
  `- rclone au repos : ${result.ressources.repos?.rssMo ?? '—'} Mo, ${result.ressources.repos?.cpuMoyen ?? '—'} % CPU`,
  `- Changement fait ailleurs : invisible sans oubli (8 s) : ${result.visibilite.invisibleSansOubli8s}, visible ${ms(result.visibilite.ajoutVisibleApresOubliMs)} après vfs/forget (suppression ${ms(result.visibilite.suppressionVisibleApresOubliMs)})`,
  `- Noms NFD reçus en NFC : ${result.noms.nfcSurLeServeur} ; fichiers « ._ » envoyés pour une copie avec attributs : ${result.attributs.appleDoubleSurLeServeur?.length ?? '—'}`,
  ...(values['sans-pannes']
    ? []
    : [
        `- Serveur arrêté : ls ${failure(result.pannes.serveurArrete)}, reprise ${result.pannes.serveurArrete ? ms(result.pannes.serveurArrete.reprise.ms) : '—'}`,
        `- Serveur muet : ls ${failure(result.pannes.serveurMuet)}, volume démonté d'office ${ms(result.pannes.serveurMuet?.demonteDOfficeApresMs)}`,
        `- rclone tué : ls ${failure(result.pannes.rcloneTue)}, volume démonté d'office ${ms(result.pannes.rcloneTue?.demonteDOfficeApresMs)}, umount -f ${ms(result.pannes.rcloneTue?.umountForceMs)}`
      ]),
  '',
  '| Opération | Durée | Serveur à jour |',
  '| --- | ---: | ---: |',
  ...(result.fichiers ?? []).map((r) => `| ${r.op} | ${r.wallMs} ms | ${r.syncedMs} ms |`),
  '',
  `Vérifications : ${result.verifications.filter((v) => v.ok).length}/${result.verifications.length}` +
    (result.erreurs.length ? ` — erreurs : ${result.erreurs.join(' ; ').slice(0, 300)}` : ''),
  ''
]
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'))
console.log(lines.join('\n'))
rmSync(work, { recursive: true, force: true })
process.exit(exitCode)
