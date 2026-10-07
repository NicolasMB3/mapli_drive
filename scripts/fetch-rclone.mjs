#!/usr/bin/env node
/*
 * rclone pour macOS, dans resources/rclone : les deux architectures (Apple Silicon et Intel)
 * téléchargées depuis downloads.rclone.org, chaque archive vérifiée par son empreinte
 * SHA-256, puis réunies en un binaire universel (lipo), comme l'application.
 *
 * Version et empreintes : celles épinglées dans .github/workflows/build.yml (RCLONE_VERSION,
 * RCLONE_SHA256_MAC_ARM64, RCLONE_SHA256_MAC_AMD64), ou les mêmes variables d'environnement
 * (une autre version : ses empreintes publiées, SHA256SUMS, servent alors).
 * Usage : node scripts/fetch-rclone.mjs
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_YML = readFileSync(join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8')
/** Valeur épinglée dans build.yml (« NOM: valeur »), sauf variable d'environnement. */
const pinned = (name) =>
  process.env[name] || new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, 'm').exec(BUILD_YML)?.[1]
const VERSION = pinned('RCLONE_VERSION')
if (!VERSION) throw new Error('RCLONE_VERSION introuvable dans build.yml')
const TARGET = join(ROOT, 'resources', 'rclone')
const BASE = `https://downloads.rclone.org/${VERSION}`

if (process.platform !== 'darwin') {
  console.error('fetch-rclone : réservé à macOS (lipo). Windows : voir build.yml.')
  process.exit(1)
}

async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} : HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

async function expectedHashes() {
  // Empreintes épinglées : seulement pour la version épinglée avec elles.
  if (!process.env.RCLONE_VERSION || process.env.RCLONE_VERSION === pinned('RCLONE_VERSION')) {
    const hashes = {
      arm64: pinned('RCLONE_SHA256_MAC_ARM64'),
      amd64: pinned('RCLONE_SHA256_MAC_AMD64')
    }
    if (hashes.arm64 && hashes.amd64) return hashes
  }
  const sums = (await download(`${BASE}/SHA256SUMS`)).toString('utf8')
  const find = (arch) => {
    const line = sums
      .split('\n')
      .find((l) => l.trim().endsWith(`rclone-${VERSION}-osx-${arch}.zip`))
    if (!line) throw new Error(`empreinte introuvable pour ${arch}`)
    return line.trim().split(/\s+/)[0]
  }
  return { arm64: find('arm64'), amd64: find('amd64') }
}

const work = mkdtempSync(join(tmpdir(), 'mapli-rclone-'))
try {
  const hashes = await expectedHashes()
  const binaries = []
  for (const arch of ['arm64', 'amd64']) {
    const name = `rclone-${VERSION}-osx-${arch}`
    const zip = await download(`${BASE}/${name}.zip`)
    const actual = sha256(zip)
    if (actual !== hashes[arch]) {
      throw new Error(`empreinte inattendue pour ${name}.zip : ${actual} (attendu ${hashes[arch]})`)
    }
    const zipPath = join(work, `${name}.zip`)
    writeFileSync(zipPath, zip)
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', work])
    binaries.push(join(work, name, 'rclone'))
  }
  mkdirSync(dirname(TARGET), { recursive: true })
  if (existsSync(TARGET)) rmSync(TARGET)
  execFileSync('lipo', ['-create', ...binaries, '-output', TARGET])
  chmodSync(TARGET, 0o755)
  const archs = execFileSync('lipo', ['-archs', TARGET]).toString().trim()
  console.log(
    `rclone ${VERSION} universel (${archs}) → ${TARGET} — ${(readFileSync(TARGET).length / 1e6).toFixed(0)} Mo`
  )
} finally {
  rmSync(work, { recursive: true, force: true })
}
