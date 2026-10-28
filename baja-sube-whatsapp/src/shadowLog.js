/**
 * Log del modo sombra: un archivo JSONL por día en LOG_DIR, una línea por mensaje del grupo.
 * Solo se escribe lo estrictamente necesario para comparar contra el proceso manual:
 * hora, quién (nombre + JID, hará falta para el DM de la fase 3), códigos extraídos y tipo de mensaje.
 * El texto original solo se guarda cuando el mensaje es ambiguo (tiene texto libre además del código)
 * y SHADOW_GUARDAR_TEXTO_AMBIGUO=true, truncado a 200 caracteres, para poder afinar el parser.
 */
import fs from 'fs'
import path from 'path'

const LOG_DIR = path.resolve(process.cwd(), process.env.LOG_DIR || './logs')
fs.mkdirSync(LOG_DIR, { recursive: true })

function archivoDelDia(fecha = new Date()) {
  const dia = fecha.toISOString().slice(0, 10)
  return path.join(LOG_DIR, `shadow-${dia}.jsonl`)
}

export function registrar(entrada) {
  fs.appendFileSync(archivoDelDia(), JSON.stringify(entrada) + '\n', 'utf8')
}

/** Latido para saber desde fuera (y desde monitoreo) que el listener sigue vivo y conectado. */
export function escribirEstado(estado) {
  fs.writeFileSync(path.join(LOG_DIR, 'estado.json'), JSON.stringify(estado, null, 2), 'utf8')
}
