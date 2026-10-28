// Panel de bajas. Todo lo que viene de WhatsApp (nombres) y de Manager (descripciones) es texto de terceros:
// se pinta SIEMPRE con textContent / createElement, nunca con innerHTML.

const $ = (id) => document.getElementById(id)
const NS = 'http://www.w3.org/2000/svg'

let filtro = 'publicados'
let sitios = [] // [{clave, nombre}] que manda el servidor
let q = ''
let temporizador = null
let toastTimer = null

async function api(ruta, opciones = {}) {
  const resp = await fetch('/api' + ruta, {
    credentials: 'same-origin',
    ...opciones,
    headers: { 'X-Requested-With': 'panel', ...(opciones.body ? { 'Content-Type': 'application/json' } : {}) },
  })
  if (resp.status === 401 && ruta !== '/login') {
    mostrarLogin()
    throw new Error('Sesión vencida')
  }
  return resp
}

/** Crea un elemento: h('div', {class:'x'}, 'texto', otroNodo) */
function h(tag, attrs = {}, ...hijos) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const hijo of hijos.flat()) if (hijo != null && hijo !== false) el.append(hijo.nodeType ? hijo : document.createTextNode(String(hijo)))
  return el
}

function icono(nombre) {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'icono')
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(NS, 'use')
  use.setAttribute('href', '#i-' + nombre)
  svg.append(use)
  return svg
}

function relativo(iso) {
  if (!iso) return '—'
  const t = new Date(iso)
  const seg = Math.max(0, Math.round((Date.now() - t.getTime()) / 1000))
  if (seg < 60) return 'recién'
  if (seg < 3600) return `hace ${Math.floor(seg / 60)} min`
  if (seg < 86400) return `hace ${Math.floor(seg / 3600)} h`
  const hora = t.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
  const dias = Math.floor(seg / 86400)
  if (dias === 1) return `ayer ${hora}`
  return `${t.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })} ${hora}`
}

function aviso(texto, accion) {
  const t = $('toast')
  t.replaceChildren(h('span', {}, texto))
  if (accion) t.append(h('button', { type: 'button', onclick: () => { accion.fn(); t.hidden = true } }, accion.texto))
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (t.hidden = true), accion ? 8000 : 3000)
}

