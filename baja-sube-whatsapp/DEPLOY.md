# Despliegue en DonWeb — Bajas de e-commerce (Cindy Mayorista)

Dos procesos que tienen que estar **siempre** corriendo, sin ninguna PC prendida:

| Proceso PM2 | Qué hace |
|---|---|
| `bajas-cindy-bot` | Escucha el grupo de WhatsApp, guarda los códigos y revisa en qué páginas siguen publicados (web de Cindy en Tiendanube, catálogo y tienda de Travel Blue). |
| `bajas-cindy-panel` | Panel web con login: lista, historial de bajas, configuración y QR para vincular WhatsApp. |

## Dónde va cada cosa en DonWeb

- **El bot y el panel → Cloud Server (VPS) de DonWeb** de la cuenta de Cindy (Ubuntu + Node + PM2 + nginx). Es el mismo servidor de `tareas.bagsstore.com.ar`, Odoo y el bot de bajas actual (`baja-sube-whatsapp`). Esta versión usa **otros nombres de proceso, otra carpeta (`/root/bajas-cindy`) y otro puerto (3011)**: convive con lo que ya hay sin tocarlo.
- **El subdominio → zona DNS de `bagsstore.com.ar` en Ferozo.** El hosting Ferozo es compartido para PHP: no puede tener un proceso de Node corriendo siempre, así que el bot no puede ir ahí. De Ferozo se usa solo el DNS, igual que con `tareas.bagsstore.com.ar`.

## Antes de empezar

- Acceso SSH al Cloud Server: IP, puerto y usuario (los tiene Mauricio; están en el gestor de contraseñas). Abajo figuran como `<IP>` y `<PUERTO>`.
- Acceso al panel de Ferozo de `bagsstore.com.ar`.
- La contraseña de acceso de la tienda de Tiendanube (mientras siga en modo construcción).
- El teléfono de la empresa que está dentro del grupo "Código que no hay más".
- El paquete armado en tu PC: `npm run empaquetar` → `dist/bajas-cindy-AAAA-MM-DD.tar.gz`.

El subdominio de ejemplo es **`bajas-web.bagsstore.com.ar`** (`bajas.bagsstore.com.ar` está reservado para el panel del bot actual). Si elegís otro, cambialo en los pasos 1 y 4 y en `deploy/nginx-bajas.conf`.

---

## Paso 1 — Subdominio en Ferozo (DNS)

1. Entrá a `ferozo.host` (cuenta de `bagsstore.com.ar`) → **Dominios / Zona DNS** de `bagsstore.com.ar`.
2. **Agregar registro** tipo **A**:
   - Nombre: **`bajas-web.bagsstore.com.ar`**. Va el nombre completo: el campo rechaza solo `bajas-web`, como pasó con `tareas`.
   - Valor / IP: `<IP>` del Cloud Server.
   - TTL: `14400`.
3. Guardá y verificá desde tu PC (puede tardar unos minutos):
   ```bash
   nslookup bajas-web.bagsstore.com.ar
   ```
   Tiene que devolver la IP del Cloud Server.

## Paso 2 — Subir el paquete al servidor

Desde tu PC, en la carpeta del proyecto (Windows ya trae `scp`):
```bash
scp -P <PUERTO> dist/bajas-cindy-AAAA-MM-DD.tar.gz root@<IP>:/root/
```

## Paso 3 — Instalar en el servidor

```bash
ssh -p <PUERTO> root@<IP>
mkdir -p /root/bajas-cindy && cd /root/bajas-cindy
tar -xzf /root/bajas-cindy-AAAA-MM-DD.tar.gz
node -v                      # tiene que ser 22.5 o más nuevo
bash deploy/instalar.sh      # la primera vez crea el .env y se detiene
nano .env                    # completar (ver abajo) y guardar con Ctrl+O, salir con Ctrl+X
npm run set-password         # clave del panel: se tipea dos veces, no se ve; en el .env queda solo el hash
bash deploy/instalar.sh      # ahora instala, corre los tests y arranca con PM2
```

