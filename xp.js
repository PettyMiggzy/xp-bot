import 'dotenv/config';
import fs from 'fs';
import TelegramBot from 'node-telegram-bot-api';
import http from 'http';
import { JsonRpcProvider, Wallet, Contract, parseEther, parseUnits, isAddress, getBytes, solidityPackedKeccak256, namehash } from 'ethers';
import { RANKSETS, rankFor, nextRank } from './ranks.js';

// ============ CONFIG (all from .env) ============
const TG_TOKEN   = process.env.TG_BOT_TOKEN;
const PROJECT    = (process.env.PROJECT || 'chronic').toLowerCase();
const RPC        = process.env.MONAD_RPC || 'https://rpc.monad.xyz';   // never hardcode keys
const CHAIN_ID   = 143;

// shared reward pool (one pool for every group/token), resolved by name at startup
const POOL_NAME     = process.env.POOL_NAME || 'rewardsbot.nad';
const POOL_FALLBACK = process.env.POOL_ADDRESS || '0xfDB919399Ec8605a9787046876F50D646BD6C42A';
const NNS_ADDR      = '0xCc7a1bfF8845573dbF0B3b96e25B9b549d4a2eC7';
const NATIVE        = '0x0000000000000000000000000000000000000000';   // MON sentinel

// legacy/default group economics (used to seed the CHRONIC group + migrate old XP)
const TOKEN_ADDR = process.env.TOKEN_ADDRESS || '';
const TOKEN_SYM  = process.env.TOKEN_SYMBOL  || 'CHRONIC';
const TOKEN_DEC  = Number(process.env.TOKEN_DECIMALS || '18');
const HOLD_REQ   = process.env.HOLD_REQUIRED || '1000000';
const CHRONIC_PER_XP = Number(process.env.CHRONIC_PER_XP || '2');
const MON_PER_XP     = Number(process.env.MON_PER_XP || '0.001');

// MON safety rails
const MIN_CLAIM_MON  = Number(process.env.MIN_CLAIM_MON || '10');     // MON floor before any MON is authorized
const MAX_USER_DAILY = Number(process.env.MAX_USER_DAILY_MON || '25');// per-harvest MON cap
const CLAIM_COOLDOWN_DAYS = Number(process.env.CLAIM_COOLDOWN_DAYS || '7');
const CLAIM_COOLDOWN_MS   = CLAIM_COOLDOWN_DAYS * 86400000;

// XP earning
const XP_PER_MSG     = Number(process.env.XP_PER_MSG || '5');
const MIN_WORDS      = Number(process.env.MIN_WORDS || '3');
const XP_COOLDOWN_MS = Number(process.env.XP_COOLDOWN_SEC || '60') * 1000;

const PAYOUTS_ENABLED = String(process.env.PAYOUTS_ENABLED || 'false').toLowerCase() === 'true';
const CLAIM_URL = process.env.CLAIM_URL || 'https://burnchronic.xyz/claim';
const SIGNER_PK = process.env.SIGNER_PRIVATE_KEY || '';
const API_PORT  = Number(process.env.API_PORT || '8645');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const RL_MAX    = Number(process.env.RATE_LIMIT_PER_MIN || '60');

if (!TG_TOKEN) { console.error('Missing TG_BOT_TOKEN'); process.exit(1); }
const bot = new TelegramBot(TG_TOKEN, { polling: true });

// chain
let provider=null, claimSigner=null, pool=null, POOL_ADDR=POOL_FALLBACK;
try {
  provider = new JsonRpcProvider(RPC, CHAIN_ID);
  if (SIGNER_PK) claimSigner = new Wallet(SIGNER_PK); // SIGNS authorizations only — holds no funds
} catch (e) { console.error('chain init:', e.message); }
const erc20cache = {};
function erc20(addr){ if(!erc20cache[addr]) erc20cache[addr]=new Contract(addr,['function balanceOf(address) view returns (uint256)'],provider); return erc20cache[addr]; }