async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto)
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' })
    ta.value = texto
    document.body.append(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

// ---------- tema (automático / claro / oscuro) ----------
// Preferencia de cada persona en su navegador (localStorage): no es un dato del equipo.
// El <head> ya lo aplica antes de pintar; acá solo se cambia y se actualiza el botón.
const TEMAS = {
  auto: { siguiente: 'light', icono: 'monitor', texto: 'automático (como el sistema)' },
  light: { siguiente: 'dark', icono: 'sun', texto: 'claro' },
  dark: { siguiente: 'auto', icono: 'moon', texto: 'oscuro' },
}

function temaActual() {
  const t = document.documentElement.dataset.theme
  return t === 'light' || t === 'dark' ? t : 'auto'
}

function pintarBotonesTema() {
  const t = TEMAS[temaActual()]
  const proximo = TEMAS[t.siguiente]
  for (const b of document.querySelectorAll('.btn-tema')) {
    b.replaceChildren(icono(t.icono))
    b.title = `Tema: ${t.texto}. Tocá para pasar a ${proximo.texto}.`
    b.setAttribute('aria-label', b.title)
  }
}

function cambiarTema() {
  const nuevo = TEMAS[temaActual()].siguiente
  if (nuevo === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = nuevo
  try {
    if (nuevo === 'auto') localStorage.removeItem('bajas-tema')
    else localStorage.setItem('bajas-tema', nuevo)
  } catch {} // modo privado o almacenamiento bloqueado: el tema vale igual mientras la página esté abierta
  pintarBotonesTema()
  aviso(`Tema ${TEMAS[nuevo].texto}`)
}

for (const b of document.querySelectorAll('.btn-tema')) b.addEventListener('click', cambiarTema)
pintarBotonesTema()

// ---------- vistas ----------
function mostrarLogin() {
  clearInterval(temporizador)
  clearInterval(timerQr)
  $('vista-app').hidden = true
  $('vista-login').hidden = false
  $('clave').focus()
}

async function mostrarApp() {
  $('vista-login').hidden = true
  $('vista-app').hidden = false
  await refrescar()
  clearInterval(temporizador)
  temporizador = setInterval(() => !document.hidden && refrescar().catch(() => {}), 30_000)
}

// ---------- datos ----------
async function refrescar() {
  const [resumen, lista] = await Promise.all([
    api('/resumen').then((r) => r.json()),
    api(`/lista?filtro=${filtro}&q=${encodeURIComponent(q)}`).then((r) => r.json()),
  ])
  pintarResumen(resumen)
  pintarLista(lista.filas)
  refrescarVinculacion().catch(() => {})
}

function pintarResumen({ conteos, bot, ultimaReconciliacion, ultimaRevisionSitios, sitios: s }) {
  sitios = s || []
  $('num-a-bajar').textContent = conteos.publicados
  $('btn-copiar').disabled = conteos.publicados === 0
  $('n-publicados').textContent = conteos.publicados
  $('n-no-publicados').textContent = conteos.noPublicados
  $('n-revisando').textContent = conteos.revisando

  const estado = $('estado-bot')
  estado.replaceChildren(
    ...[
      h('span', {}, h('i', { class: 'punto ' + (bot.conectado ? 'ok' : 'mal') }), bot.conectado ? 'Bot conectado' : 'Bot desconectado'),
      h('span', {}, `Último mensaje: ${relativo(bot.ultimoMensajeGrupo)}`),
      h('span', {}, `Páginas revisadas: ${relativo(ultimaRevisionSitios)}`),
      ultimaReconciliacion ? h('span', {}, `Manager revisado: ${relativo(ultimaReconciliacion)}`) : null,
      bot.noDescifradosGrupo > 0 ? h('span', { class: 'aviso' }, `${bot.noDescifradosGrupo} mensaje(s) del grupo no se pudieron leer`) : null,
    ].filter(Boolean)
  )
}

const ETIQUETAS = { pendiente: 'Para bajar', por_validar: 'Validando…', procesado: 'Procesado', no_existe: 'No existe en Manager', no_vigente: 'No vigente' }

function chipsVariantes(f) {
  if (!f.variantes.length) return null
  return h(
    'div',
    { class: 'variantes' },
    h('span', { class: 'rotulo' }, 'Variantes:'),
    f.variantes.map((v) => {
      const sufijo = v.codigo.startsWith(f.codigo + '-') ? v.codigo.slice(f.codigo.length + 1) : v.codigo
      const activa = Number(v.sube) === 1
      return h('span', { class: 'chip' + (activa ? ' sube1' : ''), title: `${v.codigo}: Sube=${v.sube ?? 0}` }, h('i'), sufijo)
    })
  )
}

function notas(f) {
  const out = []
  if (f.reaccionado_pero_pendiente) {
    out.push(h('div', { class: 'nota alerta' }, icono('alert'), h('span', {}, 'Alguien reaccionó en el grupo, pero en Manager todavía figura con Sube = 1.')))
  }
  if (f.estado === 'no_existe') out.push(h('div', { class: 'nota error' }, icono('alert'), h('span', {}, 'No existe en Manager. Puede ser un error de tipeo: revisalo con quien lo mandó.')))
  if (f.estado === 'no_vigente') out.push(h('div', { class: 'nota error' }, icono('alert'), h('span', {}, 'Está como no vigente en Manager.')))
  if (f.error) out.push(h('div', { class: 'nota' }, icono('alert'), h('span', {}, 'No se pudo consultar Manager; se reintenta solo.')))
  if (f.ya_estaba && f.estado === 'procesado') out.push(h('div', { class: 'nota' }, icono('check'), h('span', {}, 'Ya estaba en Sube = 0 cuando lo reportaron.')))
  return out
}

// Estado del código según las páginas (lo que importa sin Manager).
function estadoWeb(f) {
  if (!f.web) return { clase: 'por_validar', texto: 'Revisando…' }
  if (f.web_a_bajar) return { clase: 'pendiente', texto: 'Sigue publicado' }
  if (f.web_error) return { clase: 'por_validar', texto: 'No se pudo revisar todo' }
  return { clase: 'procesado', texto: 'Ya no está en las páginas' }
}

const ESTADO_SITIO = {
  publicado: { clase: 'publicado', texto: 'Publicado' },
  agotado: { clase: 'no', texto: 'Agotado' },
  sin_stock: { clase: 'no', texto: 'Sin stock' },
  oculto: { clase: 'no', texto: 'Oculto' },
  no_esta: { clase: 'no', texto: 'No está' },
  error: { clase: 'error', texto: 'No se pudo revisar' },
}

/** Una fila por página: nombre, estado y link al producto si sigue publicado. */
function filasSitios(f) {
  if (!f.web) return null
  return h(
    'ul',
    { class: 'sitios' },
    sitios.map((s) => {
      const r = f.web[s.clave] || {}
      const e = ESTADO_SITIO[r.estado] || { clase: 'no', texto: r.estado || '—' }
      let extra = null
      if (r.variantes?.length) extra = `por sus variantes: ${r.variantes.join(', ')}`
      else if (r.porPadre) extra = `por el padre ${r.codigo}`
      else if (r.padrePublicado) extra = 'el padre sí está publicado'
      return h(
        'li',
        { class: 'sitio ' + e.clase, title: r.error || '' },
        h('i'),
        h('span', { class: 'sitio-nombre' }, s.nombre),
        h('span', { class: 'sitio-estado' }, e.texto, extra ? h('span', { class: 'sitio-extra' }, ` (${extra})`) : null),
        r.estado === 'publicado' && r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer', class: 'sitio-link', 'aria-label': `Ver ${f.codigo} en ${s.nombre}` }, 'Ver', icono('external')) : null
      )
    })
  )
}

function tarjeta(f) {
  const quien = f.ultimo_de ? `Reportó ${f.ultimo_de}` : 'Reportado en el grupo'
  const aBajarOtros = f.estado === 'pendiente' ? f.a_bajar.filter((c) => c !== f.codigo) : []
  const ew = estadoWeb(f)
  const nombre = f.descripcion || sitios.map((s) => f.web?.[s.clave]?.nombre || f.web?.[s.clave]?.descripcion).find(Boolean)
  return h(
    'li',
    { class: 'item ' + ew.clase },
    h('div', { class: 'item-codigo' }, h('span', { class: 'codigo' }, f.codigo, f.veces > 1 ? h('span', { class: 'veces', title: 'Veces que lo reportaron' }, `x${f.veces}`) : null)),
    h('div', { class: 'item-estado' }, h('span', { class: 'pill ' + ew.clase }, ew.texto)),
    h(
      'div',
      { class: 'item-cuerpo' },
      nombre ? h('p', { class: 'desc' }, nombre) : null,
      h('p', { class: 'meta' }, h('span', {}, quien), h('span', {}, relativo(f.ultimo_reporte))),
      filasSitios(f),
      chipsVariantes(f),
      aBajarOtros.length ? h('p', { class: 'meta' }, `Hay que bajar también: ${aBajarOtros.join(', ')}`) : null,
      notas(f)
    ),
    h(
      'div',
      { class: 'acciones-item' },
      h('button', { class: 'ghost icon-only', type: 'button', title: 'Copiar código', 'aria-label': `Copiar código ${f.codigo}`, onclick: async () => { await copiar(f.a_bajar.length ? f.a_bajar.join('\n') : f.codigo); aviso('Copiado') } }, icono('copy')),
      h('button', { class: 'ghost icon-only', type: 'button', title: 'Descartar (no es un código real)', 'aria-label': `Descartar ${f.codigo}`, onclick: () => descartar(f.codigo) }, icono('eye-off'))
    )
  )
}

const VACIOS = {
  publicados: 'Ningún código reportado sigue publicado. Todo al día.',
  no_publicados: 'Todavía no hay códigos que ya no estén en las páginas.',
  revisando: 'No hay códigos esperando revisión.',
  pendientes: 'No hay códigos pendientes. Todo al día.',
  errores: 'No hay códigos para revisar.',
  procesados: 'Todavía no hay códigos procesados.',
  todos: 'No hay códigos para mostrar.',
}

function pintarLista(filas) {
  $('lista').replaceChildren(...filas.map(tarjeta))
  $('vacio').hidden = filas.length > 0
  $('vacio-texto').textContent = q ? 'Ningún código coincide con la búsqueda.' : VACIOS[filtro]
}

async function descartar(codigo) {
  await api(`/codigos/${encodeURIComponent(codigo)}/descartar`, { method: 'POST', body: JSON.stringify({ descartado: true }) })
  aviso(`${codigo} descartado`, {
    texto: 'Deshacer',
    fn: async () => {
      await api(`/codigos/${encodeURIComponent(codigo)}/descartar`, { method: 'POST', body: JSON.stringify({ descartado: false }) })
      refrescar()
    },
  })
  refrescar()
}

// ---------- configuración ----------
/** "5493534123456" -> "+54 9 353 412-3456". Otros países: "+" y los dígitos. */
function formatearNumero(n) {
  if (!n) return null
  const m = /^549(\d{3})(\d{3})(\d{4})$/.exec(n)
  return m ? `+54 9 ${m[1]} ${m[2]}-${m[3]}` : `+${n}`
}

let gruposDisponibles = []

/** Igual que normalizarNombre de src/config.js: sin acentos, emojis ni signos, minúscula. */
const normalizar = (s) =>
  (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

const gruposDisponiblesNombre = (grupos, jid) => grupos.find((g) => g.jid === jid)?.nombre || null

function pintarConfig({ linea, grupo, detectado, disponibles }) {
  $('cfg-numero').textContent = formatearNumero(linea.numero) || 'Sin vincular todavía'
  $('cfg-linea').textContent = linea.nombre || '—'
  $('cfg-estado').replaceChildren(
    h('span', { class: 'estado-linea' }, h('i', { class: 'punto ' + (linea.conectado ? 'ok' : 'mal') }), ' ', linea.conectado ? `Conectado ${relativo(linea.desde)}` : 'Desconectado')
  )

  const origen = grupo.origen === 'panel' ? 'configurado desde este panel' : 'valor del servidor (.env)'
  // Lo que detectó el bot puede ser del grupo anterior: el listener relee la configuración cada 30 s.
  const detectadoEsElConfigurado = grupo.jid
    ? detectado.jid === grupo.jid
    : !!detectado.nombre && normalizar(detectado.nombre).includes(normalizar(grupo.nombre))
  const configurado = grupo.jid
    ? `“${gruposDisponiblesNombre(disponibles.grupos, grupo.jid) || grupo.nombre || grupo.jid}”`
    : `el que contenga “${grupo.nombre}”`
  let texto
  if (detectadoEsElConfigurado) texto = `Escuchando: “${detectado.nombre || configurado}” — ${origen}.`
  else if (detectado.jid) texto = `Configurado: ${configurado} — ${origen}. Aplicando el cambio: hasta 30 s el bot sigue escuchando “${detectado.nombre || detectado.jid}”.`
  else texto = `Configurado: ${configurado} — ${origen}. Todavía no se identificó el grupo: se resuelve con el primer mensaje que llegue.`
  $('cfg-grupo-actual').textContent = texto
  $('btn-cfg-reset').disabled = grupo.origen !== 'panel'
  $('cfg-nombre').value = grupo.nombre
  $('cfg-jid').value = grupo.jid

  gruposDisponibles = disponibles.grupos
  const sel = $('cfg-elegir')
  sel.replaceChildren(
    h('option', { value: '' }, disponibles.grupos.length ? '— Elegí un grupo —' : 'Aparecen cuando el bot se conecta'),
    ...disponibles.grupos.map((g) =>
      h('option', { value: g.jid, selected: g.jid === (grupo.jid || detectado.jid) }, g.participantes ? `${g.nombre} (${g.participantes})` : g.nombre)
    )
  )
  sel.disabled = !disponibles.grupos.length
}

// ---------- vinculación (QR) ----------
let timerQr = null
let estabaVinculado = null

/** Pinta el bloque de QR de Configuración y el aviso de la lista. Devuelve el estado. */
async function refrescarVinculacion() {
  const v = await api('/vinculacion').then((r) => r.json())
  const sinVincular = v.botVivo && !v.vinculado
  $('aviso-vincular').hidden = v.conectado
  $('aviso-vincular-texto').textContent = !v.botVivo
    ? 'El bot no está corriendo: no se están leyendo mensajes del grupo.'
    : sinVincular
      ? 'WhatsApp sin vincular: el bot no está leyendo el grupo.'
      : 'WhatsApp desconectado: el bot está reintentando solo.'
  $('btn-vincular').hidden = !sinVincular

  $('vinculacion').hidden = !sinVincular && v.botVivo
  $('qr-img').hidden = !v.qr
  if (v.qr) $('qr-img').src = v.qr
  $('qr-espera').hidden = !!v.qr
  $('qr-espera').textContent = v.botVivo ? 'Generando código…' : 'Sin código: el bot no está corriendo.'
  $('vinc-nota').textContent = v.botVivo
    ? ''
    : 'Arrancá el bot en el servidor (pm2 start baja-sube-whatsapp). Cuando esté corriendo, el código aparece acá.'

  // Recién vinculado: avisar y recargar la configuración (número, grupos de la línea).
  if (estabaVinculado === false && v.vinculado) {
    aviso('WhatsApp vinculado')
    if (!$('vista-config').hidden) pintarConfig(await api('/config').then((r) => r.json()))
  }
  estabaVinculado = v.vinculado
  return v
}

async function mostrarConfig() {
  $('vista-lista').hidden = true
  $('vista-historial').hidden = true
  $('vista-config').hidden = false
  $('cfg-error').hidden = true
  pintarConfig(await api('/config').then((r) => r.json()))
  await refrescarVinculacion()
  clearInterval(timerQr)
  // El QR cambia cada ~20 s: mientras esta pantalla esté abierta se consulta seguido.
  timerQr = setInterval(() => !document.hidden && refrescarVinculacion().catch(() => {}), 3000)
}

function mostrarLista() {
  clearInterval(timerQr)
  $('vista-config').hidden = true
  $('vista-historial').hidden = true
  $('vista-lista').hidden = false
  refrescar().catch(() => {})
}

// ---------- consultar un código a mano ----------
async function consultarCodigo(codigo, agregar = false) {
  const caja = $('consulta-resultado')
  const boton = $('btn-consultar')
  boton.disabled = true
  caja.hidden = false
  caja.replaceChildren(h('p', { class: 'muted' }, `Buscando ${codigo} en las páginas…`))
  try {
    const resp = await api('/consultar', { method: 'POST', body: JSON.stringify({ codigo, agregar }) })
    const datos = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      caja.replaceChildren(h('div', { class: 'nota error' }, icono('alert'), h('span', {}, datos.error || 'No se pudo consultar.')))
      return
    }
    if (datos.sitios?.length) sitios = datos.sitios
    const r = datos.resultado
    // Misma forma que una fila de la lista, para reusar las filas por página.
    const fila = { codigo: datos.codigo, web: r, web_a_bajar: r.aBajar ? 1 : 0, web_error: r.conError ? 1 : 0 }
    const nombre = sitios.map((s) => r[s.clave]?.nombre || r[s.clave]?.descripcion).find(Boolean)
    const titular = r.aBajar
      ? `Sigue publicado en: ${r.publicadoEn.map((k) => sitios.find((s) => s.clave === k)?.nombre || k).join(', ')}`
      : r.conError
        ? 'No se pudo revisar alguna página (las demás se ven abajo)'
        : 'No está publicado en ninguna página'
    const acciones = []
    if (datos.agregado) acciones.push(h('p', { class: 'muted' }, 'Agregado a la lista: el bot lo sigue revisando y queda en el historial.'))
    else if (datos.enLista) acciones.push(h('p', { class: 'muted' }, 'Este código ya está en la lista.'))
    else {
      acciones.push(
        h('button', { class: 'secondary', type: 'button', onclick: () => consultarCodigo(datos.codigo, true) }, icono('history'), h('span', {}, 'Agregar a la lista y seguirlo'))
      )
    }
    caja.replaceChildren(
      h(
        'article',
        { class: 'consulta-tarjeta ' + estadoWeb(fila).clase },
        h('div', { class: 'consulta-cabeza' }, h('span', { class: 'codigo' }, datos.codigo), h('span', { class: 'pill ' + estadoWeb(fila).clase }, titular)),
        nombre ? h('p', { class: 'desc' }, nombre) : null,
        filasSitios(fila),
        ...acciones
      )
    )
    if (datos.agregado) refrescar().catch(() => {})
  } finally {
    boton.disabled = false
  }
}

$('form-consulta').addEventListener('submit', (e) => {
  e.preventDefault()
  const codigo = $('consulta-codigo').value.trim().toUpperCase().replace(/\s+/g, '')
  if (!codigo) return $('consulta-codigo').focus()
  $('consulta-codigo').value = codigo
  consultarCodigo(codigo)
})

// ---------- historial de bajas ----------
let hTipo = 'bajas'
let hQ = ''

const EVENTOS = {
  baja: { clase: 'procesado', texto: 'Dado de baja' },
  seguia_publicado: { clase: 'pendiente', texto: 'Seguía publicado al reportarlo' },
  ya_no_estaba: { clase: 'por_validar', texto: 'Ya no estaba al reportarlo' },
  reaparecio: { clase: 'no_existe', texto: 'Volvió a aparecer' },
}
const ESTADO_FINAL = { no_esta: 'ya no está', agotado: 'quedó agotado', oculto: 'quedó oculto', sin_stock: 'quedó sin stock', publicado: 'publicado' }

/** 3_600_000 -> "1 h"; 5_400_000 -> "1 h 30 min"; 2 días y pico -> "2 d 3 h". */
function duracion(ms) {
  if (ms == null || ms < 0) return null
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
  return `${Math.floor(h / 24)} d ${h % 24} h`
}

function etiquetaDia(iso) {
  const d = new Date(iso)
  const hoy = new Date()
  const ayer = new Date(Date.now() - 86_400_000)
  if (d.toDateString() === hoy.toDateString()) return 'Hoy'
  if (d.toDateString() === ayer.toDateString()) return 'Ayer'
  return d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })
}

