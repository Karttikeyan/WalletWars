// ============================================================
//  WalletWars · Capa de servicio Supabase (API-first)
//  server.js es el primer cliente. Nada de address ni notas
//  crudas sale por los métodos "public". Service key ⇒ solo backend.
//  CommonJS. Si tu proyecto es ESM ("type":"module"), cambia
//  require/module.exports por import/export.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,           // service role · NUNCA en el frontend
  {
    auth: { persistSession: false },
    realtime: { transport: ws },
  }
);

// Columnas que SÍ pueden salir al exterior
const PUBLIC_COLS = 'id, combatant_name, handle, rank, wins, losses, wallet_power, elo, founders_badge';

// ── ELO (skill, no cartera) ─────────────────────────────────
// Estándar. Arranque 1000. El delta depende del RIVAL.
const K = 32;
function eloDeltas(winnerElo, loserElo) {
  const expW = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const winnerDelta = Math.round(K * (1 - expW));
  const loserDelta  = -winnerDelta;               // suma cero
  return { winnerDelta, loserDelta };
}

// ── Rango por banda de ELO (pegajoso) ───────────────────────
// Legend NO es banda: es top-N del Season Board (se asigna aparte).
// Umbrales provisionales · a calibrar con datos.
function rankFromElo(elo) {
  if (elo >= 1400) return 'diamond';
  if (elo >= 1250) return 'gold';
  if (elo >= 1100) return 'silver';
  return 'bronze';
}

async function activeSeasonId() {
  const { data, error } = await supabase
    .from('seasons').select('id').eq('is_active', true).single();
  if (error) throw error;
  return data.id;
}

// ============================================================
//  FORGE · crea o actualiza un combatiente
//  Espera notas + wallet_power YA calculados por el pipeline de
//  scoring existente (curva saturante en server.js). Aquí solo persiste.
//  Devuelve la proyección PÚBLICA (sin address, sin notas sueltas).
// ============================================================
// Cierre de "Season 1 — Founders Run": quien forje su Combat Card
// antes de esta fecha recibe founders_badge=true de forma permanente.
const FOUNDERS_CUTOFF = new Date('2026-09-08T00:00:00Z'); // 7-sep 23:59 UTC-ish, cierre inclusive

async function forgeCombatant({ address, name, handle, stats, scores, walletPower }) {
  const season_id = await activeSeasonId();
  const lc = address.toLowerCase();

  const payload = {
    address: lc,
    combatant_name: name,
    handle: handle || null,
    tx_count: stats.txCount, age_days: stats.ageDays,
    unique_contracts: stats.uniqueContracts, real_token_count: stats.realTokenCount,
    gas_burned_usd: stats.gasBurnedUsd, net_worth_usd: stats.netWorthUsd || 0,
    score_tx: scores.tx, score_age: scores.age, score_contracts: scores.contracts,
    score_diversification: scores.diversification, score_gas: scores.gas,
    wallet_power: walletPower,
    season_id,
  };

  // Solo se AGREGA la clave si corresponde otorgar el badge ahora mismo.
  // Al omitir la clave en refuerjas posteriores (post-cutoff), el upsert
  // no toca la columna y el badge ya otorgado queda intacto para siempre.
  if (new Date() < FOUNDERS_CUTOFF) {
    payload.founders_badge = true;
  }

  // upsert por address (no pisa elo/wins/losses si ya existe: solo refresca stats)
  const { data, error } = await supabase
    .from('combatants')
    .upsert(payload, { onConflict: 'address', ignoreDuplicates: false })
    .select(PUBLIC_COLS)
    .single();
  if (error) throw error;
  return data;
}

// Interno (solo backend · para el combate): ficha COMPLETA por address
async function getCombatantPrivate(address) {
  const { data, error } = await supabase
    .from('combatants').select('*').eq('address', address.toLowerCase()).single();
  if (error) throw error;
  return data;
}

