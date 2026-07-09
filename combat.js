// ============================================================
//  WalletWars · Resolución de combate (módulo puro, sin DB)
//  best-of-5 · orden por Battle Plan del defensor (o fijo si no hay)
//  Devuelve { winner, score, rounds } listo para recordMatch().
//  Puro ⇒ testeable en aislado, no toca Supabase.
// ============================================================

// Orden fijo de rondas (fallback si el defensor no tiene Battle Plan activo)
const ROUND_ORDER = ['tx', 'age', 'contracts', 'diversification', 'gas'];
const WINS_NEEDED = 3;   // first-to-3 → 3-0, 3-1, 3-2

// Stat que cada comodín (salvo Giant Killer) gana automáticamente al caer esa ronda
const WILDCARD_STAT = {
  veterans_gambit: 'age',
  multichain_strike: 'diversification',
  builders_override: 'contracts',
  // giant_killer no tiene stat fija: se dispara por condición (ir perdiendo 0-2)
};

// ── resolveCombat ───────────────────────────────────────────
// a, b = fichas de combatiente (necesitan .scores y .wallet_power).
// 'a' es el ATACANTE (quien reta) · 'b' es el DEFENSOR.
// defenderPlan (opcional) = { cardOrder, wildcard, wildcardUnlocked }
//   cardOrder: permutación de 5 stats (orden del defensor) o null
//   wildcard: nombre del comodín elegido por el defensor o null
//   wildcardUnlocked: bool YA resuelto por el caller (credencial cumplida)
function resolveCombat(a, b, defenderPlan = null) {
  const order = (defenderPlan && Array.isArray(defenderPlan.cardOrder) && defenderPlan.cardOrder.length === 5)
    ? defenderPlan.cardOrder
    : ROUND_ORDER;

  const wildcard = defenderPlan ? defenderPlan.wildcard : null;
  const wildcardUnlocked = defenderPlan ? !!defenderPlan.wildcardUnlocked : false;
  let wildcardUsed = false; // se dispara como mucho una vez por combate

  let winsA = 0, winsB = 0;
  const rounds = [];

  for (const stat of order) {
    if (winsA === WINS_NEEDED || winsB === WINS_NEEDED) break;  // ya está decidido

    const sA = a.scores[stat];
    const sB = b.scores[stat];
    let roundWinner;
    let wildcardTriggered = false;

    // Giant Killer: condición (ir perdiendo 0-2), no stat fija
    const giantKillerCondition = wildcard === 'giant_killer' && winsA === 2 && winsB === 0;

    if (!wildcardUsed && wildcardUnlocked && giantKillerCondition) {
      roundWinner = 'b'; winsB++; wildcardTriggered = true;
    } else if (!wildcardUsed && wildcardUnlocked && WILDCARD_STAT[wildcard] === stat) {
      roundWinner = 'b'; winsB++; wildcardTriggered = true;
    } else if (sA > sB) {
      roundWinner = 'a'; winsA++;
    } else if (sB > sA) {
      roundWinner = 'b'; winsB++;
    } else {
      // empate de ronda → desempate por wallet_power, y si sigue, gana atacante (a)
      if (a.wallet_power >= b.wallet_power) { roundWinner = 'a'; winsA++; }
      else { roundWinner = 'b'; winsB++; }
    }

    if (wildcardTriggered) wildcardUsed = true;
    rounds.push({ stat, a: sA, b: sB, winner: roundWinner, wildcard: wildcardTriggered ? wildcard : null });
  }

  const winner = winsA > winsB ? 'a' : 'b';
  const score  = `${Math.max(winsA, winsB)}-${Math.min(winsA, winsB)}`;
  return { winner, score, rounds };
}

module.exports = { resolveCombat, ROUND_ORDER, WINS_NEEDED, WILDCARD_STAT };