function filaHistorial(e) {
  const ev = EVENTOS[e.tipo] || { clase: 'por_validar', texto: e.tipo }
  const pagina = sitios.find((s) => s.clave === e.sitio)?.nombre || e.sitio
  const hora = new Date(e.ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })
  const detalle = []
  if (e.tipo === 'baja' || e.tipo === 'reaparecio') detalle.push(`${pagina}: ${ESTADO_FINAL[e.estado] || e.estado}`)
  else detalle.push(pagina)
  if (e.primer_de) detalle.push(`reportó ${e.primer_de}`)
  const tardo = duracion(e.demora_ms)
  if (tardo) detalle.push(`tardó ${tardo} desde el reporte`)
  return h(
    'li',
    { class: 'hist-item ' + ev.clase },
    h('span', { class: 'hist-hora mono' }, hora),
    h(
      'div',
      { class: 'hist-cuerpo' },
      h('p', { class: 'hist-titulo' }, h('span', { class: 'codigo-chico mono' }, e.codigo), e.nombre ? h('span', { class: 'hist-nombre' }, e.nombre) : null),
      h('p', { class: 'meta' }, h('span', { class: 'pill ' + ev.clase }, ev.texto), ...detalle.map((d) => h('span', {}, d)))
    )
  )
}

async function refrescarHistorial() {
  const periodo = $('h-periodo').value
  const { eventos, resumen } = await api(`/historial?tipo=${hTipo}&periodo=${periodo}&q=${encodeURIComponent(hQ)}`).then((r) => r.json())
  $('h-hoy').textContent = resumen.bajasHoy
  $('h-semana').textContent = resumen.bajasSemana
  $('h-demora').textContent = duracion(resumen.demoraPromedioMs) || '—'

  // Agrupado por día, del más nuevo al más viejo (el servidor ya los manda ordenados).
  const grupos = []
  for (const e of eventos) {
    const dia = etiquetaDia(e.ts)
    if (grupos.at(-1)?.dia !== dia) grupos.push({ dia, eventos: [] })
    grupos.at(-1).eventos.push(e)
  }
  $('h-lista').replaceChildren(
    ...grupos.map((g) => h('section', { class: 'hist-dia' }, h('h3', {}, g.dia, h('span', { class: 'muted' }, ` · ${g.eventos.length}`)), h('ul', {}, g.eventos.map(filaHistorial))))
  )
  $('h-vacio').hidden = eventos.length > 0
  $('h-vacio-texto').textContent = hQ
    ? 'Ningún movimiento de ese código en el período.'
    : hTipo === 'bajas'
      ? 'Todavía no hay bajas en este período. Aparecen cuando un código reportado deja de estar en una página.'
      : 'Todavía no hay movimientos en este período.'
}

