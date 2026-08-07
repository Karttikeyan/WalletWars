// Entry point serverless para Vercel.
// Reutiliza el mismo Express app que corre en local (server.js),
// sin duplicar lógica.
module.exports = require('./server');
