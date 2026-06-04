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
const MON_PER_XP        = Number(process.env.MON_PER_XP || '0.001');   // MON earned per XP point
const MIN_CLAIM_MON     = Number(process.env.MIN_CLAIM_MON || '10');   // can't claim until you've built up this much
const MAX_USER_DAILY    = Number(process.env.MAX_USER_DAILY_MON || '25');   // per-user daily payout cap
const MAX_TOTAL_DAILY   = Number(process.env.MAX_TOTAL_DAILY_MON || '200');  // whole-bot daily payout cap
const CLAIM_COOLDOWN_MS = Number(process.env.CLAIM_COOLDOWN_MIN || '720') * 60000; // default 12h between claims

// XP earning
const XP_PER_MSG    = Number(process.env.XP_PER_MSG || '5');
const XP_COOLDOWN_MS= Number(process.env.XP_COOLDOWN_SEC || '60') * 1000; // max one XP gain per this window

// safety master switch — payouts stay OFF until you set this true in .env
const PAYOUTS_ENABLED = String(process.env.PAYOUTS_ENABLED || 'false').toLowerCase() === 'true';
const PAYOUT_PK = process.env.PAYOUT_PRIVATE_KEY || '';

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
function u(id){ if(!DB.users[id]) DB.users[id]={ xp:0, claimedMon:0, wallet:'', lastXp:0, lastClaim:0, name:'' }; return DB.users[id]; }
load();

const claimable = (usr)=> Math.max(0, usr.xp*MON_PER_XP - usr.claimedMon);
const fmt=(n)=> (Math.round(n*10000)/10000).toString();

// ============ XP earning ============
bot.on('message', (msg)=>{
  try{
    if(!msg.text || msg.from?.is_bot) return;       // no XP for bots/anon
    if(msg.text.startsWith('/')) return;            // commands don't grant XP
    const usr=u(msg.from.id); usr.name = msg.from.username? '@'+msg.from.username : (msg.from.first_name||'anon');
    const now=Date.now();
    if(now-usr.lastXp >= XP_COOLDOWN_MS){ usr.xp+=XP_PER_MSG; usr.lastXp=now; save(); }
  }catch(e){ console.error('xp:',e.message); }
});

// ============ commands ============
bot.onText(/^\/(rank|me)(?:@\w+)?$/i, (msg)=>{
  const usr=u(msg.from.id); const r=rankFor(usr.xp,RANKS); const nx=nextRank(usr.xp,RANKS);
  let s=`${r.emoji} *${r.name}* — ${usr.xp} XP\n`;
  if(nx) s+=`next: ${nx.emoji} ${nx.name} at ${nx.at} XP (${nx.at-usr.xp} to go)\n`;
  s+=`\nclaimable: *${fmt(claimable(usr))} MON*`;
  if(claimable(usr) < MIN_CLAIM_MON) s+=`  (claim opens at ${MIN_CLAIM_MON})`;
  if(!usr.wallet) s+=`\n\n⚠️ link a wallet to claim: /wallet 0xYourAddress`;
  bot.sendMessage(msg.chat.id, s, {parse_mode:'Markdown', reply_to_message_id:msg.message_id});
});

bot.onText(/^\/top(?:@\w+)?$/i, (msg)=>{
  const arr=Object.values(DB.users).filter(x=>x.xp>0).sort((a,b)=>b.xp-a.xp).slice(0,10);
  if(!arr.length) return bot.sendMessage(msg.chat.id,'no one\u2019s earned XP yet. start chatting 👀');
  let s='🏆 *TOP ACTIVE*\n'; arr.forEach((x,i)=>{ const r=rankFor(x.xp,RANKS); s+=`${i+1}. ${r.emoji} ${x.name||'anon'} — ${x.xp} XP\n`; });
  bot.sendMessage(msg.chat.id,s,{parse_mode:'Markdown'});
});

bot.onText(/^\/wallet(?:@\w+)?\s+(\S+)/i, (msg,m)=>{
  const addr=m[1].trim();
  if(!isAddress(addr)) return bot.sendMessage(msg.chat.id,'that\u2019s not a valid 0x address ser',{reply_to_message_id:msg.message_id});
  const usr=u(msg.from.id); usr.wallet=addr; save();
  bot.sendMessage(msg.chat.id,`wallet linked ✅ payouts (when live) go to ${addr.slice(0,6)}…${addr.slice(-4)}`,{reply_to_message_id:msg.message_id});
});

