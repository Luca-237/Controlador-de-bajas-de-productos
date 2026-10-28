/**
 * Define la clave del panel: pide la clave por teclado (sin mostrarla), guarda SOLO el hash scrypt
 * en PANEL_PASSWORD_HASH dentro del .env. La clave nunca se imprime ni queda en texto plano.
 *   npm run set-password
 */
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { hashearClave } from '../src/panel/auth.js'

function pedir(pregunta) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = (s) => {
      if (s.includes(pregunta)) process.stdout.write(s)
      else if (s === '\r\n' || s === '\n') process.stdout.write(s)
    }
    rl.question(pregunta, (r) => {
      rl.close()
      resolve(r)
    })
  })
}

const clave = await pedir('Nueva clave del panel (mínimo 10 caracteres): ')
if (clave.length < 10) {
  console.error('Muy corta. No se guardó nada.')
  process.exit(1)
}
const repetida = await pedir('Repetila: ')
if (clave !== repetida) {
  console.error('No coinciden. No se guardó nada.')
  process.exit(1)
}

const archivo = path.resolve(process.cwd(), '.env')
const actual = fs.existsSync(archivo) ? fs.readFileSync(archivo, 'utf8') : ''
const linea = `PANEL_PASSWORD_HASH=${hashearClave(clave)}`
const nuevo = /^PANEL_PASSWORD_HASH=.*$/m.test(actual)
  ? actual.replace(/^PANEL_PASSWORD_HASH=.*$/m, linea)
  : actual.replace(/\n?$/, '\n') + linea + '\n'
fs.writeFileSync(archivo, nuevo, { mode: 0o600 })
console.log('Listo: hash guardado en .env (la clave no se almacena). Reiniciá el panel para que la tome.')
