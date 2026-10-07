#!/usr/bin/env node
/*
 * Démarrage de Mapli Drive mesuré, sans appairage ni réseau : délai jusqu'à la fenêtre
 * (créée, premier rendu, chargement terminé), mémoire et processeur de chaque processus
 * (principal, rendu, GPU, utilitaires) au fil des secondes, puis durée de l'arrêt propre.
 *
 *  - Application compilée (`npx electron-vite build`) lancée par l'Electron du projet, ou
 *    exécutable installé (--exe) ;
 *  - profil jetable (--user-data-dir) : rien du poste n'est lu ni modifié, et le premier
 *    lancement est bien un premier lancement (le second, un lancement ordinaire) ;
 *  - adresses de Mapli détournées vers 127.0.0.1:9 (MAPLI_WEB_URL / MAPLI_API_URL) :
 *    aucune requête vers la production. L'application empaquetée cherche aussi ses mises à
 *    jour sur app.mapli.fr : la CI détourne ce nom dans le fichier hosts ;
 *  - mesures par les ports de débogage : l'inspecteur du processus principal donne
 *    app.getAppMetrics() (tous les processus), le protocole DevTools de la fenêtre donne
 *    les temps de navigation. L'inspecteur ajoute quelques Mo au processus principal.
 *
 * Usage : node scripts/bench/app-startup.mjs [--exe <chemin>] [--duration 20] [--runs 2]
 *           [--out resultat.json] [--summary resume.md] [--label "macOS, …"]
 * Le résumé Markdown va à --summary, sinon à $GITHUB_STEP_SUMMARY s'il existe.
 * Code de sortie 1 si un lancement n'a pas pu être mesuré.
 */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const { values } = parseArgs({
  options: {
    exe: { type: 'string' },
    duration: { type: 'string', default: '20' },
    runs: { type: 'string', default: '2' },
    out: { type: 'string' },
    summary: { type: 'string' },
    label: { type: 'string', default: '' }
  }
})
const durationMs = Number(values.duration) * 1000
const runCount = Math.max(1, Number(values.runs))
const summaryFile = values.summary ?? process.env.GITHUB_STEP_SUMMARY
const label =
  values.label ||
  `${process.platform}, application ${values.exe ? 'installée' : 'compilée (non empaquetée)'}`

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const round = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null

