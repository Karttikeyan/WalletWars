// Entry point serverless para Vercel.
// Único archivo dentro de /api — Vercel trata cada .js suelto en /api
// como su propia ruta, así que el resto del backend vive en /lib
// (server.js, routes.js, etc.) y no en /api, para evitar colisiones
// de enrutamiento (ej. /api/combat coincidiendo con lib/combat.js).
module.exports = require('../lib/server');
