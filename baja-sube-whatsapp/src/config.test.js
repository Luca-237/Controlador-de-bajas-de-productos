import { test } from 'node:test'
import assert from 'node:assert/strict'
import { abrirDb } from './db.js'
import {
  leerConfigGrupo, guardarConfigGrupo, borrarConfigGrupo, coincideGrupo, guardarGruposDisponibles, leerGruposDisponibles, JID_GRUPO,
} from './config.js'

test('sin configuración del panel vale el .env (y si no hay, el nombre por defecto)', () => {
  const db = abrirDb(':memory:')
  assert.deepEqual(leerConfigGrupo(db, { GRUPO_NOMBRE: 'Bajas', GRUPO_JID: '120363025246125486@g.us' }), {
    nombre: 'Bajas', jid: '120363025246125486@g.us', origen: 'env',
  })
  assert.deepEqual(leerConfigGrupo(db, {}), { nombre: 'Código que no hay más', jid: '', origen: 'env' })
})

test('lo guardado en el panel le gana al .env; borrar vuelve al .env', () => {
  const db = abrirDb(':memory:')
  guardarConfigGrupo(db, { nombre: '  Bajas Depósito  ', jid: '' })
  assert.deepEqual(leerConfigGrupo(db, { GRUPO_NOMBRE: 'Otro' }), { nombre: 'Bajas Depósito', jid: '', origen: 'panel' })
  borrarConfigGrupo(db)
  assert.equal(leerConfigGrupo(db, { GRUPO_NOMBRE: 'Otro' }).origen, 'env')
})

test('validaciones con mensajes para el panel', () => {
  const db = abrirDb(':memory:')
  assert.throws(() => guardarConfigGrupo(db, {}), /nombre del grupo o su JID/)
  assert.throws(() => guardarConfigGrupo(db, { nombre: 'ab' }), /entre 3 y 100/)
  assert.throws(() => guardarConfigGrupo(db, { nombre: '⚠️⚠️⚠️' }), /letra o número/)
  assert.throws(() => guardarConfigGrupo(db, { jid: '5493534123456@s.whatsapp.net' }), /forma de grupo/)
  assert.throws(() => guardarConfigGrupo(db, { jid: "1203630252461@g.us' OR 1=1" }), /forma de grupo/)
  assert.equal(leerConfigGrupo(db, {}).origen, 'env') // nada inválido quedó guardado
})

test('formatos de JID de grupo', () => {
  assert.ok(JID_GRUPO.test('120363025246125486@g.us'))
  assert.ok(JID_GRUPO.test('5493534123456-1609459200@g.us'))
  assert.ok(!JID_GRUPO.test('5493534123456@s.whatsapp.net')) // chat 1:1, no grupo
  assert.ok(!JID_GRUPO.test('abc@g.us'))
})

test('coincidencia: con JID manda el JID; si no, nombre "contiene" sin acentos ni emojis', () => {
  const porNombre = { nombre: 'Código que no hay más', jid: '' }
  assert.ok(coincideGrupo(porNombre, 'x@g.us', '⚠️ CODIGO QUE NO HAY MAS'))
  assert.ok(coincideGrupo(porNombre, 'x@g.us', 'Código que no hay más - Central'))
  assert.ok(!coincideGrupo(porNombre, 'x@g.us', 'Depósito Central'))
  assert.ok(!coincideGrupo(porNombre, 'x@g.us', undefined))
  const porJid = { nombre: 'Código que no hay más', jid: '120363025246125486@g.us' }
  assert.ok(coincideGrupo(porJid, '120363025246125486@g.us', 'Le cambiaron el nombre'))
  assert.ok(!coincideGrupo(porJid, '999999999999999999@g.us', 'Código que no hay más'))
})

test('grupos disponibles: solo nombre, JID y cantidad, ordenados', () => {
  const db = abrirDb(':memory:')
  guardarGruposDisponibles(db, [
    { id: '2@g.us', subject: 'Zeta', participants: [{}, {}] },
    { id: '1@g.us', subject: 'Árbol', participants: [{ id: 'privado' }] },
  ])
  const { grupos, actualizado } = leerGruposDisponibles(db)
  assert.deepEqual(grupos, [
    { jid: '1@g.us', nombre: 'Árbol', participantes: 1 },
    { jid: '2@g.us', nombre: 'Zeta', participantes: 2 },
  ])
  assert.ok(actualizado)
})

test('QR: se publica, vence al minuto y se borra al conectar', async () => {
  const { publicarQr, leerQr, borrarQr } = await import('./config.js')
  const db = abrirDb(':memory:')
  assert.equal(leerQr(db), null)
  publicarQr(db, '2@abc,def', new Date('2026-10-28T12:00:00.000Z'))
  assert.equal(leerQr(db, Date.parse('2026-10-28T12:00:30.000Z')).qr, '2@abc,def')
  assert.equal(leerQr(db, Date.parse('2026-10-28T12:01:01.000Z')), null) // vencido
  publicarQr(db, '2@nuevo', new Date('2026-10-28T12:02:00.000Z'))
  borrarQr(db)
  assert.equal(leerQr(db, Date.parse('2026-10-28T12:02:01.000Z')), null)
})
