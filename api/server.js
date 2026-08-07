require('dotenv').config({ path: '.env.local' });
const express = require('express');
const path = require('path');
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


const { getWalletData } = require('./walletData');

app.get('/api/wallet/:address', async (req, res) => {
  const address = req.params.address;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Direccion no valida' });
  }
  try {
    const data = await getWalletData(address);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fallo consultando APIs' });
  }
});
app.use(express.static(path.join(__dirname, '..')));
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
