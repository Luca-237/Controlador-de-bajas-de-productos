/**
 * PM2: mantiene el bot y el panel corriendo siempre, aunque nadie tenga una terminal abierta.
 * Si un proceso se cae, PM2 lo vuelve a levantar; con `pm2 save` + `pm2 startup` arrancan solos al
 * reiniciar el servidor. Pasos completos en DEPLOY.md.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * Nombres distintos a los del bot que ya corre en el VPS (baja-sube-whatsapp / baja-sube-panel),
 * para que las dos versiones puedan convivir sin pisarse.
 */
const comun = {
  cwd: __dirname, // el .env, la base, los logs y la sesión de WhatsApp se resuelven desde acá
  autorestart: true,
  max_restarts: 50,
  min_uptime: '30s', // si se cae antes de 30 s cuenta como arranque fallido
  exp_backoff_restart_delay: 2000, // reintentos espaciados si algo falla en loop (ej. sin internet)
  max_memory_restart: '400M',
  time: true, // fecha y hora en cada línea del log
  env: { NODE_ENV: 'production' },
}

module.exports = {
  apps: [
    {
      ...comun,
      name: 'bajas-cindy-bot',
      script: 'src/index.js', // listener de WhatsApp + revisión de páginas
      kill_timeout: 10000, // le da tiempo a cerrar la sesión de WhatsApp prolijo
    },
    {
      ...comun,
      name: 'bajas-cindy-panel',
      script: 'src/panel/server.js', // panel web (si se cae, el bot sigue escuchando)
    },
  ],
}
