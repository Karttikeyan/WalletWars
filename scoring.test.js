// node scoring.test.js  →  comprueba que la curva da lo del handoff
const { saturate, forgeScores, MIDPOINTS } = require('./scoring');

console.log('\n=== Anclajes de la curva (TX, midpoint 250) ===');
for (const x of [0, 250, 300, 750, 2250, 3000]) {
  console.log(`  ${String(x).padStart(5)} txs  ->  nota ${saturate(x, MIDPOINTS.tx)}`);
}
console.log('  (esperado: 300->55, 3000->92  ✓ handoff)');

console.log('\n=== Forge de ejemplo (wallet activa) ===');
const stats = {
  txCount: 1847, ageDays: 847, uniqueContracts: 241,
  realTokenCount: 5, gasBurnedUsd: 20.9,
};
const { scores, walletPower } = forgeScores(stats);
console.table(scores);
console.log('  Wallet Power =', walletPower, '\n');
