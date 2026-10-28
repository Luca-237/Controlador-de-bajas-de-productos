/**
 * Valida contra Manager los códigos reportados y mantiene al día su estado.
 *  - `validarPorValidar`: códigos nuevos (o re-reportados) -> existe? Sube? variantes?
 *  - `reconciliar`: re-chequea los `pendiente` para pasarlos solos a `procesado` cuando Mauricio carga Sube=0.
 * Todo secuencial (nunca en paralelo): Manager ya demostró ser frágil con consultas concurrentes.
 */
import { calcularEstado } from './logica.js'
import { consultarCodigos, consultarVariantes } from './manager.js'
import { consultarSitios } from './sitios.js'
import {
  codigosPorValidar, codigosPendientes, aplicarValidacion, marcarErrorConsulta, setMeta, codigosParaRevisarSitios, guardarSitios,
} from './db.js'

// Si Manager no responde, se pausa 30 s antes de reintentar (no martillarlo cada 5 s mientras está caído).
const PAUSA_TRAS_ERROR_MS = 30_000
let pausaHasta = 0

/** Consulta Manager por una lista de códigos y guarda el resultado de cada uno. Devuelve cuántos actualizó. */
async function validarLista(db, codigos) {
  if (!codigos.length || Date.now() < pausaHasta) return 0
  let encontrados
  try {
    encontrados = await consultarCodigos(codigos)
  } catch (err) {
    pausaHasta = Date.now() + PAUSA_TRAS_ERROR_MS
    for (const c of codigos) marcarErrorConsulta(db, c, err.message)
    console.error('[validador] Error consultando Manager:', err.message)
    return 0
  }
  let n = 0
  for (const codigo of codigos) {
    try {
      const art = encontrados.get(codigo) || { existe: false }
      // Variantes solo si el artículo existe y es vigente (ahorra consultas con los códigos inválidos).
      const variantes = art.existe && !art.noVigente ? await consultarVariantes(codigo, art.descripcion) : []
      const { estado, aBajar } = calcularEstado(codigo, art, variantes)
      aplicarValidacion(db, codigo, { estado, aBajar, articulo: art.existe ? art : {}, variantes })
      n++
    } catch (err) {
      marcarErrorConsulta(db, codigo, err.message)
      console.error(`[validador] Error validando ${codigo}:`, err.message)
    }
  }
  return n
}

export async function validarPorValidar(db) {
  return validarLista(db, codigosPorValidar(db, 50))
}

export async function reconciliar(db) {
  const n = await validarLista(db, codigosPendientes(db))
  setMeta(db, 'ultima_reconciliacion', new Date().toISOString())
  return n
}

/**
 * Revisa las páginas (web de Cindy + catálogo y tienda de Travel Blue) por los códigos que lo necesitan. Secuencial.
 * Va aparte de Manager: si Manager está caído (HTTP 408) o no está configurado, se revisa igual.
 */
export async function revisarSitios(db, { fetchFn = fetch, ...opts } = {}) {
  let n = 0
  for (const codigo of codigosParaRevisarSitios(db, opts)) {
    try {
      guardarSitios(db, codigo, await consultarSitios(codigo, fetchFn))
      n++
    } catch (err) {
      // Solo llega acá un código inválido (CODIGO_SEGURO): se marca consultado para no reintentarlo.
      const e = { estado: 'error', error: err.message }
      guardarSitios(db, codigo, { cindy: e, catalogo: e, tienda: e, publicadoEn: [], aBajar: false, conError: false })
      console.error(`[sitios] ${codigo}:`, err.message)
    }
  }
  if (n) setMeta(db, 'ultima_revision_sitios', new Date().toISOString())
  return n
}

/**
 * Arranca los ciclos. Devuelve una función para frenarlos.
 * Manager (validar + reconciliar) comparte un candado; las páginas tienen el suyo, así no se esperan.
 * @param {{conManager?:boolean, validarCadaMs?:number, reconciliarCadaMs?:number, sitiosCadaMs?:number}} opts
 */
export function iniciarValidador(db, { conManager = true, validarCadaMs = 5_000, reconciliarCadaMs = 10 * 60_000, sitiosCadaMs = 15_000 } = {}) {
  const candado = () => {
    let ocupado = false
    return (fn) => async () => {
      if (ocupado) return // un solo ciclo a la vez
      ocupado = true
      try {
        await fn(db)
      } catch (err) {
        console.error('[validador] Error en el ciclo:', err.message)
      } finally {
        ocupado = false
      }
    }
  }
  const manager = candado()
  const sitios = candado()
  const timers = [setInterval(sitios(revisarSitios), sitiosCadaMs)]
  if (conManager) {
    timers.push(setInterval(manager(validarPorValidar), validarCadaMs), setInterval(manager(reconciliar), reconciliarCadaMs))
  }
  return () => timers.forEach(clearInterval)
}
