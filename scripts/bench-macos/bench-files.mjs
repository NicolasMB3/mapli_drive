#!/usr/bin/env node
/*
 * Banc des opérations de fichiers sur un lecteur Mapli monté (macOS) : listages, copies
 * (petits fichiers, fichiers « téléchargés » avec attributs étendus, gros fichier), relecture,
 * renommage, réécriture, suppressions. Chaque opération est chronométrée ; avec le journal du
 * serveur de banc (une ligne JSON par requête : m, p, s, ms), le nombre de requêtes HTTP
 * qu'elle provoque et leur temps serveur sont relevés aussi.
 *
 * Usage :
 *   node scripts/bench-macos/bench-files.mjs <point de montage> [--requests <requests.jsonl>]
 *        [--rc http://utilisateur:motdepasse@127.0.0.1:port] [--label nom] [--out resultat.json]
 *
 *  --rc : port de contrôle de rclone ; chaque opération attend alors que ses envois soient
 *         partis (colonne « serveur à jour »), l'écriture étant différée de 3 s.
 *
 * Mesures du 08/10/2026 (même serveur local, macOS 26) : client WebDAV du Finder 17,2 s pour
 * l'ensemble (20 petits fichiers : 10 s et 793 requêtes) ; rclone NFS 1,6 s (0,2 s, et 121
 * requêtes envoyées en arrière-plan).
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  renameSync,
  appendFileSync,
  readdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const mount = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))
if (!mount || !existsSync(mount)) {
  console.error(
    'Usage : bench-files.mjs <point de montage> [--requests fichier] [--rc url] [--label nom]'
  )
  process.exit(1)
}
const requestsLog = option('--requests')
const rcUrl = option('--rc')
const label = option('--label') ?? 'banc'
const work = join(mount, 'Banc Drive (à supprimer)')
const src = join(tmpdir(), `mapli-bench-src-${process.pid}`)
const results = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function logOffset() {
  return requestsLog && existsSync(requestsLog) ? statSync(requestsLog).size : 0
}

function requestsSince(offset) {
  if (!requestsLog || !existsSync(requestsLog)) return []
  const size = statSync(requestsLog).size - offset
  if (size <= 0) return []
  const fd = openSync(requestsLog, 'r')
  const buffer = Buffer.alloc(size)
  readSync(fd, buffer, 0, size, offset)
  closeSync(fd)
  return buffer
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function pendingUploads() {
  const url = new URL(rcUrl)
  const response = await fetch(`${url.protocol}//${url.host}/vfs/stats`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`
    },
    body: '{}'
  })
  const stats = await response.json()
  return (stats.diskCache?.uploadsInProgress ?? 0) + (stats.diskCache?.uploadsQueued ?? 0)
}

async function settled() {
  if (!rcUrl) return 0
  const started = Date.now()
  await sleep(200)
  while (Date.now() - started < 120_000 && (await pendingUploads()) > 0) await sleep(200)
  return Date.now() - started
}

async function op(name, fn) {
  await sleep(1_200)
  const offset = logOffset()
  const started = Date.now()
  let error = null
  try {
    await fn()
  } catch (e) {
    error = String(e?.message ?? e)
  }
  const wall = Date.now() - started
  const synced = wall + (await settled())
  await sleep(1_500)
  const requests = requestsSince(offset)
  const technical = requests.filter((r) =>
    /^(\._|\.DS_Store)/.test(basename(r.p.replace(/\/$/, '')))
  ).length
  const errors = requests.filter((r) => r.s >= 400).length
  const serverMs = Math.round(requests.reduce((sum, r) => sum + (r.ms ?? 0), 0))
  results.push({
    op: name,
    wallMs: wall,
    syncedMs: synced,
    requests: requests.length,
    serverMs,
    technical,
    errors,
    error
  })
  console.log(
    `${name.padEnd(44)} ${String(wall).padStart(7)} ms` +
      (rcUrl ? ` (serveur à jour ${String(synced).padStart(6)} ms)` : '') +
      (requestsLog
        ? `  ${String(requests.length).padStart(4)} req  ${String(serverMs).padStart(6)} ms serveur  ${technical} techniques  ${errors} en erreur`
        : '') +
      (error ? `  !! ${error}` : '')
  )
}

function prepareSources() {
  rmSync(src, { recursive: true, force: true })
  mkdirSync(src, { recursive: true })
  for (let i = 0; i < 20; i++)
    writeFileSync(join(src, `petit-${String(i).padStart(2, '0')}.txt`), randomBytes(10_000))
  for (let i = 0; i < 10; i++) {
    const file = join(src, `telecharge-${String(i).padStart(2, '0')}.pdf`)
    writeFileSync(file, randomBytes(50_000))
    // Comme un fichier téléchargé : le Finder recopie ces attributs en « ._fichier ».
    execFileSync('xattr', ['-w', 'com.apple.quarantine', '0083;66f0c000;Safari;', file])
  }
  writeFileSync(join(src, 'gros-20Mo.bin'), randomBytes(20_000_000))
}

const copy = (names) => names.forEach((name) => execFileSync('cp', [join(src, name), work]))
const ls = (dir) => execFileSync('ls', ['-la', dir], { stdio: 'ignore' })

prepareSources()
const small = readdirSync(src)
  .filter((n) => n.startsWith('petit-'))
  .sort()
const downloaded = readdirSync(src)
  .filter((n) => n.startsWith('telecharge-'))
  .sort()
console.log(`== ${label} — ${mount}`)
await op('ls -la racine', () => ls(mount))
await op('ls -la racine (2e fois)', () => ls(mount))
await op('mkdir dossier de banc', () => mkdirSync(work, { recursive: true }))
await op('cp 20 petits fichiers (10 Ko)', () => copy(small))
await op('cp 10 fichiers téléchargés (50 Ko + xattr)', () => copy(downloaded))
await op('cp 1 gros fichier (20 Mo)', () => copy(['gros-20Mo.bin']))
await op('ls -la dossier (31 entrées)', () => ls(work))
await op('lecture 20 petits fichiers', () => small.forEach((n) => readFileSync(join(work, n))))
await op('lecture gros fichier (20 Mo)', () => readFileSync(join(work, 'gros-20Mo.bin')))
await op('renommer 1 fichier', () => renameSync(join(work, small[0]), join(work, 'renommé.txt')))
await op('modifier 1 fichier (ajout)', () => appendFileSync(join(work, small[1]), 'fin\n'))
await op('supprimer 10 fichiers', () => small.slice(2, 12).forEach((n) => rmSync(join(work, n))))
// Comme le Finder : le contenu d'abord (le serveur NFS de rclone répond EIO, et non
// ENOTEMPTY, à la suppression d'un dossier non vide — fs.rmSync s'y arrête).
await op('supprimer le dossier de banc', () => execFileSync('rm', ['-rf', work]))
rmSync(src, { recursive: true, force: true })

const total = results.reduce((sum, r) => sum + r.wallMs, 0)
console.log(`TOTAL ${total} ms`)
const out = option('--out')
if (out)
  writeFileSync(
    out,
    JSON.stringify({ label, mount, date: new Date().toISOString(), results }, null, 1)
  )
