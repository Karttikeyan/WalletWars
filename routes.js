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
router.post('/combatant', wrap(async (req, res) => {
  const { address, name, handle } = req.body || {};
  if (!/^0x[a-fA-F0-9]{40}$/.test(address || ''))
    return res.status(400).json({ error: 'address no valida' });
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
    console.error('FORGE ERROR >>>', e);
    return res.status(500).json({
      error_real: e.message,
      code: e.code || null,
      details: e.details || null,
      hint: e.hint || null,
    });
  }
}));
module.exports = router;

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
