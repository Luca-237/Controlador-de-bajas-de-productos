/**
 * Lógica pura (sin red, sin base de datos) de las bajas: qué código hay que bajar y por qué.
 *
 * Regla de padre/variantes (decidida por Mauricio, 15/10/2026):
 *  - si reportan un PADRE: se baja el padre y TODAS sus variantes vigentes;
 *  - si reportan una VARIANTE: se baja solo esa.
 * Manager no tiene vínculo padre-hijo: la relación es heurística. `mismoTipoProducto` es un port fiel de
 * `_mismo_tipo_producto()` de integracion-manager-odoo/variantes.py (validada 99,8 % contra el catálogo).
 */

const sinAcentos = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
const palabras = (d) => sinAcentos((d || '').toLowerCase()).match(/[a-z0-9]+/g) || []
const compacto = (d) => sinAcentos((d || '').toLowerCase()).replace(/[^a-z0-9]/g, '')

function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/** ¿La descripción de la variante es "del mismo tipo de producto" que la del padre? (4 criterios, igual que en Odoo). */
export function mismoTipoProducto(descPadre, descVariante) {
  const wp = palabras(descPadre)
  const wv = palabras(descVariante)
  if (!wp.length || !wv.length) return false
  const pp = wp[0]
  const pv = wv[0]
  if (pp === pv) return true
  if (compacto(descVariante).includes(pp) || compacto(descPadre).includes(pv)) return true
  const umbral = Math.min(pp.length, pv.length) <= 5 ? 1 : 2
  if (levenshtein(pp, pv) <= umbral) return true
  const restoP = new Set(wp.slice(1))
  const restoV = new Set(wv.slice(1))
  if (restoP.size && restoV.size) {
    const inter = [...restoP].filter((w) => restoV.has(w))
    if (inter.length / Math.min(restoP.size, restoV.size) >= 0.75 && inter.length >= 2) return true
  }
  return false
}

const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** ¿`codigo` tiene forma de variante de `padre`? (`PADRE-` + 2 a 6 letras mayúsculas). */
export function tieneFormaDeVariante(padre, codigo) {
  return new RegExp(`^${escaparRegex(padre)}-[A-ZÁÉÍÓÚÑ]{2,6}$`).test(codigo)
}

/** Código válido para interpolar en SQL: solo los caracteres que el parser deja pasar. Defensa en profundidad. */
export const CODIGO_SEGURO = /^[A-Z0-9ÁÉÍÓÚÑ][A-Z0-9ÁÉÍÓÚÑ.-]{3,24}$/

/**
 * Filtra, de las filas hijas candidatas que devolvió Manager, las que son variantes reales del padre.
 * @param {string} padre
 * @param {string} descPadre
 * @param {{codigo:string, descripcion:string, sube:number|null, noVigente:boolean}[]} candidatos
 */
export function filtrarVariantes(padre, descPadre, candidatos) {
  return candidatos
    .filter((c) => tieneFormaDeVariante(padre, c.codigo) && mismoTipoProducto(descPadre, c.descripcion))
    .sort((a, b) => a.codigo.localeCompare(b.codigo))
}

/**
 * Estado de un código reportado a partir de lo que dice Manager.
 * @param {{existe:boolean, noVigente?:boolean, sube?:number|null}} articulo
 * @param {{codigo:string, sube:number|null, noVigente:boolean}[]} variantes  (ya filtradas con filtrarVariantes)
 * @param {string} codigo
 * @returns {{estado:'no_existe'|'no_vigente'|'pendiente'|'procesado', aBajar:string[]}}
 */
export function calcularEstado(codigo, articulo, variantes = []) {
  if (!articulo.existe) return { estado: 'no_existe', aBajar: [] }
  if (articulo.noVigente) return { estado: 'no_vigente', aBajar: [] }
  const aBajar = []
  if (Number(articulo.sube) === 1) aBajar.push(codigo)
  for (const v of variantes) {
    if (!v.noVigente && Number(v.sube) === 1) aBajar.push(v.codigo)
  }
  return { estado: aBajar.length ? 'pendiente' : 'procesado', aBajar }
}
