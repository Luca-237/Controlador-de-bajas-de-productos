/**
 * Arranca el panel desde la carpeta del proyecto aunque se lo llame desde otro lado
 * (así el .env, la base y los logs relativos se resuelven acá).
 *   node "<ruta>/scripts/panel-local.js"
 */
import path from 'path'
import { fileURLToPath } from 'url'

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
await import('../src/panel/server.js')
