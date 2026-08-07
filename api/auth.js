// auth.js — SIWE authentication module
// Handles nonce generation, signature verification, and session tokens.
// Pure-ish module: takes a Supabase client instance injected from supabaseService.js

const { SiweMessage, generateNonce: siweGenerateNonce } = require('siwe');
const jwt = require('jsonwebtoken');

const SESSION_SECRET = process.env.SESSION_SECRET;
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL = '7d';

if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET is not set in .env.local — auth.js cannot start without it');
}

/**
 * Generates a fresh nonce for a given address and stores it in Supabase.
 * Overwrites any previous nonce for that address (one active nonce per wallet).
 * @param {object} db - supabase client
 * @param {string} address - wallet address (will be lowercased)
 * @returns {Promise<string>} the nonce to embed in the SIWE message
 */
async function generateNonce(db, address) {
  const addr = address.toLowerCase();
  const nonce = siweGenerateNonce();
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS).toISOString();

  const { error } = await db
    .from('auth_nonces')
    .upsert({ address: addr, nonce, expires_at: expiresAt }, { onConflict: 'address' });

  if (error) throw new Error(`Failed to store nonce: ${error.message}`);

  return nonce;
}

/**
 * Verifies a SIWE message + signature against the stored nonce.
 * Consumes (deletes) the nonce on success to prevent replay.
 * @param {object} db - supabase client
 * @param {string} message - the SIWE message string the client signed
 * @param {string} signature - the signature produced by the wallet
 * @returns {Promise<{address: string}>} the verified address
 */
async function verifySiweMessage(db, message, signature) {
  const siweMessage = new SiweMessage(message);
  const addr = siweMessage.address.toLowerCase();

  // 1. Look up the stored nonce for this address
  const { data: row, error: fetchError } = await db
    .from('auth_nonces')
    .select('nonce, expires_at')
    .eq('address', addr)
    .single();

  if (fetchError || !row) {
    throw new Error('No pending login for this address — request a nonce first');
  }

  if (new Date(row.expires_at) < new Date()) {
    await consumeNonce(db, addr);
    throw new Error('Nonce expired — request a new one');
  }

  if (siweMessage.nonce !== row.nonce) {
    throw new Error('Nonce mismatch — possible replay attempt');
  }

  // 2. Verify the signature cryptographically (this checks the message matches too)
  const result = await siweMessage.verify({ signature, nonce: row.nonce });

  if (!result.success) {
    throw new Error('Signature verification failed');
  }

  // 3. Consume the nonce so it can't be reused
  await consumeNonce(db, addr);

  return { address: addr };
}

/**
 * Deletes a nonce row (used after successful verification or on expiry).
 */
async function consumeNonce(db, address) {
  const addr = address.toLowerCase();
  await db.from('auth_nonces').delete().eq('address', addr);
}

/**
 * Creates a signed JWT session token for a verified address.
 * @param {string} address
 * @returns {string} JWT
 */
function createSessionToken(address) {
  return jwt.sign({ address: address.toLowerCase() }, SESSION_SECRET, { expiresIn: SESSION_TTL });
}

/**
 * Verifies a session JWT and returns its payload, or throws.
 * @param {string} token
 * @returns {{address: string, iat: number, exp: number}}
 */
function verifySessionToken(token) {
  return jwt.verify(token, SESSION_SECRET);
}

module.exports = {
  generateNonce,
  verifySiweMessage,
  consumeNonce,
  createSessionToken,
  verifySessionToken,
};
