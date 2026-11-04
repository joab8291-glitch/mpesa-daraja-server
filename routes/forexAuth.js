const express=require("express");
const crypto=require("crypto");
const rateLimit=require("express-rate-limit");
const {hashPassword,verifyPassword}=require("../utils/forexPasswords");
const db=require("../utils/forexAuthDb");
const market=require("../utils/forexMarket");
const router=express.Router();
const limiter=rateLimit({windowMs:15*60*1000,max:12,standardHeaders:true,legacyHeaders:false});
const apiLimit=rateLimit({windowMs:5*60*1000,max:180,standardHeaders:true,legacyHeaders:false});
function secret(){const s=process.env.FOREX_AUTH_SECRET;if(!s||s.length<32)throw new Error("FOREX_AUTH_SECRET must be at least 32 characters");return s;}
function tokenFor(user){const now=Math.floor(Date.now()/1000);const h=Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");const p=Buffer.from(JSON.stringify({sub:user.id,email:user.email,iat:now,exp:now+604800})).toString("base64url");const body=h+"."+p;return body+"."+crypto.createHmac("sha256",secret()).update(body).digest("base64url");}
function decodeToken(t){try{const a=String(t||"").split(".");if(a.length!==3)return null;const body=a[0]+"."+a[1];const expected=crypto.createHmac("sha256",secret()).update(body).digest();const actual=Buffer.from(a[2],"base64url");if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return null;const p=JSON.parse(Buffer.from(a[1],"base64url").toString());return p.exp>Date.now()/1000?p:null;}catch{return null;}}
async function auth(req,res,next){try{const m=/^Bearer\s+(.+)$/i.exec(req.get("authorization")||"");const p=m&&decodeToken(m[1]);if(!p)return res.status(401).json({error:"Session expired. Sign in again."});const u=await db.findUserById(p.sub);if(!u)return res.status(401).json({error:"Account not found."});req.forexUser=u;next();}catch(e){console.error("Forex auth:",e.message);res.status(503).json({error:"Authentication service unavailable."});}}
const safe=u=>({id:u.id,email:u.email,displayName:u.display_name||u.displayName});
router.post("/auth/register",limiter,async(req,res)=>{const email=String(req.body?.email||"").trim().toLowerCase();const displayName=String(req.body?.displayName||"").trim().slice(0,80);const password=String(req.body?.password||"");if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)return res.status(400).json({error:"Enter a valid email address."});if(displayName.length<2)return res.status(400).json({error:"Enter your name."});if(password.length<10||password.length>128)return res.status(400).json({error:"Password must be 10–128 characters."});try{const h=await hashPassword(password);const u=await db.createUser({id:crypto.randomUUID(),email,displayName,passwordHash:h.hash,passwordSalt:h.salt});return res.status(201).json({token:tokenFor(u),user:safe(u)});}catch(e){if(e.code==="23505")return res.status(409).json({error:"Email already registered. Please sign in."});console.error("Forex register:",e.message);return res.status(500).json({error:"Could not create account."});}});
router.post("/auth/login",limiter,async(req,res)=>{const email=String(req.body?.email||"").trim().toLowerCase();const password=String(req.body?.password||"");try{const u=await db.findUserByEmail(email);if(!u||!(await verifyPassword(password,u.password_salt,u.password_hash)))return res.status(401).json({error:"Email or password is incorrect."});return res.json({token:tokenFor(u),user:safe(u)});}catch(e){console.error("Forex login:",e.message);return res.status(503).json({error:"Could not sign in."});}});
router.get("/auth/me",apiLimit,auth,(req,res)=>res.json({user:safe(req.forexUser)}));
router.post("/auth/logout",apiLimit,auth,(_req,res)=>res.json({ok:true}));
router.get("/quotes",apiLimit,(req,res)=>{const market=require("../utils/forexMarket");return res.json({quotes:market.getQuotes(),provider:"Twelve Data",streaming:Boolean(process.env.TWELVE_DATA_API_KEY)});});
router.get("/account",apiLimit,auth,async(req,res)=>{try{return res.json({account:await db.getPaperAccount(req.forexUser.id)});}catch(e){console.error("Forex paper account:",e.message);return res.status(500).json({error:"Could not load your practice account."});}});
router.get("/trades",apiLimit,auth,async(req,res)=>{try{return res.json({trades:await db.listTrades(req.forexUser.id)});}catch(e){console.error(e.message);return res.status(500).json({error:"Could not load practice trades."});}});
router.post("/trades",apiLimit,auth,async(req,res)=>{
  const t=req.body||{};
  const allowedSymbols=new Set(["EUR/USD","GBP/USD","USD/JPY","AUD/USD","USD/CAD","USD/CHF"]);
  const quantity=Number(t.quantity);
  const quote=market.getQuotes().find(q=>q.symbol===t.symbol);
  if(!quote||!quote.timestamp||Date.now()/1000-quote.timestamp>30) return res.status(503).json({error:"Fresh quote unavailable. Try again when the market feed is connected."});
  const entryPrice=t.side==="buy"?Number(quote.ask):Number(quote.bid);
  const stopLoss=t.stopLoss===null||t.stopLoss===undefined||t.stopLoss===""?null:Number(t.stopLoss);
  const takeProfit=t.takeProfit===null||t.takeProfit===undefined||t.takeProfit===""?null:Number(t.takeProfit);
  if(typeof t.symbol!=="string"||!allowedSymbols.has(t.symbol)||!["buy","sell"].includes(t.side)||
    !Number.isSafeInteger(quantity)||quantity<1000||quantity>1000000||
    !Number.isFinite(entryPrice)||entryPrice<=0||
    (stopLoss!==null&&(!Number.isFinite(stopLoss)||stopLoss<=0))||
    (takeProfit!==null&&(!Number.isFinite(takeProfit)||takeProfit<=0))){
    return res.status(400).json({error:"Invalid practice trade details. Check the market, whole-unit size and prices."});
  }
  if((t.side==="buy"&&((stopLoss!==null&&stopLoss>=entryPrice)||(takeProfit!==null&&takeProfit<=entryPrice)))||
     (t.side==="sell"&&((stopLoss!==null&&stopLoss<=entryPrice)||(takeProfit!==null&&takeProfit>=entryPrice)))){
    return res.status(400).json({error:t.side==="buy"?"For a buy trade, stop loss must be below entry and take profit above entry.":"For a sell trade, stop loss must be above entry and take profit below entry."});
  }
  try{
    const trade=await db.createTrade(req.forexUser.id,{symbol:t.symbol,side:t.side,quantity,entryPrice,stopLoss,takeProfit});
    return res.status(201).json({trade});
  }catch(e){
    console.error("Forex practice trade create failed:",e.message);
    if(e.code==="INSUFFICIENT_MARGIN") return res.status(422).json({error:e.message});
    return res.status(500).json({error:"Could not save practice trade."});
  }
});
router.patch("/trades/:id/close",apiLimit,auth,async(req,res)=>{
  const exitPrice=Number(req.body?.exitPrice);
  if(!Number.isFinite(exitPrice)||exitPrice<=0) return res.status(400).json({error:"Exit price is invalid."});
  try {
    const trade=await db.closeTrade(req.forexUser.id,req.params.id,exitPrice);
    if(!trade) return res.status(404).json({error:"Open practice trade not found."});
    const account=await db.getPaperAccount(req.forexUser.id);
    return res.json({trade,account});
  } catch(e) {
    console.error("Forex practice trade close failed:",e.message);
    return res.status(500).json({error:"Could not close practice trade."});
  }
});

module.exports={router,auth};
