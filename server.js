const express=require("express"),session=require("express-session"),http=require("http"),path=require("path"),sqlite3=require("sqlite3").verbose(),crypto=require("crypto");
const {Server}=require("socket.io"); const app=express(),srv=http.createServer(app),io=new Server(srv);
const PORT=process.env.PORT||3000,SECRET=process.env.SESSION_SECRET||"change-this-secret";
app.use(express.json()); app.use(session({secret:SECRET,resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:"lax"}}));
app.use(express.static(path.join(__dirname,"public")));
const db=new sqlite3.Database(path.join(__dirname,"coinrush.sqlite"));
const run=(s,p=[])=>new Promise((r,j)=>db.run(s,p,function(e){e?j(e):r({id:this.lastID,changes:this.changes})}));
const get=(s,p=[])=>new Promise((r,j)=>db.get(s,p,(e,x)=>e?j(e):r(x)));
const all=(s,p=[])=>new Promise((r,j)=>db.all(s,p,(e,x)=>e?j(e):r(x)));
async function init(){await run(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT UNIQUE,password TEXT,role TEXT,balance INTEGER,created_at INTEGER)`);
await run(`CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,amount INTEGER,type TEXT,reason TEXT,created_at INTEGER)`);
await run(`CREATE TABLE IF NOT EXISTS bets(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,round_id INTEGER,side TEXT,amount INTEGER,created_at INTEGER)`);
if(!await get("SELECT id FROM users WHERE username=?",["admin"])){let n=Date.now(),x=await run("INSERT INTO users(username,password,role,balance,created_at) VALUES(?,?,?,?,?)",["admin","admin123","admin",10000,n]);await run("INSERT INTO ledger(user_id,amount,type,reason,created_at) VALUES(?,?,?,?,?)",[x.id,10000,"credit","Initial admin balance",n]);}}
let round={id:1,endAt:Date.now()+30000,result:null};
async function stats(){let x=await all("SELECT side,SUM(amount) total,COUNT(*) players FROM bets WHERE round_id=? GROUP BY side",[round.id]);let h=x.find(a=>a.side==="HEADS"),t=x.find(a=>a.side==="TAILS");return{heads:h?.total||0,tails:t?.total||0,players:(h?.players||0)+(t?.players||0)}}
async function finish(){if(round.result)return;round.result=crypto.randomInt(0,2)?"TAILS":"HEADS";io.emit("round_result",{round:round.id,result:round.result});setTimeout(()=>{round={id:round.id+1,endAt:Date.now()+30000,result:null};stats().then(x=>io.emit("public_stats",x))},1000)}
setInterval(()=>Date.now()>=round.endAt&&finish().catch(console.error),250);
const login=(req,res,next)=>req.session.userId?next():res.status(401).json({error:"Login required"});
const admin=async(req,res,next)=>{if(!req.session.userId)return res.status(401).json({error:"Login required"});let u=await get("SELECT role FROM users WHERE id=?",[req.session.userId]);u?.role==="admin"?next():res.status(403).json({error:"Admin only"})};
app.post("/api/login",async(req,res)=>{let u=await get("SELECT id,username,role,balance FROM users WHERE username=? AND password=?",[String(req.body.username||"").trim(),String(req.body.password||"")]);if(!u)return res.status(401).json({error:"Invalid username or password"});req.session.userId=u.id;res.json(u)});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/me",login,async(req,res)=>res.json(await get("SELECT id,username,role,balance FROM users WHERE id=?",[req.session.userId])));
app.get("/api/round",login,async(req,res)=>res.json({round:{id:round.id,end_at:round.endAt,result:round.result},own:await all("SELECT id,round_id,side,amount,created_at FROM bets WHERE user_id=? ORDER BY id DESC LIMIT 20",[req.session.userId])}));
app.post("/api/bet",login,async(req,res)=>{if(Date.now()>=round.endAt||round.result)return res.status(400).json({error:"Round is closed"});let side=String(req.body.side||"").toUpperCase(),amt=Number(req.body.amount);if(!["HEADS","TAILS"].includes(side)||!Number.isInteger(amt)||amt<1)return res.status(400).json({error:"Invalid bet"});let u=await get("SELECT balance FROM users WHERE id=?",[req.session.userId]);if(u.balance<amt)return res.status(400).json({error:"Insufficient virtual coins"});await run("UPDATE users SET balance=balance-? WHERE id=?",[amt,req.session.userId]);await run("INSERT INTO bets(user_id,round_id,side,amount,created_at) VALUES(?,?,?,?,?)",[req.session.userId,round.id,side,amt,Date.now()]);await run("INSERT INTO ledger(user_id,amount,type,reason,created_at) VALUES(?,?,?,?,?)",[req.session.userId,-amt,"bet",`Round ${round.id} ${side}`,Date.now()]);io.emit("public_stats",await stats());res.json({ok:true})});
app.get("/api/admin/stats",admin,async(req,res)=>res.json(await stats()));
app.get("/api/admin/users",admin,async(req,res)=>res.json(await all("SELECT id,username,role,balance,created_at FROM users ORDER BY id DESC")));
app.get("/api/admin/ledger",admin,async(req,res)=>res.json(await all("SELECT ledger.id,users.username,ledger.amount,ledger.type,ledger.reason,ledger.created_at FROM ledger JOIN users ON users.id=ledger.user_id ORDER BY ledger.id DESC LIMIT 100")));
app.post("/api/admin/users/:id/coins",admin,async(req,res)=>{let id=Number(req.params.id),amt=Number(req.body.amount),u=await get("SELECT balance FROM users WHERE id=?",[id]);if(!u||!Number.isInteger(amt)||!amt||u.balance+amt<0)return res.status(400).json({error:"Invalid adjustment"});await run("UPDATE users SET balance=balance+? WHERE id=?",[amt,id]);await run("INSERT INTO ledger(user_id,amount,type,reason,created_at) VALUES(?,?,?,?,?)",[id,amt,amt>0?"admin_credit":"admin_debit",String(req.body.reason||"Admin adjustment"),Date.now()]);res.json({ok:true,balance:u.balance+amt})});
io.on("connection",s=>stats().then(x=>s.emit("public_stats",x)));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
init().then(()=>srv.listen(PORT,"0.0.0.0",()=>console.log("CoinRush on "+PORT))).catch(e=>{console.error(e);process.exit(1)});
