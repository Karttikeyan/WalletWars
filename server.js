require('dotenv').config({ path: '.env.local' });
const express = require('express');
const scoring = require('./scoring');
const db = require('./supabaseService');
const app = express();
app.use(express.json());
const PORT = 3000;

const ALCHEMY_KEY    = process.env.ALCHEMY_API_KEY;
const COINGECKO_KEY  = process.env.COINGECKO_API_KEY;
const BLOCKSCOUT_KEY = process.env.BLOCKSCOUT_API_KEY;

const BASE_CHAIN_ID  = 8453;
const ALCHEMY_URL    = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
const ALCHEMY_NFT    = `https://base-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_KEY}`;
const COINGECKO_URL  = 'https://api.coingecko.com/api/v3';
const BLOCKSCOUT_PRO = 'https://api.blockscout.com/v2/api';
const BLOCKSCOUT_PUB = 'https://base.blockscout.com/api';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function safeJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { _nonJson: text.slice(0, 120) }; }
}

async function alchemy(method, params) {
  const res = await fetch(ALCHEMY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return safeJson(res);
}

// NFT: colecciones reales (filtra spam con el flag isSpam de cada coleccion, paginando)
async function alchemyNftCollections(address) {
  let real = 0, raw = 0, pageKey = null, pages = 0, dbg = 'ok';
  try {
    do {
      let u = `${ALCHEMY_NFT}/getContractsForOwner?owner=${address}&pageSize=100&withMetadata=true`;
      if (pageKey) u += `&pageKey=${encodeURIComponent(pageKey)}`;
      const res = await fetch(u);
      const data = await safeJson(res);
      const arr = (data && Array.isArray(data.contracts)) ? data.contracts : null;
      if (!arr) { dbg = (data && (data.error || data._nonJson)) || 'no contracts'; break; }
      for (const c of arr) { raw++; if (c.isSpam !== true) real++; }
      pageKey = data.pageKey || null;
      pages++;
    } while (pageKey && pages < 5);
    return { count: real, raw, dbg };
  } catch (e) { return { count: 0, raw: 0, dbg: String(e).slice(0, 80) }; }
}

async function coingeckoTokenPrices(addresses) {
  const out = {};
  const CHUNK = 100;
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const batch = addresses.slice(i, i + CHUNK);
    const url = new URL(`${COINGECKO_URL}/simple/token_price/base`);
    url.searchParams.set('contract_addresses', batch.join(','));
    url.searchParams.set('vs_currencies', 'usd');
    if (COINGECKO_KEY) url.searchParams.set('x_cg_demo_api_key', COINGECKO_KEY);
    const res = await fetch(url);
    const data = await safeJson(res);
    if (data && typeof data === 'object' && !data._nonJson) Object.assign(out, data);
  }
  return out;
}

async function coingeckoEthPrice() {
  const url = new URL(`${COINGECKO_URL}/simple/price`);
  url.searchParams.set('ids', 'ethereum');
  url.searchParams.set('vs_currencies', 'usd');
  if (COINGECKO_KEY) url.searchParams.set('x_cg_demo_api_key', COINGECKO_KEY);
  const res = await fetch(url);
  const data = await safeJson(res);
  return (data && data.ethereum && typeof data.ethereum.usd === 'number') ? data.ethereum.usd : null;
}

function proUrl(address) {
  const u = new URL(BLOCKSCOUT_PRO);
  u.searchParams.set('chain_id', BASE_CHAIN_ID);
  u.searchParams.set('module', 'account');
  u.searchParams.set('action', 'txlist');
  u.searchParams.set('address', address);
  if (BLOCKSCOUT_KEY) u.searchParams.set('apikey', BLOCKSCOUT_KEY);
  return u;
}
function pubUrl(address) {
  const u = new URL(BLOCKSCOUT_PUB);
  u.searchParams.set('module', 'account');
  u.searchParams.set('action', 'txlist');
  u.searchParams.set('address', address);
  return u;
}
async function fetchTxlistOnce(url) {
  try {
    const res = await fetch(url);
    const data = await safeJson(res);
    if (data && Array.isArray(data.result)) return data.result;
  } catch {}
  return null;
}
async function blockscoutTxlist(address) {
  const plan = ['pro', 'public', 'pro', 'public'];
  let sawEmpty = false;
  for (let i = 0; i < plan.length; i++) {
    const url = plan[i] === 'pro' ? proUrl(address) : pubUrl(address);
    const r = await fetchTxlistOnce(url);
    if (Array.isArray(r) && r.length) return { list: r, dbg: { source: plan[i], attempt: i + 1 } };
    if (Array.isArray(r)) sawEmpty = true;
    if (i < plan.length - 1) await sleep(700);
  }
  return { list: [], dbg: { source: sawEmpty ? 'empty' : 'none' } };
}

