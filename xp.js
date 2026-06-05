import 'dotenv/config';
import fs from 'fs';
import TelegramBot from 'node-telegram-bot-api';
import { JsonRpcProvider, Wallet, Contract, parseEther, formatEther, parseUnits, isAddress } from 'ethers';
import { RANKSETS, rankFor, nextRank } from './ranks.js';

// ============ CONFIG (all from .env) ============
const TG_TOKEN   = process.env.TG_BOT_TOKEN;
const PROJECT    = (process.env.PROJECT || 'chronic').toLowerCase();
const RPC        = process.env.MONAD_RPC || 'https://monad-mainnet.g.alchemy.com/v2/_ZfKSl1YD2Yur6eajfKkN';
const TOKEN_ADDR = process.env.TOKEN_ADDRESS || '';            // token they must hold (e.g. CHRONIC)
const TOKEN_SYM  = process.env.TOKEN_SYMBOL  || 'CHRONIC';
const HOLD_REQ   = process.env.HOLD_REQUIRED || '1000000';     // must hold this many tokens to claim
const TOKEN_DEC  = Number(process.env.TOKEN_DECIMALS || '18');

// economics — tune to YOUR budget
const CHRONIC_PER_XP    = Number(process.env.CHRONIC_PER_XP || '2');    // CHRONIC earned per XP (everyone)
const MON_PER_XP        = Number(process.env.MON_PER_XP || '0.001');   // MON earned per XP (1M holders only)
const MIN_CLAIM_MON     = Number(process.env.MIN_CLAIM_MON || '10');   // can't claim until you've built up this much
const MAX_USER_DAILY    = Number(process.env.MAX_USER_DAILY_MON || '25');   // per-user daily payout cap
const MAX_TOTAL_DAILY   = Number(process.env.MAX_TOTAL_DAILY_MON || '200');  // whole-bot daily payout cap
const CLAIM_COOLDOWN_MS = Number(process.env.CLAIM_COOLDOWN_MIN || '720') * 60000; // default 12h between claims

// XP earning
const XP_PER_MSG    = Number(process.env.XP_PER_MSG || '5');
const MIN_WORDS     = Number(process.env.MIN_WORDS || '3');   // messages shorter than this earn no XP (anti-farm)
const XP_COOLDOWN_MS= Number(process.env.XP_COOLDOWN_SEC || '60') * 1000; // max one XP gain per this window

// safety master switch — payouts stay OFF until you set this true in .env
const PAYOUTS_ENABLED = String(process.env.PAYOUTS_ENABLED || 'false').toLowerCase() === 'true';
const PAYOUT_PK = process.env.PAYOUT_PRIVATE_KEY || '';
const CLAIM_URL = process.env.CLAIM_URL || 'https://burnchronic.xyz/claim';

if (!TG_TOKEN) { console.error('Missing TG_BOT_TOKEN'); process.exit(1); }

const bot = new TelegramBot(TG_TOKEN, { polling: true });
const RANKS = RANKSETS[PROJECT] || RANKSETS.default;

// chain (only needed for payouts/holder check)
let provider=null, payoutWallet=null, token=null;
try {
  provider = new JsonRpcProvider(RPC, 143);
  if (PAYOUT_PK) payoutWallet = new Wallet(PAYOUT_PK, provider);
  if (TOKEN_ADDR) token = new Contract(TOKEN_ADDR, ['function balanceOf(address) view returns (uint256)'], provider);
} catch (e) { console.error('chain init:', e.message); }