En el `.env` del servidor:
| Variable | Valor |
|---|---|
| `PANEL_PORT` | **`3011`** (el 3010 lo usa el panel del bot actual) |
| `DB_PATH` | `./data/bajas.db` |
| `TIENDANUBE_CLAVE_TIENDA` | la contraseña de acceso de la tienda (vacío si la tienda ya está abierta) |
| `GRUPO_NOMBRE` | `Código que no hay más` (se puede cambiar después desde el panel) |

`instalar.sh` también corre `pm2 save`. Si es la primera vez que se usa PM2 en el servidor (no es el caso de este VPS), además: `pm2 startup` y seguir lo que indique.

Si Node es viejo, para actualizarlo: `curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt install -y nodejs`. Ojo: es el Node de todo el servidor y también lo usan gestor-tareas y el bot actual, así que coordinarlo con Mauricio antes.

## Paso 4 — Publicar el panel con HTTPS (nginx)

```bash
cp /root/bajas-cindy/deploy/nginx-bajas.conf /etc/nginx/sites-available/bajas-cindy
ln -s /etc/nginx/sites-available/bajas-cindy /etc/nginx/sites-enabled/bajas-cindy
nginx -t                     # tiene que decir "syntax is ok"; si no, NO recargar
systemctl reload nginx
certbot --nginx -d bajas-web.bagsstore.com.ar
```
Es un archivo nuevo de nginx, no se edita ninguno de los existentes. `nginx -t` antes de recargar evita tirar los otros sitios por un error de tipeo.

## Paso 5 — Vincular WhatsApp

1. Entrá a `https://bajas-web.bagsstore.com.ar` con la clave del paso 3.
2. Aparece el aviso "WhatsApp sin vincular" → **Vincular**. Se ve el QR.
3. En el teléfono de la empresa: WhatsApp → **Dispositivos vinculados** → **Vincular un dispositivo** → escanear.
4. En **Configuración** → "Grupo que se escucha": elegí el grupo de la lista y **Guardar**, así queda fijado por su identificador y no depende del nombre.
5. **Apagá la versión de prueba de tu PC**: cortá el bot (Ctrl+C en su terminal) y en el teléfono → Dispositivos vinculados → cerrá la sesión del dispositivo de la PC, para que no queden dos bots leyendo el mismo grupo.

## Paso 6 — Verificar

```bash
pm2 list                                         # bajas-cindy-bot y bajas-cindy-panel en "online"
pm2 logs bajas-cindy-bot --lines 30 --nostream   # "Conectado como …" y "Grupo objetivo identificado"
```
En el panel: arriba tiene que decir "Bot conectado". Cuando llegue un código al grupo, aparece en la lista en unos segundos.

---

## Actualizar a una versión nueva

En tu PC: `npm run empaquetar` y `scp` del paquete nuevo (paso 2). En el servidor:
```bash
cd /root/bajas-cindy && tar -xzf /root/bajas-cindy-AAAA-MM-DD.tar.gz && bash deploy/instalar.sh
```
No se pisan `.env`, `data/`, `logs/` ni `auth/`: no hay que volver a vincular WhatsApp.

## Volver atrás (sacarlo del servidor)

```bash
pm2 delete bajas-cindy-bot bajas-cindy-panel && pm2 save
rm /etc/nginx/sites-enabled/bajas-cindy && nginx -t && systemctl reload nginx
```
Y borrar el registro A en Ferozo. Los datos quedan en `/root/bajas-cindy/data` hasta que se borre la carpeta.

## Operación diaria

| Para… | Comando |
|---|---|
| Ver si están vivos | `pm2 list` |
| Ver los últimos logs | `pm2 logs bajas-cindy-bot --lines 50 --nostream` |
| Reiniciar | `pm2 restart bajas-cindy-bot bajas-cindy-panel` |
| Frenar todo | `pm2 stop bajas-cindy-bot bajas-cindy-panel` |

**Nunca se suben ni se comparten:** `.env`, `data/` (base y clave de sesiones del panel), `logs/` y `auth/` (la sesión de WhatsApp: equivale a tener el teléfono vinculado).

**Cambiar el número de WhatsApp:** desde el teléfono vinculado, *Dispositivos vinculados* → cerrar la sesión del bot. El bot borra la sesión vieja solo y el panel muestra un QR nuevo.

**No correr en el servidor** `npm run seed-local`: carga datos de prueba y escribe un `estado.json` falso.
