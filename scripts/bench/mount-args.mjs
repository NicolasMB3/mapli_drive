#!/usr/bin/env node
/*
 * Arguments et environnement du montage rclone, construits par le code même de
 * l'application : src/main/rclone-args.ts est importé tel quel (Node 22.18 et suivants
 * lisent le TypeScript sans compilation). Le banc Windows monte donc exactement comme
 * Mapli Drive, sans liste d'options recopiée à la main qui finirait par diverger.
 *
 * Usage (le token et les identifiants du port de contrôle passent par l'environnement,
 * comme dans l'application) :
 *   MAPLI_BENCH_TOKEN=… MAPLI_BENCH_RC_USER=… MAPLI_BENCH_RC_PASS=… \
 *   node scripts/bench/mount-args.mjs --out spec.json --dav-url http://127.0.0.1:8090/ \
 *     --mount-point M: --cache-dir … --log-file … --config … --rc-port 5572
 *
 * Écrit { args, env, volumeName, userAgent } : `env` ne contient que ce que l'application
 * ajoute à l'environnement hérité (RCLONE_*, proxy).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { VOLUME_NAME } from '../../src/main/config.ts'
import { rcloneMountArgs, rcloneMountEnv } from '../../src/main/rclone-args.ts'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    'dav-url': { type: 'string' },
    'mount-point': { type: 'string' },
    'cache-dir': { type: 'string' },
    'log-file': { type: 'string' },
    config: { type: 'string' },
    'rc-port': { type: 'string' },
    // Réglage par défaut de l'application (session.ts).
    'cache-size-gb': { type: 'string', default: '10' },
    proxy: { type: 'string' }
  }
})

for (const name of [
  'out',
  'dav-url',
  'mount-point',
  'cache-dir',
  'log-file',
  'config',
  'rc-port'
]) {
  if (!values[name]) throw new Error(`--${name} manquant`)
}
for (const name of ['MAPLI_BENCH_TOKEN', 'MAPLI_BENCH_RC_USER', 'MAPLI_BENCH_RC_PASS']) {
  if (!process.env[name]) throw new Error(`${name} manquant`)
}

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

const options = {
  davUrl: values['dav-url'],
  token: process.env.MAPLI_BENCH_TOKEN,
  mountPoint: values['mount-point'],
  volumeName: VOLUME_NAME,
  rcPort: Number(values['rc-port']),
  rcUser: process.env.MAPLI_BENCH_RC_USER,
  rcPass: process.env.MAPLI_BENCH_RC_PASS,
  cacheDir: values['cache-dir'],
  cacheSizeGb: Number(values['cache-size-gb']),
  logFile: values['log-file'],
  configFile: values.config,
  // Comme drive-mount.ts : « MapliDrive/<version> ».
  userAgent: `MapliDrive/${version}`,
  ...(values.proxy === undefined ? {} : { proxy: values.proxy || null })
}

const spec = {
  args: rcloneMountArgs(options),
  // Base vide : seules les variables ajoutées par l'application.
  env: rcloneMountEnv(options, {}),
  volumeName: VOLUME_NAME,
  userAgent: options.userAgent
}
writeFileSync(values.out, JSON.stringify(spec, null, 2))

// Les arguments ne contiennent aucun secret (c'est vérifié par les tests) : affichés pour le journal.
console.log(`rclone ${spec.args.join(' ')}`)
