/**
 * Parser de mensajes del grupo "Código que no hay más".
 *
 * Lógica pura, sin red ni WhatsApp. Reglas salidas de la muestra real
 * (15/10/2026, ver proyectos/tiendaquick-baja-informacion-whatsapp.md):
 *  - casi todos los mensajes son solo el código; a veces varios en líneas separadas;
 *  - los códigos pueden venir en minúscula (`367.c3289.3`) -> se normalizan a mayúsculas;
 *  - formatos: `131904`, `167.0800127`, `816201PHI`, `367.C3289.3`, `8B115`, `83606-FU`;
 *  - un token es "código candidato" si tiene 4-25 caracteres [A-Z0-9.-ÁÉÍÓÚÑ] y AL MENOS un dígito
 *    (así palabras como "gracias" u "ok" nunca se consideran).
 */

const CARACTERES_CODIGO = /^[A-Z0-9ÁÉÍÓÚÑ][A-Z0-9ÁÉÍÓÚÑ.\-]{3,24}$/
// Signos que WhatsApp/la gente pega alrededor del código: *negrita*, _cursiva_, ~tachado~, (x), "x", comas, etc.
const ENVOLTURA = /^[\s*_~()[\]"'`.,;:!?¡¿]+|[\s*_~()[\]"'`.,;:!?¡¿]+$/g

/**
 * @param {string} texto
 * @returns {{ codigos: string[], sobrantes: string[] }}
 *   codigos: códigos candidatos, normalizados, sin repetidos dentro del mismo mensaje y en orden.
 *   sobrantes: tokens que NO parecen código (para detectar mensajes ambiguos con texto libre).
 */
export function extraerCodigos(texto) {
  const codigos = []
  const sobrantes = []
  if (typeof texto !== 'string') return { codigos, sobrantes }

  for (const crudo of texto.split(/[\s,;]+/)) {
    const token = crudo.replace(ENVOLTURA, '').toUpperCase()
    if (!token) continue
    if (CARACTERES_CODIGO.test(token) && /\d/.test(token)) {
      if (!codigos.includes(token)) codigos.push(token)
    } else {
      sobrantes.push(token)
    }
  }
  return { codigos, sobrantes }
}

/** Un mensaje es "limpio" si solo tiene códigos (nada más). Los demás se registran como ambiguos. */
export function esMensajeLimpio({ codigos, sobrantes }) {
  return codigos.length > 0 && sobrantes.length === 0
}