function freePort() {
  return new Promise((done, fail) => {
    const server = net.createServer()
    server.unref()
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

async function getJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} : ${response.status}`)
  return response.json()
}

/** Réessaie `probe` jusqu'à une valeur non nulle, ou échoue après `timeoutMs`. */
async function waitFor(what, probe, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`${what} : délai dépassé${last ? ` (${last.message})` : ''}`)
}

/** Client minimal du protocole DevTools (inspecteur de Node ou page de Chromium). */
async function devtools(url) {
  const socket = new WebSocket(url)
  await new Promise((done, fail) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', () => fail(new Error(`connexion impossible : ${url}`)), {
      once: true
    })
  })
  let next = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.fail(new Error(message.error.message))
    else waiter.done(message.result)
  })
  const send = (method, params) =>
    new Promise((done, fail) => {
      const id = ++next
      const timer = setTimeout(() => {
        pending.delete(id)
        fail(new Error(`${method} : pas de réponse`))
      }, 15_000)
      pending.set(id, {
        done: (value) => (clearTimeout(timer), done(value)),
        fail: (error) => (clearTimeout(timer), fail(error))
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
  return {
    async evaluate(expression) {
      const answer = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        includeCommandLineAPI: true
      })
      if (answer.exceptionDetails) {
        const { exception, text } = answer.exceptionDetails
        throw new Error(exception?.description ?? text)
      }
      return answer.result.value
    },
    close: () => socket.close()
  }
}

// `require` du processus principal (commande de l'inspecteur, sinon module principal CommonJS).
const LOAD = `(typeof require === 'function' ? require : process.mainModule.require)`

const METRICS = `(async () => {
  const { app } = ${LOAD}('electron')
  const info = await process.getProcessMemoryInfo()
  return JSON.stringify({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    packaged: app.isPackaged,
    userData: app.getPath('userData'),
    main: { memoryUsage: process.memoryUsage(), info },
    processes: app.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      serviceName: m.serviceName ?? null,
      workingSetKb: m.memory.workingSetSize,
      peakWorkingSetKb: m.memory.peakWorkingSetSize,
      privateKb: m.memory.privateBytes ?? null,
      cpuPercent: m.cpu.percentCPUUsage,
      cpuSeconds: m.cpu.cumulativeCPUUsage ?? null
    }))
  })
})()`

const TIMING = `(() => {
  const nav = performance.getEntriesByType('navigation')[0]
  const fcp = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint')
  return {
    readyState: document.readyState,
    timeOrigin: performance.timeOrigin,
    domContentLoaded: nav ? nav.domContentLoadedEventEnd : 0,
    load: nav ? nav.loadEventEnd : 0,
    fcp: fcp ? fcp.startTime : null,
    title: document.title
  }
})()`

// Arrêt différé : la réponse part avant que le processus ne s'arrête.
const QUIT = `(() => { setTimeout(() => ${LOAD}('electron').app.quit(), 50); return true })()`

/** Mémoire de chaque processus (Mo) regroupée par type, et totaux. */
function summarize(metrics) {
  const byType = {}
  let workingSet = 0
  let privateBytes = 0
  let cpu = 0
  for (const p of metrics.processes) {
    const key = p.serviceName ? `${p.type} (${p.serviceName})` : p.type
    byType[key] = round((byType[key] ?? 0) + p.workingSetKb / 1024)
    workingSet += p.workingSetKb
    privateBytes += p.privateKb ?? 0
    cpu += p.cpuSeconds ?? 0
  }
  return {
    processus: metrics.processes.length,
    memoireTotaleMo: round(workingSet / 1024),
    memoirePriveeTotaleMo: privateBytes ? round(privateBytes / 1024) : null,
    parTypeMo: byType,
    processeurCumuleS: round(cpu),
    principalTasJsMo: round(metrics.main.memoryUsage.heapUsed / 1048576)
  }
}

/** Mémoire résidente de l'arbre de processus selon `ps` (macOS, Linux) : recoupement. */
function psTree(rootPid) {
  if (process.platform === 'win32') return null
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], rssKb: +m[3], command: m[4].trim() }))
  const tree = new Set([rootPid])
  for (let grew = true; grew; ) {
    grew = false
    for (const row of rows)
      if (!tree.has(row.pid) && tree.has(row.ppid)) {
        tree.add(row.pid)
        grew = true
      }
  }
  const mine = rows.filter((row) => tree.has(row.pid))
  return {
    rssTotalMo: round(mine.reduce((sum, row) => sum + row.rssKb, 0) / 1024),
    processus: mine.map((row) => ({
      rssMo: round(row.rssKb / 1024),
      commande: row.command.split('/').pop()
    }))
  }
}

async function launch(index, userData) {
  const inspectPort = await freePort()
  const devtoolsPort = await freePort()
  // Sans --exe : l'Electron du projet (le paquet « electron » donne le chemin du binaire).
  const executable = values.exe ?? createRequire(import.meta.url)('electron')
  const args = [
    `--inspect=127.0.0.1:${inspectPort}`,
    `--remote-debugging-port=${devtoolsPort}`,
    `--user-data-dir=${userData}`,
    ...(values.exe ? [] : [ROOT])
  ]
  const env = {
    ...process.env,
    MAPLI_WEB_URL: 'http://127.0.0.1:9',
    MAPLI_API_URL: 'http://127.0.0.1:9/api/v1'
  }
  delete env.ELECTRON_RUN_AS_NODE

  const result = { lancement: index + 1 }
  const started = Date.now()
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const exited = new Promise((done) =>
    child.once('exit', (code, signal) => done({ code, signal, at: Date.now() }))
  )
  child.once('error', (error) => (result.erreur = error.message))

  let main = null
  try {
    const mainTarget = await waitFor(
      'inspecteur du processus principal',
      async () => (await getJson(`http://127.0.0.1:${inspectPort}/json/list`))[0],
      30_000
    )
    result.inspecteurPretMs = Date.now() - started
    const pageTarget = await waitFor(
      'fenêtre',
      async () =>
        (await getJson(`http://127.0.0.1:${devtoolsPort}/json/list`)).find(
          (target) => target.type === 'page'
        ),
      30_000
    )
    result.fenetreCreeeMs = Date.now() - started

    const page = await devtools(pageTarget.webSocketDebuggerUrl)
    const timing = await waitFor(
      'chargement de la fenêtre',
      async () => {
        const t = await page.evaluate(TIMING)
        return t.readyState === 'complete' && t.load > 0 ? t : null
      },
      30_000,
      50
    )
    page.close()
    result.titre = timing.title
    result.premierRenduMs =
      timing.fcp === null ? null : round(timing.timeOrigin + timing.fcp - started)
    result.contenuChargeMs = round(timing.timeOrigin + timing.domContentLoaded - started)
    result.chargementTermineMs = round(timing.timeOrigin + timing.load - started)

    main = await devtools(mainTarget.webSocketDebuggerUrl)
    result.echantillons = []
    for (const at of [5_000, 10_000, durationMs].filter(
      (ms, i, all) => ms <= durationMs && all.indexOf(ms) === i
    )) {
      const wait = started + at - Date.now()
      if (wait > 0) await sleep(wait)
      const metrics = JSON.parse(await main.evaluate(METRICS))
      result.application = {
        version: metrics.version,
        electron: metrics.electron,
        chrome: metrics.chrome,
        empaquetee: metrics.packaged,
        profil: metrics.userData
      }
      result.echantillons.push({ aS: at / 1000, ...summarize(metrics) })
      if (at === durationMs) result.detail = metrics.processes
    }
    result.recoupementPs = psTree(child.pid)

    const quitAt = Date.now()
    await main.evaluate(QUIT)
    const end = await Promise.race([exited, sleep(20_000).then(() => null)])
    result.arretMs = end ? end.at - quitAt : null
    result.codeDeSortie = end ? end.code : null
  } catch (error) {
    result.erreur = error.message
    result.sortie = output.slice(-4000)
  } finally {
    main?.close()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await Promise.race([exited, sleep(5_000)])
    }
  }
  return result
}

