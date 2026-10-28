#!/usr/bin/env bash
# Instala o actualiza el bot de bajas en el Cloud Server de DonWeb (Ubuntu).
# Uso, parado en la carpeta del proyecto en el servidor:  bash deploy/instalar.sh
# Se puede correr las veces que haga falta: no toca .env, data/, logs/ ni auth/.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Carpeta: $(pwd)"

# 1. Node 22.5 o más nuevo (la base usa node:sqlite).
NODE_V=$(node -v | sed 's/^v//')
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)"; then
  echo "!! Node $NODE_V es viejo: hace falta 22.5 o más. Actualizarlo antes de seguir (ver DEPLOY.md)." >&2
  exit 1
fi
echo "== Node $NODE_V OK"

# 2. PM2.
if ! command -v pm2 >/dev/null; then
  echo "!! Falta PM2: npm install -g pm2" >&2
  exit 1
fi

# 3. Dependencias y tests.
npm install --omit=dev --no-audit --no-fund
npm test

# 4. Configuración: se completa a mano la primera vez.
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo
  echo "!! Se creó .env a partir de .env.example. Completalo y volvé a correr este script:"
  echo "   nano .env              (PANEL_PORT=3011, DB_PATH=./data/bajas.db, TIENDANUBE_CLAVE_TIENDA=...)"
  echo "   npm run set-password   (clave del panel; en el .env queda solo el hash)"
  exit 0
fi
if ! grep -q '^PANEL_PASSWORD_HASH=.\+' .env; then
  echo "!! Falta la clave del panel: corré  npm run set-password  y volvé a correr este script." >&2
  exit 1
fi
chmod 600 .env

# 5. Arrancar o recargar con PM2 y dejarlo guardado para que vuelva solo tras un reinicio.
if pm2 describe bajas-cindy-bot >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi
pm2 save
pm2 list
echo
echo "== Listo. Panel en 127.0.0.1:$(grep '^PANEL_PORT=' .env | cut -d= -f2) (afuera, por nginx). Logs: pm2 logs bajas-cindy-bot"
