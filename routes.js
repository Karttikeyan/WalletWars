// ============================================================
//  WalletWars · Rutas API (la web = primer cliente del motor)
//  Monta en server.js:  app.use('/api', require('./routes'));
//  Nota: estos endpoints solo exponen proyecciones públicas.
//  El forge real (lectura on-chain + scoring) ya vive en server.js;
//  aquí se enseña dónde engancha el persistir (db.forgeCombatant).
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('./supabaseService');

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: e.message }); });

// ── Tableros ────────────────────────────────────────────────
router.get('/leaderboard/power',  wrap(async (req, res) =>
  res.json(await db.getPowerBoard(Number(req.query.limit) || 100))));

router.get('/leaderboard/season', wrap(async (req, res) =>
  res.json(await db.getSeasonBoard(Number(req.query.limit) || 100))));

// ── Combatiente público por nombre ──────────────────────────
router.get('/combatant/:name', wrap(async (req, res) =>
  res.json(await db.getCombatantPublic(req.params.name))));

// ── Battle Plan (defensa async) ─────────────────────────────
// body: { slot?, cardOrder:[0..4]*5, wildcard?, timing? }
router.post('/battle-plan/:combatantId', wrap(async (req, res) =>
  res.json(await db.saveBattlePlan(req.params.combatantId, req.body))));

router.get('/battle-plan/:combatantId', wrap(async (req, res) =>
  res.json(await db.getActiveBattlePlan(req.params.combatantId, Number(req.query.slot) || 1))));

// ── Revanchas / notificaciones ──────────────────────────────
router.get('/matches/incoming/:combatantId', wrap(async (req, res) =>
  res.json(await db.getIncomingMatches(req.params.combatantId, Number(req.query.limit) || 20))));
// ── REGISTRAR combatiente (consultar vs registrar · POST) ──
// Recalcula stats vía el propio GET (una sola fuente de scoring),
// valida nombre único, y persiste con forgeCombatant (upsert).
router.post('/combatant', requireAuth, wrap(async (req, res) => {
  const { address, name, handle } = req.body || {};
  if (!/^0x[a-fA-F0-9]{40}$/.test(address || ''))
    return res.status(400).json({ error: 'address no valida' });
  if (address.toLowerCase() !== req.auth.address.toLowerCase())
    return res.status(403).json({ error: 'la address no coincide con la sesion' });
  if (!name || name.trim().length < 3 || name.trim().length > 24)
    return res.status(400).json({ error: 'name debe tener 3-24 caracteres' });

  // recalcula stats on-chain reutilizando el GET stateless
  const r = await fetch(`http://localhost:${process.env.PORT || 3000}/api/wallet/${address}`);
  const w = await r.json();
  if (w.error) return res.status(502).json({ error: 'no se pudo leer la wallet on-chain' });

  try {
    const card = await db.forgeCombatant({
      address,
      name: name.trim(),
      handle: handle ? handle.trim() : null,
      stats: {
        txCount: w.txCount, ageDays: w.ageDays, uniqueContracts: w.uniqueContracts,
        realTokenCount: w.realTokenCount, gasBurnedUsd: w.gasBurnedUsd, netWorthUsd: w.netWorth,
      },
      scores: w.scores,
      walletPower: w.walletPower,
    });
    res.json({ ok: true, card });
  } catch (e) {
    // Nombre ya cogido → conflicto de usuario, no error de servidor
    if (e.code === '23505') {
      return res.status(409).json({ error: 'ese nombre de combatiente ya esta cogido' });
    }
    console.error('FORGE ERROR >>>', e);
    return res.status(500).json({ error: 'no se pudo forjar el combatiente' });
  }
}));
// ── COMBATE · resuelve un duelo best-of-5 y lo persiste ─────
// body: { attackerName, defenderName }
// Carga ambas fichas → resolveCombat → recordMatch (ELO + rango).
// v1 abierta (sin cooldown ni Battle Plan): ideal para pruebas.
const combat = require('./combat');

router.post('/combat', wrap(async (req, res) => {
  const { attackerName, defenderName } = req.body || {};
  if (!attackerName || !defenderName)
    return res.status(400).json({ error: 'faltan attackerName y/o defenderName' });
  if (attackerName.trim().toLowerCase() === defenderName.trim().toLowerCase())
    return res.status(400).json({ error: 'un combatiente no puede pelear consigo mismo' });

  // fichas COMPLETAS (backend) — necesitamos scores + wallet_power + id + elo
  let attacker, defender;
  try {
    attacker = await db.getCombatantByName(attackerName.trim());
    defender = await db.getCombatantByName(defenderName.trim());
  } catch (e) {
    return res.status(404).json({ error: 'combatiente no encontrado' });
  }

  // Battle Plan del defensor (si tiene uno activo) → orden de cartas + comodín
  const plan = await db.getActiveBattlePlan(defender.id);
  let defenderPlan = null;
  if (plan) {
    defenderPlan = {
      cardOrder: plan.card_order,
      wildcard: plan.wildcard,
      wildcardUnlocked: db.isWildcardUnlocked(defender, plan.wildcard),
    };
  }

  // resolución pura (best-of-5), con Battle Plan del defensor si existe
  const { winner, score, rounds } = combat.resolveCombat(attacker, defender, defenderPlan);
  const winnerId = winner === 'a' ? attacker.id : defender.id;

  // persiste + ELO + rango (atómico vía RPC)
  const matchId = await db.recordMatch({ attacker, defender, winnerId, score, rounds });

  res.json({
    ok: true,
    matchId,
    winner: winner === 'a' ? attacker.combatant_name : defender.combatant_name,
    score,
    rounds,
  });
}));
/*  ── DÓNDE ENGANCHA EL FORGE (en tu endpoint existente de server.js) ──
    Tras leer on-chain y calcular notas + wallet_power, persiste:

      const card = await db.forgeCombatant({
        address, name, handle,
        stats:      { txCount, ageDays, uniqueContracts, realTokenCount, gasBurnedUsd, netWorthUsd },
        scores:     { tx, age, contracts, diversification, gas },
        walletPower,
      });
      // `card` ya es la proyección pública (sin address ni notas sueltas)
*/

// ── AUTH (SIWE) ──────────────────────────────────────────────
// GET  /api/auth/nonce/:address  → { nonce }
// POST /api/auth/verify          → { message, signature } → { ok, token, address }
const auth = require('./auth');

// ── MIDDLEWARE · requiere sesion valida (JWT) ───────────────
// Lee "Authorization: Bearer <token>", lo verifica, y mete req.auth = { address }.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'falta token de sesion' });

  try {
    const payload = auth.verifySessionToken(token);
    req.auth = { address: payload.address };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'sesion invalida o expirada' });
  }
}

router.get('/auth/nonce/:address', wrap(async (req, res) => {
  const { address } = req.params;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address || ''))
    return res.status(400).json({ error: 'address no valida' });

  const nonce = await auth.generateNonce(db.supabase, address);
  res.json({ nonce });
}));

router.post('/auth/verify', wrap(async (req, res) => {
  const { message, signature } = req.body || {};
  if (!message || !signature)
    return res.status(400).json({ error: 'faltan message y/o signature' });

  try {
    const { address } = await auth.verifySiweMessage(db.supabase, message, signature);
    const token = auth.createSessionToken(address);
    res.json({ ok: true, token, address });
  } catch (e) {
    return res.status(401).json({ error: e.message });
  }
}));

module.exports = router;