async function resolvePool(){
  try{
    const nns=new Contract(NNS_ADDR,['function getResolvedAddress(bytes32) view returns (address)'],provider);
    const a=await nns.getResolvedAddress(namehash(POOL_NAME));
    if(a && a.toLowerCase()!==NATIVE) POOL_ADDR=a;
    else console.error('WARN: '+POOL_NAME+' resolves to nothing — using fallback '+POOL_FALLBACK);
  }catch(e){ console.error('pool resolve failed ('+e.message+') — using fallback '+POOL_FALLBACK); }
  if(provider) pool=new Contract(POOL_ADDR,['function claimed(address,address) view returns (uint256)','function poolBalance(address) view returns (uint256)'],provider);
  console.log('reward pool:', POOL_ADDR, '(via '+POOL_NAME+')');
}

// ============ PERSISTENCE ============
const DB_FILE = './data.json';
let DB = { users: {}, groups: {} };
function load(){ try { DB = JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch { /* fresh */ } if(!DB.users)DB.users={}; if(!DB.groups)DB.groups={}; }
let saveT=null;
function save(){ clearTimeout(saveT); saveT=setTimeout(()=>{ try{ fs.writeFileSync(DB_FILE, JSON.stringify(DB)); }catch(e){console.error('save:',e.message);} }, 400); }
function u(id){ if(!DB.users[id]) DB.users[id]={ wallet:'', name:'', g:{}, harvest:{} }; const x=DB.users[id]; if(!x.g)x.g={}; if(!x.harvest)x.harvest={}; return x; }
load();

// ---- one-time migration: legacy flat .xp -> a "__legacy" CHRONIC group bucket ----
function migrate(){
  if (TOKEN_ADDR && !DB.groups.__legacy)
    DB.groups.__legacy = { token: TOKEN_ADDR, sym: TOKEN_SYM, dec: TOKEN_DEC, perXp: CHRONIC_PER_XP, mon: { holdReq: HOLD_REQ, perXp: MON_PER_XP } };
  for (const id in DB.users){
    const usr=DB.users[id];
    if (typeof usr.xp === 'number'){
      usr.g = usr.g || {};
      if (usr.xp>0 && !usr.g.__legacy) usr.g.__legacy = { xp: usr.xp, lastXp: usr.lastXp||0 };
      delete usr.xp; delete usr.claimedChronic; delete usr.claimedMon; delete usr.lastXp; delete usr.holds1M;
    }
    if(!usr.g)usr.g={}; if(!usr.harvest)usr.harvest={};
  }
  save();
}
migrate();

const ranksFor = (sym)=> RANKSETS[(sym||'').toLowerCase()] || RANKSETS[PROJECT] || RANKSETS.default;
const fmt = (n)=> (Math.round(n*10000)/10000).toString();
const shortA = (a)=> a.slice(0,6)+'…'+a.slice(-4);
const totalXp = (usr)=> Object.values(usr.g||{}).reduce((s,e)=>s+(e.xp||0),0);

async function isAdmin(msg){
  if (msg.from?.username === 'GroupAnonymousBot') return true; // posting as the group = an admin
  if (msg.chat.type === 'private') return true;
  try { const m=await bot.getChatMember(msg.chat.id, msg.from.id); return m && (m.status==='creator'||m.status==='administrator'); }
  catch { return false; }
}

// refresh per-group holder status (for MON bonus gating); cached 30s on the user
async function refreshHolds(usr){
  if(!usr.wallet || !provider){ usr._holds={}; return; }
  const now=Date.now(); if(usr._chk && now-usr._chk < 30000) return;
  usr._holds = usr._holds || {};
  for(const chatId in (usr.g||{})){
    const g=DB.groups[chatId]; if(!g || !g.mon) continue;
    const gate=g.mon.gate||g.token;            // MON gated by this token (defaults to the group's reward token)
    try{ const bal=await erc20(gate).balanceOf(usr.wallet); usr._holds[chatId] = bal >= parseUnits(String(g.mon.holdReq), 18); }
    catch{ /* keep prior */ }
  }
  usr._chk=now;
}

// cumulative LIFETIME owed per token (wei) + MON owed (wei) across all the user's groups
function owed(usr){
  const byToken={}; let monWei=0n;
  for(const chatId in (usr.g||{})){
    const g=DB.groups[chatId]; if(!g) continue;
    const xp=usr.g[chatId].xp||0; if(xp<=0) continue;
    const tl=g.token.toLowerCase(), dec=g.dec||18;
    const add=parseUnits(String(Math.floor(xp*g.perXp)), dec);
    if(byToken[tl]) byToken[tl].wei+=add; else byToken[tl]={wei:add, dec, sym:g.sym, addr:g.token};
    if(g.mon && usr._holds && usr._holds[chatId]) monWei += parseEther((xp*g.mon.perXp).toFixed(6));
  }
  return { byToken, monWei };
}

// per-token claimable for display (whole-token number)
function claimableToken(usr, tl){ const o=owed(usr).byToken[tl]; return o? Number(o.wei)/10**(o.dec) : 0; }

// ============ XP earning ============
bot.on('message', (msg)=>{
  try{
    if(!msg.from?.id || !msg.text || msg.text.startsWith('/')) return;
    if(msg.from?.is_bot && msg.from?.username !== 'GroupAnonymousBot') return;
    const grp = DB.groups[msg.chat.id];
    if(!grp) return; // group not configured -> no XP (an admin must /setreward here)
    if(msg.text.trim().split(/\s+/).filter(Boolean).length < MIN_WORDS) return;
    const usr=u(msg.from.id);
    usr.name = (msg.from?.username==='GroupAnonymousBot') ? '👑 admin' : (msg.from.username? '@'+msg.from.username : (msg.from.first_name||'anon'));
    const slot = usr.g[msg.chat.id] = usr.g[msg.chat.id] || { xp:0, lastXp:0 };
    const now=Date.now();
    if(now-(slot.lastXp||0) >= XP_COOLDOWN_MS){ slot.xp=(slot.xp||0)+XP_PER_MSG; slot.lastXp=now; save(); }
  }catch(e){ console.error('xp:',e.message); }
});

// ============ admin: set this group's reward token ============
bot.onText(/^\/setreward(?:@\w+)?\s+off\s*$/i, async (msg)=>{
  const reply=(t)=>bot.sendMessage(msg.chat.id,t,{reply_to_message_id:msg.message_id});
  if(!(await isAdmin(msg))) return reply('admins only 🚫');
  if(!DB.groups[msg.chat.id]) return reply('this group has no rewards set');
  delete DB.groups[msg.chat.id]; save();
  reply('🛑 rewards turned OFF for this group. (earned XP is kept; set a token again with /setreward)');
});
bot.onText(/^\/setreward(?:@\w+)?\s+(\S+)\s+(\S+)(?:\s+(\S+))?/i, async (msg,m)=>{
  const reply=(t)=>bot.sendMessage(msg.chat.id,t,{parse_mode:'Markdown',reply_to_message_id:msg.message_id});
  if(/^off$/i.test(m[1])) return; // handled above
  if(!(await isAdmin(msg))) return reply('admins only 🚫');
  const addr=m[1].trim();
  if(!isAddress(addr)) return reply('that token address isn\u2019t valid ser');
  const sym=m[2].toUpperCase().replace(/^\$/,'').slice(0,12);
  const perXp=m[3]? Number(m[3]) : CHRONIC_PER_XP;
  const g = DB.groups[msg.chat.id] || {};
  g.token=addr; g.sym=sym; g.dec=g.dec||18; g.perXp=(perXp>0?perXp:1); if(g.mon===undefined)g.mon=null;
  DB.groups[msg.chat.id]=g; save();
  reply(`✅ this group now rewards *${g.perXp} ${g.sym}* per XP\ntoken: ${shortA(addr)}\nMON bonus: ${g.mon?'on':'off — /setmon <hold> <monPerXp> to enable'}\n\nfund the pool with ${g.sym} and members earn by chatting (${MIN_WORDS}+ words).`);
});
bot.onText(/^\/setmon(?:@\w+)?\s+(\S+)(?:\s+(\S+))?(?:\s+(\S+))?/i, async (msg,m)=>{
  const reply=(t)=>bot.sendMessage(msg.chat.id,t,{parse_mode:'Markdown',reply_to_message_id:msg.message_id});
  if(!(await isAdmin(msg))) return reply('admins only 🚫');
  const g=DB.groups[msg.chat.id]; if(!g) return reply('set the reward token first: /setreward <token> <SYM>');
  if(/^off$/i.test(m[1])){ g.mon=null; save(); return reply('MON bonus turned off for this group'); }
  const holdReq=m[1].replace(/[, ]/g,''); const monPerXp=m[2]? Number(m[2]) : MON_PER_XP;
  if(!(Number(holdReq)>0) || !(monPerXp>0)) return reply('usage: /setmon <holdAmount> <monPerXp> [gateToken]   (or /setmon off)');
  let gate=null;
  if(m[3]){ if(!isAddress(m[3])) return reply('that gate-token address isn\u2019t valid'); gate=m[3].trim(); }
  g.mon={ holdReq, perXp: monPerXp, gate }; save();
  const gateLabel = gate? shortA(gate)+' (custom)' : g.sym;
  reply(`✅ MON bonus on: hold *${Number(holdReq).toLocaleString()} ${gateLabel}* to also earn *${monPerXp} MON* per XP`);
});
// ============ show this group's setup ============
bot.onText(/^\/config(?:@\w+)?$/i, (msg)=>{
  const g=DB.groups[msg.chat.id];
  if(!g) return bot.sendMessage(msg.chat.id,'this group isn\u2019t set up — an admin runs /setreward <token> <SYM> [perXp]',{reply_to_message_id:msg.message_id});
  let s=`*Group rewards*\ntoken: *${g.sym}* (${shortA(g.token)})\nrate: *${g.perXp}* ${g.sym} / XP\n`;
  if(g.mon){ const gate=g.mon.gate? shortA(g.mon.gate)+' (custom)' : g.sym; s+=`MON bonus: *on* — hold *${Number(g.mon.holdReq).toLocaleString()} ${gate}* → *${g.mon.perXp} MON* / XP`; }
  else s+=`MON bonus: *off*`;
  bot.sendMessage(msg.chat.id, s, {parse_mode:'Markdown', reply_to_message_id:msg.message_id});
});

// ============ member commands ============
bot.onText(/^\/(rank|me)(?:@\w+)?$/i, async (msg)=>{
  const reply=(t)=>bot.sendMessage(msg.chat.id,t,{parse_mode:'Markdown',reply_to_message_id:msg.message_id});
  const g=DB.groups[msg.chat.id];
  if(!g) return reply('this group isn\u2019t set up yet — an admin runs /setreward <token> <SYM>');
  const usr=u(msg.from.id); await refreshHolds(usr);
  const xp=(usr.g[msg.chat.id]?.xp)||0; const RK=ranksFor(g.sym); const r=rankFor(xp,RK); const nx=nextRank(xp,RK);
  let s=`${r.emoji} *${r.name}* — ${xp} XP\n`;
  if(nx) s+=`next: ${nx.emoji} ${nx.name} at ${nx.at} XP (${nx.at-xp} to go)\n`;
  s+=`\nclaimable ${g.sym}: *${Math.floor(xp*g.perXp).toLocaleString()}*`;
  if(g.mon) s+=`\nclaimable MON: *${usr._holds&&usr._holds[msg.chat.id]? fmt(xp*g.mon.perXp)+' MON' : '🔒 hold '+Number(g.mon.holdReq).toLocaleString()+' '+g.sym}*`;
  if(!usr.wallet) s+=`\n\n⚠️ link a wallet to claim: /wallet 0xYourAddress`;
  reply(s);
});
bot.onText(/^\/bag(?:@\w+)?$/i, (msg)=>{
  const g=DB.groups[msg.chat.id];
  if(!g) return bot.sendMessage(msg.chat.id,'this group isn\u2019t set up yet — an admin runs /setreward <token> <SYM>');
  const RK=ranksFor(g.sym);
  const arr=Object.values(DB.users).map(x=>({name:x.name,xp:(x.g&&x.g[msg.chat.id]?.xp)||0})).filter(x=>x.xp>0).sort((a,b)=>b.xp-a.xp).slice(0,10);
  if(!arr.length) return bot.sendMessage(msg.chat.id,'no one\u2019s earned XP here yet. start chatting 👀');
  let s='🏆 TOP BAGS\n'; arr.forEach((x,i)=>{ const r=rankFor(x.xp,RK); s+=`${i+1}. ${r.emoji} ${x.name||'anon'} — ${x.xp} XP\n`; });
  bot.sendMessage(msg.chat.id,s);
});
bot.onText(/^\/wallet(?:@\w+)?\s*$/i, (msg)=>{
  const usr=u(msg.from.id);
  if(usr.wallet) bot.sendMessage(msg.chat.id,`your linked wallet: ${shortA(usr.wallet)}\nto change it: /wallet 0xYourNewAddress`,{reply_to_message_id:msg.message_id});
  else bot.sendMessage(msg.chat.id,`link your wallet like this:\n/wallet 0xYourAddress\n\n(needed to claim your rewards)`,{reply_to_message_id:msg.message_id});
});
bot.onText(/^\/wallet(?:@\w+)?\s+(\S+)/i, (msg,m)=>{
  const addr=m[1].trim();
  if(!isAddress(addr)) return bot.sendMessage(msg.chat.id,'that\u2019s not a valid 0x address ser',{reply_to_message_id:msg.message_id});
  const lc=addr.toLowerCase();
  for(const id in DB.users){ if(String(id)!==String(msg.from.id) && DB.users[id].wallet && DB.users[id].wallet.toLowerCase()===lc) return bot.sendMessage(msg.chat.id,'that wallet is already linked to another account 🚫',{reply_to_message_id:msg.message_id}); }
  const usr=u(msg.from.id); usr.wallet=addr; usr._chk=0; refreshHolds(usr).then(save);
  bot.sendMessage(msg.chat.id,`wallet linked ✅ claim to ${shortA(addr)} on the site`,{reply_to_message_id:msg.message_id});
});
bot.onText(/^\/claim(?:@\w+)?$/i, async (msg)=>{
  const usr=u(msg.from.id);
  let out='🌿 *Claim your rewards*\n\nclaim on the site (you sign + pay gas, the pool pays you):\n'+CLAIM_URL;
  if(!usr.wallet) out+='\n\n⚠️ link your wallet first: /wallet 0xYourAddress';
  bot.sendMessage(msg.chat.id, out, {parse_mode:'Markdown', reply_to_message_id:msg.message_id});
});
bot.onText(/^\/help(?:@\w+)?$/i, (msg)=>{
  const g=DB.groups[msg.chat.id];
  const head = g ? `chat (${MIN_WORDS}+ words) to earn ${g.perXp} ${g.sym} per XP${g.mon?`. hold ${Number(g.mon.holdReq).toLocaleString()} ${g.sym} to also earn MON.`:'.'}`
                 : `this group isn\u2019t set up yet.`;
  const admin = `\n\n*admin:* /setreward <token> <SYM> [perXp] · /setreward off · /setmon <hold> <monPerXp> [gateToken] | off · /config`;
  bot.sendMessage(msg.chat.id,
`*XP REWARDS*\n${head}\n\n/rank — your XP, rank & claimable\n/bag — leaderboard\n/wallet 0x… — link your wallet\n/claim — claim on the site${admin}`,
  {parse_mode:'Markdown'});
});

// =====================================================================
//   CLAIM SIGNING + HTTP ENDPOINT  (per-token, against the shared pool)
// =====================================================================
function userByWallet(addr){ const lc=addr.toLowerCase(); for(const id in DB.users){ const x=DB.users[id]; if(x.wallet && x.wallet.toLowerCase()===lc) return x; } return null; }

// inner = keccak256(abi.encodePacked(pool, chainId, user, token, cumulative)); sign RAW 32 bytes (EIP-191)
async function signClaim(userAddr, token, cumulativeWei){
  const inner = solidityPackedKeccak256(
    ['address','uint256','address','address','uint256'],
    [POOL_ADDR, CHAIN_ID, userAddr, token, cumulativeWei]
  );
  return await claimSigner.signMessage(getBytes(inner));
}

await resolvePool();

if (claimSigner) {
  const RL=new Map();
  function rateLimited(ip){ const now=Date.now(); let e=RL.get(ip); if(!e||now-e.t>=60000){e={n:0,t:now};RL.set(ip,e);} e.n++; if(RL.size>5000)RL.clear(); return e.n>RL_MAX; }

  http.createServer(async (req,res)=>{
    res.setHeader('Access-Control-Allow-Origin',CORS_ORIGIN);
    res.setHeader('Content-Type','application/json');
    try{
      const ip=(req.socket&&req.socket.remoteAddress)||'?';
      if(rateLimited(ip)){ res.writeHead(429); return res.end('{"error":"rate limited"}'); }
      const url=new URL(req.url,'http://x');
      if(url.pathname!=='/claim'){ res.writeHead(404); return res.end('{"error":"not found"}'); }
      const wallet=(url.searchParams.get('wallet')||'').trim();
      if(!isAddress(wallet)){ res.writeHead(400); return res.end('{"error":"bad wallet"}'); }

      const usr=userByWallet(wallet);
      if(!usr){ res.writeHead(200); return res.end(JSON.stringify({found:false,message:'wallet not linked to any XP account — use /wallet in the group'})); }
      if(!PAYOUTS_ENABLED){ res.writeHead(200); return res.end(JSON.stringify({found:true,payoutsDisabled:true,xp:totalXp(usr),message:'claims are paused right now — check back soon 🌿'})); }

      await refreshHolds(usr);
      const { byToken, monWei } = owed(usr);
      const now=Date.now(); usr.harvest=usr.harvest||{};
      const entries=[];

      // helper: harvest-cooldown bookkeeping per token
      async function cd(tl, onchain){ const h=usr.harvest[tl]||{last:0,seen:'0'}; if(onchain>BigInt(h.seen||'0')){ h.last=now; h.seen=onchain.toString(); } usr.harvest[tl]=h; const wait=CLAIM_COOLDOWN_MS-(now-(h.last||0)); return { on: !!(h.last&&wait>0), days: Math.ceil(Math.max(0,wait)/86400000) }; }

      for(const tl in byToken){
        const {wei,dec,sym,addr}=byToken[tl]; if(wei<=0n) continue;
        let onchain=0n; try{ onchain=await pool.claimed(wallet,addr); }catch{}
        const c=await cd(tl,onchain);
        entries.push({ token:addr, symbol:sym, decimals:dec, cumulative:wei.toString(), claimed:onchain.toString(),
          cooldown:c.on, cooldownDays:c.days, signature: c.on? null : await signClaim(wallet,addr,wei) });
      }

      if(monWei>0n){
        let onMon=0n; try{ onMon=await pool.claimed(wallet,NATIVE); }catch{}
        const minWei=parseEther(String(MIN_CLAIM_MON)), capWei=parseEther(String(MAX_USER_DAILY));
        let authMon=onMon; const newOwed= monWei>onMon? monWei-onMon : 0n;
        if(newOwed>=minWei) authMon = onMon + (newOwed>capWei? capWei : newOwed);
        if(authMon>monWei) authMon=monWei;
        const c=await cd(NATIVE,onMon);
        entries.push({ token:NATIVE, symbol:'MON', decimals:18, cumulative:authMon.toString(), claimed:onMon.toString(),
          cooldown:c.on, cooldownDays:c.days, floorNotMet:(newOwed>0n && newOwed<minWei),
          signature: (c.on || authMon<=onMon)? null : await signClaim(wallet,NATIVE,authMon) });
      }

      save();
      res.writeHead(200);
      res.end(JSON.stringify({ found:true, xp:totalXp(usr), pool:POOL_ADDR, entries }));
    }catch(e){ res.writeHead(500); res.end(JSON.stringify({error:String(e&&e.message||e)})); }
  })
  .listen(API_PORT, ()=>console.log('claim API on :'+API_PORT+' (/claim?wallet=0x..) · signing '+(PAYOUTS_ENABLED?'ENABLED':'DISABLED — set PAYOUTS_ENABLED=true')))
  .on('error', e=>console.error('claim API listen error:', e.message));
} else {
  console.log('claim API disabled (set SIGNER_PRIVATE_KEY to enable)');
}

bot.on('polling_error', e=>console.error('polling:',e.message));
bot.getMe().then(m=>console.log(`XP bot online as @${m.username} · pool ${POOL_ADDR} · payouts ${PAYOUTS_ENABLED?'ON':'OFF'}`));