async function mostrarHistorial() {
  clearInterval(timerQr)
  $('vista-lista').hidden = true
  $('vista-config').hidden = true
  $('vista-historial').hidden = false
  if (!sitios.length) await refrescar().catch(() => {}) // trae los nombres de las páginas
  await refrescarHistorial()
}

$('btn-historial').addEventListener('click', () => mostrarHistorial())
$('h-tipo').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tipo]')
  if (!b) return
  hTipo = b.dataset.tipo
  for (const t of $('h-tipo').querySelectorAll('button')) t.setAttribute('aria-selected', String(t === b))
  refrescarHistorial()
})
$('h-periodo').addEventListener('change', () => refrescarHistorial())
let esperaHistorial
$('h-q').addEventListener('input', (e) => {
  clearTimeout(esperaHistorial)
  esperaHistorial = setTimeout(() => {
    hQ = e.target.value.trim()
    refrescarHistorial()
  }, 250)
})
$('btn-h-csv').addEventListener('click', () => {
  window.location.href = `/api/historial.csv?tipo=${hTipo}&periodo=${$('h-periodo').value}&q=${encodeURIComponent(hQ)}`
})

async function guardarGrupo(metodo, cuerpo) {
  const error = $('cfg-error')
  error.hidden = true
  const resp = await api('/config/grupo', { method: metodo, body: JSON.stringify(cuerpo || {}) })
  const datos = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    error.textContent = datos.error || 'No se pudo guardar'
    error.hidden = false
    return
  }
  pintarConfig(datos)
  aviso(metodo === 'DELETE' ? 'Se usa el grupo del servidor' : 'Grupo guardado. El bot lo toma en menos de 30 s')
}

