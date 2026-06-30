// ============================================================
//  WalletWars · Scoring (Ladrillo 1) · PURO, sin dependencias
//  Convierte stats crudas → 5 notas 0-100 → Wallet Power.
//  Curva saturante (rendimientos decrecientes), anti-ballena.
//  Fase 1: midpoints FIJOS. Fase 2: el midpoint pasa a percentil
//  real de la población (mismo output 0-100 → no se reescribe nada).
// ============================================================

// Punto medio por stat = valor crudo que da NOTA 50.
// (del handoff, cerrados)
const MIDPOINTS = {
  tx:              250,   // transacciones
  age:             180,   // antigüedad en días (bajo a propósito: Base es joven)
  contracts:       35,    // contratos únicos tocados
  diversification: 10,    // tokens reales (con precio)
  gas:             25,    // gas quemado en USD
};

// Curva saturante tipo Hill: nota = 100 · x / (x + midpoint)
//   x = midpoint  → 50
//   x = 3·mid     → 75
//   x = 9·mid     → 90
// Anti-ballena: 10× más NO vale 10× más.
function saturate(value, midpoint) {
  const x = Math.max(0, Number(value) || 0);
  return Math.round((100 * x) / (x + midpoint));
}

// stats crudas → 5 notas 0-100
function scoreStats(stats) {
  return {
    tx:              saturate(stats.txCount,         MIDPOINTS.tx),
    age:             saturate(stats.ageDays,         MIDPOINTS.age),
    contracts:       saturate(stats.uniqueContracts, MIDPOINTS.contracts),
    diversification: saturate(stats.realTokenCount,  MIDPOINTS.diversification),
    gas:             saturate(stats.gasBurnedUsd,    MIDPOINTS.gas),
  };
}

// Wallet Power = media simple de las 5 notas, escalada ×100.
// (las 5 pesan igual → lo más justo y anti-ballena; nota 72.4 → power 7240)
function walletPower(scores) {
  const vals = [scores.tx, scores.age, scores.contracts, scores.diversification, scores.gas];
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.round(mean * 100);
}

// Atajo: crudas → { scores, walletPower } de una
function forgeScores(stats) {
  const scores = scoreStats(stats);
  return { scores, walletPower: walletPower(scores) };
}

module.exports = { MIDPOINTS, saturate, scoreStats, walletPower, forgeScores };