// ============ PERSISTENCE ============
const DB_FILE = './data.json';
let DB = { users: {}, daily: { date: today(), total: 0, perUser: {} } };
function today(){ return new Date().toISOString().slice(0,10); }
function load(){ try { DB = JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch { /* fresh */ } if(!DB.users)DB.users={}; if(!DB.daily)DB.daily={date:today(),total:0,perUser:{}}; }
let saveT=null;
function save(){ clearTimeout(saveT); saveT=setTimeout(()=>{ try{ fs.writeFileSync(DB_FILE, JSON.stringify(DB)); }catch(e){console.error('save:',e.message);} }, 400); }
function rollDaily(){ if(DB.daily.date!==today()){ DB.daily={date:today(),total:0,perUser:{}}; save(); } }
function u(id){ if(!DB.users[id]) DB.users[id]={ xp:0, claimedChronic:0, claimedMon:0, wallet:'', lastXp:0, lastClaim:0, name:'' }; return DB.users[id]; }
load();


// check if a wallet holds >= HOLD_REQ token (gates MON rewards). caches on the user record.
async function refreshHolds(usr){
  if(!token || !usr.wallet){ usr.holds1M=false; return; }
  try{ const bal=await token.balanceOf(usr.wallet); usr.holds1M = bal >= parseUnits(HOLD_REQ, TOKEN_DEC); }
  catch{ /* leave previous value */ }
}
const claimableChronic = (usr)=> Math.max(0, usr.xp*CHRONIC_PER_XP - (usr.claimedChronic||0));
const claimableMon     = (usr)=> Math.max(0, usr.xp*MON_PER_XP - (usr.claimedMon||0));
const fmt=(n)=> (Math.round(n*10000)/10000).toString();

// ============ XP earning ============
bot.on('message', (msg)=>{
  try{
    if(!msg.text || msg.text.startsWith('/')) return;     // commands don't grant XP
    // allow real bots through ONLY if they're the anonymous-admin proxy (that's an admin posting as the group)
    if(msg.from?.is_bot && msg.from?.username !== 'GroupAnonymousBot') return;
    // anti-farm: messages under MIN_WORDS words earn nothing (kills 'gm'/'lol' spam)
    if(msg.text.trim().split(/\s+/).filter(Boolean).length < MIN_WORDS) return;
    const isAnon = msg.from?.username === 'GroupAnonymousBot';
    const usr=u(msg.from.id);
    usr.name = isAnon ? '👑 admin' : (msg.from.username? '@'+msg.from.username : (msg.from.first_name||'anon'));
    const now=Date.now();
    if(now-usr.lastXp >= XP_COOLDOWN_MS){ usr.xp+=XP_PER_MSG; usr.lastXp=now; save(); }
  }catch(e){ console.error('xp:',e.message); }
});

// ============ commands ============
bot.onText(/^\/(rank|me)(?:@\w+)?$/i, async (msg)=>{
  const usr=u(msg.from.id); await refreshHolds(usr); const r=rankFor(usr.xp,RANKS); const nx=nextRank(usr.xp,RANKS);
  let s=`${r.emoji} *${r.name}* — ${usr.xp} XP\n`;
  if(nx) s+=`next: ${nx.emoji} ${nx.name} at ${nx.at} XP (${nx.at-usr.xp} to go)\n`;
  s+=`\nclaimable ${TOKEN_SYM}: *${claimableChronic(usr).toLocaleString()}*`;
  s+=`\nclaimable MON: *${usr.holds1M? fmt(claimableMon(usr))+' MON' : '🔒 hold 1M '+TOKEN_SYM}*`;
  if(!usr.wallet) s+=`\n\n⚠️ link a wallet to claim: /wallet 0xYourAddress`;
  bot.sendMessage(msg.chat.id, s, {parse_mode:'Markdown', reply_to_message_id:msg.message_id});
});

bot.onText(/^\/bag(?:@\w+)?$/i, (msg)=>{
  const arr=Object.values(DB.users).filter(x=>x.xp>0).sort((a,b)=>b.xp-a.xp).slice(0,10);
  if(!arr.length) return bot.sendMessage(msg.chat.id,'no one\u2019s earned XP yet. start chatting 👀');
  let s='🏆 TOP BAGS\n'; arr.forEach((x,i)=>{ const r=rankFor(x.xp,RANKS); s+=`${i+1}. ${r.emoji} ${x.name||'anon'} — ${x.xp} XP\n`; });
  bot.sendMessage(msg.chat.id,s);
});

bot.onText(/^\/wallet(?:@\w+)?\s*$/i, (msg)=>{
  const usr=u(msg.from.id);
  if(usr.wallet) bot.sendMessage(msg.chat.id,`your linked wallet: ${usr.wallet.slice(0,6)}…${usr.wallet.slice(-4)}\nto change it: /wallet 0xYourNewAddress`,{reply_to_message_id:msg.message_id});
  else bot.sendMessage(msg.chat.id,`link your wallet like this:\n/wallet 0xYourAddress\n\n(needed to claim your ${TOKEN_SYM} rewards)`,{reply_to_message_id:msg.message_id});
});
bot.onText(/^\/wallet(?:@\w+)?\s+(\S+)/i, (msg,m)=>{
  const addr=m[1].trim();
  if(!isAddress(addr)) return bot.sendMessage(msg.chat.id,'that\u2019s not a valid 0x address ser',{reply_to_message_id:msg.message_id});
  const usr=u(msg.from.id); usr.wallet=addr; refreshHolds(usr).then(save);
  bot.sendMessage(msg.chat.id,`wallet linked ✅ claim to ${addr.slice(0,6)}…${addr.slice(-4)} on the site`,{reply_to_message_id:msg.message_id});
});

bot.onText(/^\/claim(?:@\w+)?$/i, async (msg)=>{
  const usr=u(msg.from.id); await refreshHolds(usr);
  let out='🌿 *Claim your rewards*\n';
  out+=`you've earned *${claimableChronic(usr).toLocaleString()} ${TOKEN_SYM}*`;
  if(usr.holds1M) out+=` + *${fmt(claimableMon(usr))} MON*`;
  out+='\n\nclaim on the site (you sign + pay gas, the pool pays you):\n'+CLAIM_URL;
  if(!usr.wallet) out+='\n\n⚠️ link your wallet first: /wallet 0xYourAddress';
  bot.sendMessage(msg.chat.id, out, {parse_mode:'Markdown', reply_to_message_id:msg.message_id});
})

bot.onText(/^\/help(?:@\w+)?$/i, (msg)=>{
  bot.sendMessage(msg.chat.id,
`*${PROJECT.toUpperCase()} XP*\nchat (3+ words) to earn XP + ${TOKEN_SYM}. hold ${Number(HOLD_REQ).toLocaleString()} ${TOKEN_SYM} to also earn MON.\n\n/rank — your XP, rank & claimable\n/bag — leaderboard\n/wallet 0x… — link your wallet\n/claim — how to claim`,
  {parse_mode:'Markdown'});
});

bot.on('polling_error', e=>console.error('polling:',e.message));
bot.getMe().then(m=>console.log(`XP bot [${PROJECT}] online as @${m.username} · payouts ${PAYOUTS_ENABLED?'ON':'OFF'}`));