$('btn-config').addEventListener('click', () => mostrarConfig())
$('btn-vincular').addEventListener('click', () => mostrarConfig())
for (const b of document.querySelectorAll('.btn-volver')) b.addEventListener('click', mostrarLista)

$('cfg-elegir').addEventListener('change', (e) => {
  const g = gruposDisponibles.find((x) => x.jid === e.target.value)
  if (!g) return
  $('cfg-nombre').value = g.nombre
  $('cfg-jid').value = g.jid
})

$('form-grupo').addEventListener('submit', (e) => {
  e.preventDefault()
  guardarGrupo('PUT', { nombre: $('cfg-nombre').value, jid: $('cfg-jid').value })
})

$('btn-cfg-reset').addEventListener('click', () => guardarGrupo('DELETE'))

// ---------- eventos ----------
$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault()
  const error = $('login-error')
  error.hidden = true
  const resp = await api('/login', { method: 'POST', body: JSON.stringify({ clave: $('clave').value }) })
  if (resp.ok) {
    $('clave').value = ''
    mostrarApp()
  } else {
    error.textContent = (await resp.json().catch(() => ({}))).error || 'No se pudo ingresar'
    error.hidden = false
  }
})

$('btn-salir').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {})
  mostrarLogin()
})

$('btn-copiar').addEventListener('click', async () => {
  const { codigos } = await api('/publicados').then((r) => r.json())
  if (!codigos.length) return aviso('No hay códigos publicados')
  const nombres = Object.fromEntries(sitios.map((s) => [s.clave, s.nombre]))
  await copiar(codigos.map((c) => `${c.codigo} — ${c.publicadoEn.map((k) => nombres[k] || k).join(', ')}`).join('\n'))
  aviso(`${codigos.length} código(s) copiados`)
})

$('btn-csv').addEventListener('click', () => {
  window.location.href = `/api/exportar.csv?filtro=${filtro}`
})

$('btn-refrescar').addEventListener('click', async () => {
  const b = $('btn-refrescar')
  b.disabled = true
  try {
    await api('/revalidar', { method: 'POST', body: '{}' })
    await new Promise((r) => setTimeout(r, 4000)) // el listener vuelve a revisar en pocos segundos
    await refrescar()
    aviso('Revisando las páginas otra vez: se completa en unos segundos')
  } finally {
    b.disabled = false
  }
})

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-filtro]')
  if (!b) return
  filtro = b.dataset.filtro
  for (const t of $('tabs').querySelectorAll('button')) t.setAttribute('aria-selected', String(t === b))
  refrescar()
})

let esperaBusqueda
$('q').addEventListener('input', (e) => {
  clearTimeout(esperaBusqueda)
  esperaBusqueda = setTimeout(() => {
    q = e.target.value.trim()
    refrescar()
  }, 250)
})

// ---------- arranque ----------
const { autenticado } = await fetch('/api/sesion', { credentials: 'same-origin' }).then((r) => r.json())
autenticado ? mostrarApp() : mostrarLogin()