const userData = mkdtempSync(join(tmpdir(), 'mapli-drive-banc-'))
const launches = []
// Ce que l'application laisse dans son profil (cache HTTP de Chromium « Cache », etc.).
let profile = []
try {
  for (let i = 0; i < runCount; i++) {
    const result = await launch(i, userData)
    launches.push(result)
    console.log(JSON.stringify(result, null, 2))
  }
  profile = readdirSync(userData, { withFileTypes: true }).map(
    (entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`
  )
} finally {
  rmSync(userData, { recursive: true, force: true })
}

const report = {
  libelle: label,
  systeme: `${process.platform} ${release()}`,
  dureeS: durationMs / 1000,
  profil: profile,
  lancements: launches
}
if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2))

// ── Résumé Markdown ──────────────────────────────────────────────────────────
const cell = (value, unit = '') =>
  value === null || value === undefined ? '—' : `${value}${unit ? ` ${unit}` : ''}`
const last = (launch) => launch.echantillons?.at(-1) ?? null
const columns = launches.map((l) =>
  l.lancement === 1 ? '1er lancement' : `${l.lancement}e lancement`
)
const rows = [
  ['Inspecteur prêt (processus principal démarré)', (l) => cell(l.inspecteurPretMs, 'ms')],
  ['Fenêtre créée', (l) => cell(l.fenetreCreeeMs, 'ms')],
  ['Premier rendu', (l) => cell(l.premierRenduMs, 'ms')],
  ['Chargement terminé', (l) => cell(l.chargementTermineMs, 'ms')],
  [`Mémoire totale à ${durationMs / 1000} s`, (l) => cell(last(l)?.memoireTotaleMo, 'Mo')],
  ['Mémoire privée totale (Windows)', (l) => cell(last(l)?.memoirePriveeTotaleMo, 'Mo')],
  [
    'Par type de processus',
    (l) =>
      last(l)
        ? Object.entries(last(l).parTypeMo)
            .map(([type, mo]) => `${type} ${mo}`)
            .join(' · ') + ' Mo'
        : '—'
  ],
  ['Mémoire résidente selon ps (recoupement)', (l) => cell(l.recoupementPs?.rssTotalMo, 'Mo')],
  [`Processeur cumulé à ${durationMs / 1000} s`, (l) => cell(last(l)?.processeurCumuleS, 's')],
  ['Arrêt propre', (l) => cell(l.arretMs, 'ms')]
]
const app = launches.find((l) => l.application)?.application
const lines = [
  `### Démarrage de l'application — ${label}`,
  '',
  app
    ? `Mapli Drive ${app.version} · Electron ${app.electron} (Chromium ${app.chrome}) · profil ${app.profil}`
    : '',
  '',
  `| Mesure | ${columns.join(' | ')} |`,
  `|---|${columns.map(() => '---').join('|')}|`,
  ...rows.map(([name, value]) => `| ${name} | ${launches.map(value).join(' | ')} |`),
  '',
  `Contenu du profil après les lancements : ${profile.join(', ') || '—'}`,
  '',
  ...launches
    .filter((l) => l.erreur)
    .map((l) => `- ÉCHEC — lancement ${l.lancement} : ${l.erreur}`),
  ''
]
const summary = lines.join('\n')
console.log(summary)
if (summaryFile) appendFileSync(summaryFile, `${summary}\n`)

process.exit(launches.some((l) => l.erreur) ? 1 : 0)
