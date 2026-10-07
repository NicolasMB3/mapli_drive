#!/usr/bin/env node
/*
 * Lance une commande et note sa durée : une ligne au résumé de la CI
 * ($GITHUB_STEP_SUMMARY), et au fichier JSON donné par --json. Le code de sortie de la
 * commande est rendu tel quel.
 *
 * Usage : node scripts/bench/timed.mjs "Tests unitaires" [--json durees.json] -- npm test
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const separator = process.argv.indexOf('--')
if (separator < 3 || separator === process.argv.length - 1) {
  console.error('usage : timed.mjs <libellé> [--json fichier] -- <commande…>')
  process.exit(2)
}
const options = process.argv.slice(2, separator)
const [command, ...args] = process.argv.slice(separator + 1)
const label = options[0]
const jsonIndex = options.indexOf('--json')
const jsonFile = jsonIndex >= 0 ? options[jsonIndex + 1] : null

const started = performance.now()
// npm, npx… sont des scripts .cmd sous Windows : il faut le shell pour les lancer.
const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' })
child.on('exit', (code, signal) => {
  const seconds = Math.round((performance.now() - started) / 100) / 10
  const ok = code === 0
  const line = `- ${label} : ${seconds} s${ok ? '' : ` — ÉCHEC (${code ?? signal})`}`
  console.log(line)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`)
  if (jsonFile) {
    const data = existsSync(jsonFile) ? JSON.parse(readFileSync(jsonFile, 'utf8')) : {}
    data[label] = { secondes: seconds, ok }
    writeFileSync(jsonFile, JSON.stringify(data, null, 2))
  }
  process.exit(code ?? 1)
})