// Público por nombre (lo que ve cualquiera)
async function getCombatantPublic(name) {
  const { data, error } = await supabase
    .from('combatants').select(PUBLIC_COLS).ilike('combatant_name', name).single();
  if (error) throw error;
  return data;
}
// Por nombre · ficha COMPLETA (backend, para el combate).
// Reconstruye scores{} desde las columnas planas score_* que
// espera resolveCombat. Trae id, elo y wallet_power incluidos.
async function getCombatantByName(name) {
  const { data, error } = await supabase
    .from('combatants').select('*').ilike('combatant_name', name).single();
  if (error) throw error;

  return {
    ...data,
    scores: {
      tx: data.score_tx,
      age: data.score_age,
      contracts: data.score_contracts,
      diversification: data.score_diversification,
      gas: data.score_gas,
    },
  };
}
// ── Tableros ────────────────────────────────────────────────
async function getPowerBoard(limit = 100) {
  const { data, error } = await supabase
    .from('combatants').select(PUBLIC_COLS)
    .order('wallet_power', { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

async function getSeasonBoard(limit = 100) {
  const { data, error } = await supabase
    .from('combatants').select(PUBLIC_COLS)
    .order('elo', { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

// ============================================================
//  BATTLE PLAN · defensa async
// ============================================================
async function saveBattlePlan(combatantId, { slot = 1, cardOrder, wildcard, timing }) {
  if (!Array.isArray(cardOrder) || cardOrder.length !== 5)
    throw new Error('card_order debe ser una permutación de 5 cartas');

  // desactiva el plan activo previo en ese slot
  await supabase.from('battle_plans')
    .update({ is_active: false })
    .eq('combatant_id', combatantId).eq('slot', slot).eq('is_active', true);

  const { data, error } = await supabase.from('battle_plans').insert({
    combatant_id: combatantId, slot,
    card_order: cardOrder, wildcard: wildcard || null,
    defense_wildcard_timing: timing || {}, is_active: true,
  }).select().single();
  if (error) throw error;
  return data;
}

async function getActiveBattlePlan(combatantId, slot = 1) {
  const { data, error } = await supabase.from('battle_plans').select('*')
    .eq('combatant_id', combatantId).eq('slot', slot).eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ============================================================
//  RECORD MATCH · atómico vía RPC, con ELO calculado aquí
//  attacker/defender/winner = ids de combatants. score = '3-2'.
// ============================================================
async function recordMatch({ attacker, defender, winnerId, score, rounds }) {
  const season_id = await activeSeasonId();

  // deltas en función de los ELO actuales de cada uno
  const loserId = winnerId === attacker.id ? defender.id : attacker.id;
  const winnerElo = winnerId === attacker.id ? attacker.elo : defender.elo;
  const loserElo  = winnerId === attacker.id ? defender.elo : attacker.elo;
  const { winnerDelta, loserDelta } = eloDeltas(winnerElo, loserElo);

  const deltaAttacker = winnerId === attacker.id ? winnerDelta : loserDelta;
  const deltaDefender = winnerId === defender.id ? winnerDelta : loserDelta;

  const { data: matchId, error } = await supabase.rpc('record_match', {
    p_attacker: attacker.id, p_defender: defender.id, p_winner: winnerId,
    p_score: score, p_rounds: rounds || [],
    p_delta_attacker: deltaAttacker, p_delta_defender: deltaDefender,
    p_season: season_id,
  });
  if (error) throw error;

  // re-evalúa rango por ELO para ambos (banda pegajosa; Legend = top-N aparte)
  await refreshRank(attacker.id);
  await refreshRank(defender.id);

  // ── Giant Killer (estado, no logro permanente) ─────────────
  // Se activa si el ganador tenía MENOS wallet_power que el perdedor
  // (derrotó a una wallet más poderosa). Se apaga si el perdedor tenía
  // MÁS wallet_power que el ganador (una wallet más chica lo tumbó).
  // Cualquier otro caso: no se toca el estado existente de nadie.
  const winnerObj = winnerId === attacker.id ? attacker : defender;
  const loserObj  = winnerId === attacker.id ? defender : attacker;
  if (winnerObj.wallet_power < loserObj.wallet_power) {
    await supabase.from('combatants').update({ giant_killer_active: true }).eq('id', winnerObj.id);
  }
  if (loserObj.wallet_power > winnerObj.wallet_power) {
    await supabase.from('combatants').update({ giant_killer_active: false }).eq('id', loserObj.id);
  }

  return matchId;
}

async function refreshRank(combatantId) {
  const { data, error } = await supabase
    .from('combatants').select('elo').eq('id', combatantId).single();
  if (error) throw error;
  await supabase.from('combatants')
    .update({ rank: rankFromElo(data.elo) }).eq('id', combatantId);
}

// ── Combat badges dinámicos (Untouchable + On Fire) ─────────
// First Blood y Giant Killer no necesitan query aparte: ya viven
// en combatants.wins y combatants.giant_killer_active respectivamente.
async function getCombatBadges(combatantId) {
  // Untouchable: alguna victoria perfecta 3-0 (score siempre "ganador-perdedor")
  const { data: perfect, error: e1 } = await supabase
    .from('matches')
    .select('id')
    .eq('winner_id', combatantId)
    .eq('score', '3-0')
    .limit(1);
  if (e1) throw e1;

  // On Fire: las 5 partidas más recientes (como atacante o defensor), todas ganadas
  const { data: recent, error: e2 } = await supabase
    .from('matches')
    .select('winner_id, created_at')
    .or(`attacker_id.eq.${combatantId},defender_id.eq.${combatantId}`)
    .order('created_at', { ascending: false })
    .limit(5);
  if (e2) throw e2;
  const onFire = recent.length === 5 && recent.every(m => m.winner_id === combatantId);

  return { untouchable: perfect.length > 0, onFire };
}

// Posición 1-indexed en el ranking de la temporada actual por ELO.
// Base Legend = estar entre los top-3 (asunción; ajustable si Tony quiere otro corte).
async function getSeasonRankPosition(combatantId) {
  const { data: me, error: e1 } = await supabase
    .from('combatants').select('elo').eq('id', combatantId).single();
  if (e1) throw e1;
  const { count, error: e2 } = await supabase
    .from('combatants')
    .select('id', { count: 'exact', head: true })
    .gt('elo', me.elo);
  if (e2) throw e2;
  return (count || 0) + 1;
}

// Revanchas / notificaciones: combates donde me atacaron, recientes primero
async function getIncomingMatches(combatantId, limit = 20) {
  const { data, error } = await supabase.from('matches')
    .select('id, attacker_id, winner_id, score, created_at')
    .eq('defender_id', combatantId)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

// Historial completo de combates de un combatiente (como atacante o como
// defensor), con los nombres ya resueltos -- para la pestaña "My Challenges"
async function getMatchHistory(combatantId, limit = 20) {
  const { data, error } = await supabase.from('matches')
    .select(`
      id, score, created_at, winner_id,
      attacker_id, defender_id,
      attacker:attacker_id ( combatant_name ),
      defender:defender_id ( combatant_name )
    `)
    .or(`attacker_id.eq.${combatantId},defender_id.eq.${combatantId}`)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

module.exports = {
  supabase,
  eloDeltas, rankFromElo, activeSeasonId,
  forgeCombatant, getCombatantPrivate, getCombatantPublic,getCombatantByName,
  getPowerBoard, getSeasonBoard, getMatchHistory,
  saveBattlePlan, getActiveBattlePlan,
  recordMatch, getIncomingMatches,
  getCombatBadges, getSeasonRankPosition,
};

// ============================================================
//  BATTLE PLAN · umbrales de credencial para desbloquear comodín
//  Se evalúan sobre la ficha COMPLETA del combatiente (stats crudas).
// ============================================================
const WILDCARD_THRESHOLDS = {
  veterans_gambit:   (c) => c.age_days >= 365,
  multichain_strike: (c) => c.real_token_count >= 15,
  builders_override: (c) => c.unique_contracts >= 50,
  giant_killer:      () => true, // sin credencial extra: el riesgo (ir perdiendo) ya es el precio
};

function isWildcardUnlocked(combatant, wildcard) {
  if (!wildcard) return false;
  const check = WILDCARD_THRESHOLDS[wildcard];
  return check ? check(combatant) : false;
}

module.exports.WILDCARD_THRESHOLDS = WILDCARD_THRESHOLDS;
module.exports.isWildcardUnlocked = isWildcardUnlocked;