const claiming=new Set();
bot.onText(/^\/claim(?:@\w+)?$/i, async (msg)=>{
  const id=msg.from.id; const usr=u(id);
  if(claiming.has(id)) return;
  try{
    rollDaily();
    if(!PAYOUTS_ENABLED) return bot.sendMessage(msg.chat.id,'💤 payouts aren\u2019t live yet — keep stacking XP, claims open soon.',{reply_to_message_id:msg.message_id});
    if(!usr.wallet) return bot.sendMessage(msg.chat.id,'link a wallet first: /wallet 0xYourAddress',{reply_to_message_id:msg.message_id});
    const amt=claimable(usr);
    if(amt < MIN_CLAIM_MON) return bot.sendMessage(msg.chat.id,`you\u2019ve got ${fmt(amt)} MON claimable — need ${MIN_CLAIM_MON} to claim. stay active 🌿`,{reply_to_message_id:msg.message_id});
    if(Date.now()-usr.lastClaim < CLAIM_COOLDOWN_MS) return bot.sendMessage(msg.chat.id,'you claimed recently — cooldown\u2019s still going. come back later.',{reply_to_message_id:msg.message_id});
    // daily caps
    const userToday=DB.daily.perUser[id]||0;
    let pay=Math.min(amt, MAX_USER_DAILY-userToday, MAX_TOTAL_DAILY-DB.daily.total);
    if(pay<=0) return bot.sendMessage(msg.chat.id,'daily payout cap hit — try again tomorrow 🫡',{reply_to_message_id:msg.message_id});
    // holder gate
    if(token){
      const bal=await token.balanceOf(usr.wallet).catch(()=>0n);
      const need=parseUnits(HOLD_REQ, TOKEN_DEC);
      if(bal < need) return bot.sendMessage(msg.chat.id,`you need to hold at least ${Number(HOLD_REQ).toLocaleString()} ${TOKEN_SYM} to claim. (anti-farm) 🌿`,{reply_to_message_id:msg.message_id});
    }
    if(!payoutWallet) return bot.sendMessage(msg.chat.id,'payout wallet not configured — ping the admin.',{reply_to_message_id:msg.message_id});
    claiming.add(id);
    bot.sendMessage(msg.chat.id,`sending ${fmt(pay)} MON… ⛽`,{reply_to_message_id:msg.message_id});
    const tx=await payoutWallet.sendTransaction({ to: usr.wallet, value: parseEther(fmt(pay)) });
    await tx.wait(1);
    usr.claimedMon += pay; usr.lastClaim=Date.now();
    DB.daily.total += pay; DB.daily.perUser[id]=userToday+pay; save();
    bot.sendMessage(msg.chat.id,`✅ sent ${fmt(pay)} MON 🌿\ntx: ${tx.hash}`,{reply_to_message_id:msg.message_id});
  }catch(e){
    console.error('claim:',e.message);
    bot.sendMessage(msg.chat.id,'claim failed — payout wallet may be low on MON, or network hiccup. ping admin if it keeps happening.',{reply_to_message_id:msg.message_id});
  }finally{ claiming.delete(id); }
});

bot.onText(/^\/help(?:@\w+)?$/i, (msg)=>{
  bot.sendMessage(msg.chat.id,
`*${PROJECT.toUpperCase()} XP*\nchat to earn XP and climb the ranks. hold ${Number(HOLD_REQ).toLocaleString()} ${TOKEN_SYM} to claim MON rewards.\n\n/rank — your XP, rank & claimable MON\n/top — leaderboard\n/wallet 0x… — link your wallet\n/claim — claim MON (opens at ${MIN_CLAIM_MON})`,
  {parse_mode:'Markdown'});
});

bot.on('polling_error', e=>console.error('polling:',e.message));
bot.getMe().then(m=>console.log(`XP bot [${PROJECT}] online as @${m.username} · payouts ${PAYOUTS_ENABLED?'ON':'OFF'}`));
