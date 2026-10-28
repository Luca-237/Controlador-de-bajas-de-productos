/**
 * Arma el paquete para subir al servidor: dist/bajas-cindy-AAAA-MM-DD.tar.gz con solo el código.
 * NUNCA incluye .env, data/ (base y clave de sesiones), logs/, auth/ (sesión de WhatsApp),
 * node_modules/ ni la clave local de prueba. Antes de empaquetar corre los tests.
 *   npm run empaquetar
 */
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(raiz)

// Lo que viaja: código, panel, scripts, configuración de PM2/nginx y documentación.
const INCLUIR = ['package.json', 'package-lock.json', 'ecosystem.config.cjs', '.env.example', '.gitignore', 'DEPLOY.md', 'src', 'public', 'scripts', 'deploy']
const PROHIBIDOS = ['.env', 'data', 'logs', 'auth', 'node_modules', 'clave-panel-local.txt']

for (const p of INCLUIR) if (!fs.existsSync(p)) throw new Error(`Falta ${p}`)
for (const p of PROHIBIDOS) if (INCLUIR.includes(p)) throw new Error(`${p} no se puede empaquetar`)

console.log('Corriendo los tests antes de empaquetar…')
execFileSync(process.execPath, ['--test'], { stdio: 'inherit' })

fs.mkdirSync('dist', { recursive: true })
const archivo = path.join('dist', `bajas-cindy-${new Date().toISOString().slice(0, 10)}.tar.gz`)
// tar viene con Windows 10+ y con cualquier Linux. Se excluyen también por las dudas archivos sueltos de prueba.
execFileSync('tar', ['-czf', archivo, '--exclude=*.db', '--exclude=*.db-*', '--exclude=session.key', ...INCLUIR], { stdio: 'inherit' })

// Control final: que no se haya colado nada sensible.
const contenido = execFileSync('tar', ['-tzf', archivo], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
const colado = contenido.filter((f) => /(^|\/)(\.env|auth\/|data\/|logs\/|node_modules\/|clave-panel-local\.txt)/.test(f) && !f.endsWith('.env.example'))
if (colado.length) {
  fs.rmSync(archivo)
  throw new Error(`El paquete incluía archivos sensibles y se borró: ${colado.join(', ')}`)
}
const kb = Math.round(fs.statSync(archivo).size / 1024)
console.log(`\nListo: ${archivo} (${contenido.length} archivos, ${kb} KB). Sin .env, base, logs ni sesión de WhatsApp.`)