app.get('/api/wallet/:address', async (req, res) => {
  const address = req.params.address;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Direccion no valida' });
  }
  try {
    const addrLc = address.toLowerCase();

    const transfers = await alchemy('alchemy_getAssetTransfers', [{
      fromBlock: '0x0', toBlock: 'latest',
      fromAddress: address,
      category: ['external', 'erc20', 'erc721', 'erc1155'],
      order: 'asc', maxCount: '0x1', withMetadata: true
    }]);
    let ageDays = 0, firstTxDate = null;
    const tlist = transfers.result && transfers.result.transfers;
    if (Array.isArray(tlist) && tlist.length > 0) {
      const tsStr = tlist[0].metadata && tlist[0].metadata.blockTimestamp;
      if (tsStr) {
        firstTxDate = tsStr.slice(0, 10);
        ageDays = Math.floor((Date.now() - new Date(tsStr).getTime()) / 86400000);
      }
    }

    const nonceRes = await alchemy('eth_getTransactionCount', [address, 'latest']);
    const txCount = nonceRes.result ? parseInt(nonceRes.result, 16) : 0;

    const balances = await alchemy('alchemy_getTokenBalances', [address, 'erc20']);
    const tb = (balances.result && balances.result.tokenBalances) || [];
    const heldTokens = tb.filter(t => {
      try { return BigInt(t.tokenBalance) > 0n; } catch { return false; }
    });
    const tokenCount = heldTokens.length;

    const addresses = heldTokens.map(t => t.contractAddress.toLowerCase());
    const prices = await coingeckoTokenPrices(addresses);
    const pricedTokens = heldTokens.filter(t => {
      const p = prices[t.contractAddress.toLowerCase()];
      return p && typeof p.usd === 'number';
    });
    const realTokenCount = pricedTokens.length;

    let ethBalance = 0, ethValue = 0;
    const balEth = await alchemy('eth_getBalance', [address, 'latest']);
    if (balEth && balEth.result) {
      try { ethBalance = Number(BigInt(balEth.result)) / 1e18; } catch {}
    }
    const ethUsd = await coingeckoEthPrice();
    if (ethUsd) ethValue = ethBalance * ethUsd;

    let tokensValue = 0, pricedFailed = 0;
    for (const t of pricedTokens) {
      const addr = t.contractAddress.toLowerCase();
      let meta = await alchemy('alchemy_getTokenMetadata', [t.contractAddress]);
      if (!meta || !meta.result) meta = await alchemy('alchemy_getTokenMetadata', [t.contractAddress]);
      const decimals = (meta && meta.result && typeof meta.result.decimals === 'number') ? meta.result.decimals : null;
      if (decimals === null) { pricedFailed++; continue; }
      const balance = Number(BigInt(t.tokenBalance)) / 10 ** decimals;
      tokensValue += balance * prices[addr].usd;
    }
    const netWorth = Math.round((ethValue + tokensValue) * 100) / 100;

    const txResult = await blockscoutTxlist(address);
    const txs = txResult.list;
    let gasWei = 0n, deployedContracts = 0;
    const contractsTouched = new Set();
    for (const t of txs) {
      if (t.from && t.from.toLowerCase() === addrLc) {
        try { gasWei += BigInt(t.gasUsed || '0') * BigInt(t.gasPrice || '0'); } catch {}
        const to = (t.to || '').toLowerCase();
        const hasInput = t.input && t.input !== '0x' && t.input.length > 2;
        if (to && hasInput) contractsTouched.add(to);
        if ((!t.to || t.to === '') && t.contractAddress && t.contractAddress.length > 2) deployedContracts++;
      }
    }
    const gasBurnedEth = Math.round((Number(gasWei) / 1e18) * 1e6) / 1e6;
    const gasBurnedUsd = ethUsd ? Math.round((Number(gasWei) / 1e18) * ethUsd * 100) / 100 : null;
    const uniqueContracts = contractsTouched.size;

    const nft = await alchemyNftCollections(address);
    const nftCollections = nft.count;

    const profileBadges = {
      OG:        ageDays >= 365,
      Explorer:  uniqueContracts >= 20,
      Collector: nftCollections >= 3,
      Builder:   deployedContracts >= 1
    };
const { scores, walletPower } = scoring.forgeScores({ txCount, ageDays, uniqueContracts, realTokenCount, gasBurnedUsd });
    res.json({
      address, firstTxDate, ageDays, txCount,
      scores, walletPower,
      tokenCount, realTokenCount,
      ethBalance: Math.round(ethBalance * 1e6) / 1e6,
      netWorth,
      gasBurnedEth, gasBurnedUsd,
      uniqueContracts,
      nftCollections,
      deployedContracts,
      profileBadges,
      _debug: { ethUsd, pricedFailed, txlistCount: txs.length, blockscout: txResult.dbg, nft: nft.dbg, nftRaw: nft.raw, alchemyError: transfers.error || balances.error || null }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fallo consultando APIs' });
  }
});

app.use(express.static(__dirname));
app.use('/api', require('./routes'));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`WalletWars dev server -> http://localhost:${PORT}`);
    if (!ALCHEMY_KEY)    console.warn('AVISO: falta ALCHEMY_API_KEY');
    if (!COINGECKO_KEY)  console.warn('AVISO: falta COINGECKO_API_KEY');
    if (!BLOCKSCOUT_KEY) console.warn('AVISO: falta BLOCKSCOUT_API_KEY');
  });
}

module.exports = app;
