// test-siwe.js — prueba end-to-end del flujo SIWE contra el server local
// Genera una wallet de test (sin fondos, solo para firmar), pide el nonce,
// construye el mensaje SIWE, lo firma, y lo manda a /api/auth/verify.
// También prueba anti-replay: reusar la misma firma debe fallar.

const { Wallet } = require('ethers');
const { SiweMessage } = require('siwe');

const BASE_URL = 'http://localhost:3000';

async function main() {
  const wallet = Wallet.createRandom();
  const address = wallet.address;
  console.log('Test wallet address:', address);

  const nonceRes = await fetch(`${BASE_URL}/api/auth/nonce/${address}`);
  const { nonce } = await nonceRes.json();
  console.log('Nonce recibido:', nonce);

  const siweMessage = new SiweMessage({
    domain: 'localhost',
    address,
    statement: 'Sign in to WalletWars',
    uri: 'http://localhost:3000',
    version: '1',
    chainId: 8453,
    nonce,
  });
  const messageToSign = siweMessage.prepareMessage();
  console.log('\n--- Mensaje SIWE ---\n' + messageToSign + '\n--------------------\n');

  const signature = await wallet.signMessage(messageToSign);
  console.log('Firma generada:', signature.slice(0, 20) + '...');

  const verifyRes = await fetch(`${BASE_URL}/api/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: messageToSign, signature }),
  });
  const verifyData = await verifyRes.json();
  console.log('\nRespuesta de /api/auth/verify (1er intento):');
  console.log(verifyData);

  if (verifyRes.status === 200 && verifyData.ok) {
    console.log('\n✅ VERIFICACIÓN EXITOSA — el flujo SIWE funciona de punta a punta');
  } else {
    console.log('\n❌ VERIFICACIÓN FALLÓ');
    return;
  }

  console.log('\n--- Probando replay con la misma firma ---');
  const replayRes = await fetch(`${BASE_URL}/api/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: messageToSign, signature }),
  });
  const replayData = await replayRes.json();
  console.log('Respuesta de /api/auth/verify (2do intento, replay):');
  console.log('status:', replayRes.status, replayData);

  if (replayRes.status !== 200) {
    console.log('\n✅ ANTI-REPLAY FUNCIONA — la segunda verificación fue rechazada correctamente');
  } else {
    console.log('\n❌ PROBLEMA DE SEGURIDAD — la firma se pudo reusar');
  }
}

main().catch((e) => {
  console.error('Error en el test:', e);
  process.exit(1);
});
