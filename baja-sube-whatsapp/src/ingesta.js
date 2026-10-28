/**
 * Convierte una entrada del log del listener (la misma línea que se escribe en shadow-*.jsonl)
 * en filas de la base. La usan el listener en vivo y el script de replay del historial.
 */
import { registrarReporte, registrarReaccion } from './db.js'

const TIPOS_CON_CODIGOS = new Set(['texto', 'imagen', 'video'])

export function ingestarEntrada(db, e) {
  if (TIPOS_CON_CODIGOS.has(e.tipo)) {
    for (const codigo of e.codigos || []) {
      registrarReporte(db, { msg_id: e.msg_id, codigo, de: e.de, jid: e.jid_remitente, ts: e.ts_whatsapp || e.ts })
    }
  } else if (e.tipo === 'reaccion') {
    registrarReaccion(db, { objetivo_msg_id: e.objetivo_msg_id, emoji: e.emoji, de: e.de, ts: e.ts_whatsapp || e.ts })
  }
}
