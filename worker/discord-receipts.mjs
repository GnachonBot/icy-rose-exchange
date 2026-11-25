// Per-user authentication: never store passwords or session tokens in public GitHub files.
const AUTH_ITERATIONS = 100000;
const AUTH_SESSION_SECONDS = 12 * 3600;
const AUTH_FIRST_LOGIN_SECONDS = 15 * 60;
const AUTH_MAX_FAILURES = 7;
const AUTH_LOCK_SECONDS = 15 * 60;
const authEncoder = new TextEncoder();
const bytesHex = buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2,'0')).join('');
function randomHex(count=32){const b=new Uint8Array(count);crypto.getRandomValues(b);return bytesHex(b);}
async function sha256(text){return bytesHex(await crypto.subtle.digest('SHA-256',authEncoder.encode(text)));}
async function authHash(password,salt,iterations=AUTH_ITERATIONS){
  const k=await crypto.subtle.importKey('raw',authEncoder.encode(password),'PBKDF2',false,['deriveBits']);
  return bytesHex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:new Uint8Array(salt.match(/../g).map(x=>parseInt(x,16))),iterations},k,256));
}
function userPublic(u){return {id:u.id,name:u.username,role:u.role,mustChange:!!u.must_change};}
function authValidName(name){
  if(typeof name!=='string')throw Error('Enter a username');
  name=name.trim();
  assert(/^[a-zA-Z0-9 _-]{2,35}$/.test(name),'Usernames must be 2–35 letters, numbers, spaces, _ or -');
  return name;
}
function authValidPassword(password){
  assert(typeof password==='string'&&password.length>=6&&password.length<=128,'Password must be 6–128 characters');
  return password;
}
async function getAuthSession(env,request){
  const header=request.headers.get('Authorization')||'';
  const match=header.match(/^Bearer ([a-f0-9]{64})$/i);
  if(!match)return null;
  const tokenHash=await sha256(match[1]);
  const row=await env.DB.prepare(`SELECT s.token_hash,s.expires_at,u.id,u.username,u.role,u.must_change,u.disabled
    FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=?`).bind(tokenHash).first();
  if(!row||row.disabled||row.expires_at<=Math.floor(Date.now()/1000))return null;
  return {tokenHash,user:row};
}
function authRequire(session,role='staff'){
  if(!session)throw Object.assign(Error('Please sign in again'),{httpStatus:401});
  if(session.user.must_change)throw Object.assign(Error('Set your personal password before continuing'),{httpStatus:403});
  if(role==='admin'&&session.user.role!=='admin')throw Object.assign(Error('Admins only'),{httpStatus:403});
  return session.user;
}
async function authLogin(env,body,origin){
  const name=authValidName(body?.username||'');
  const password=String(body?.password||'');
  assert(password.length<=128,'Password is too long');
  const u=await env.DB.prepare('SELECT * FROM auth_users WHERE username=? COLLATE NOCASE').bind(name).first();
  const now=Math.floor(Date.now()/1000);
  if(!u||u.disabled||u.locked_until>now)return json({ok:false,error:u?.locked_until>now?'Too many attempts. Try again in 15 minutes.':'Invalid username or password'},401,origin);
  let valid=false;
  if(u.password_hash&&u.password_salt){
    const hash=await authHash(password,u.password_salt,u.iterations||AUTH_ITERATIONS);
    valid=constantTimeEqual(hash,u.password_hash);
  }else if(env.AUTH_BOOTSTRAP_CODE && String(env.AUTH_BOOTSTRAP_CODE).length>=8){
    valid=constantTimeEqual(password,String(env.AUTH_BOOTSTRAP_CODE));
  }
  if(!valid){
    const failures=u.failed_count+1;
    await env.DB.prepare('UPDATE auth_users SET failed_count=?,locked_until=? WHERE id=?').bind(failures>=AUTH_MAX_FAILURES?0:failures,failures>=AUTH_MAX_FAILURES?now+AUTH_LOCK_SECONDS:0,u.id).run();
    return json({ok:false,error:'Invalid username or password'},401,origin);
  }
  const token=randomHex(32),tokenHash=await sha256(token),ttl=u.must_change?AUTH_FIRST_LOGIN_SECONDS:AUTH_SESSION_SECONDS;
  await env.DB.batch([
    env.DB.prepare('UPDATE auth_users SET failed_count=0,locked_until=0 WHERE id=?').bind(u.id),
    env.DB.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(tokenHash,u.id,now+ttl)
  ]);
  return json({ok:true,token,user:userPublic(u),expiresIn:ttl},200,origin);
}
async function authChangePassword(env,session,body,origin){
  if(!session)throw Object.assign(Error('Sign in first'),{httpStatus:401});
  const pw=authValidPassword(body?.newPassword);
  const user=await env.DB.prepare('SELECT * FROM auth_users WHERE id=?').bind(session.user.id).first();
  if(!user.must_change){
    assert(typeof body.currentPassword==='string','Enter your current password');
    const check=await authHash(body.currentPassword,user.password_salt,user.iterations);
    if(!constantTimeEqual(check,user.password_hash))return json({ok:false,error:'Current password was incorrect'},401,origin);
  }
  const salt=randomHex(16),hash=await authHash(pw,salt),now=Math.floor(Date.now()/1000);
  await env.DB.batch([
    env.DB.prepare('UPDATE auth_users SET password_hash=?,password_salt=?,iterations=?,must_change=0,failed_count=0,locked_until=0,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .bind(hash,salt,AUTH_ITERATIONS,user.id),
    env.DB.prepare('DELETE FROM auth_sessions WHERE user_id=? AND token_hash<>?').bind(user.id,session.tokenHash),
    env.DB.prepare('UPDATE auth_sessions SET expires_at=? WHERE token_hash=?').bind(now+AUTH_SESSION_SECONDS,session.tokenHash)
  ]);
  return json({ok:true,user:{id:user.id,name:user.username,role:user.role,mustChange:false}},200,origin);
}
async function authListUsers(env,origin){
  const rows=await env.DB.prepare('SELECT id,username,role,must_change,disabled,created_at FROM auth_users ORDER BY username COLLATE NOCASE').all();
  return json({ok:true,users:(rows.results||[]).map(x=>({id:x.id,name:x.username,role:x.role,mustChange:!!x.must_change,disabled:!!x.disabled,createdAt:x.created_at}))},200,origin);
}
async function authMakeTemporary(env,userId){
  const temporary=randomHex(12),salt=randomHex(16),hash=await authHash(temporary,salt);
  await env.DB.batch([
    env.DB.prepare('UPDATE auth_users SET password_hash=?,password_salt=?,iterations=?,must_change=1,failed_count=0,locked_until=0,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .bind(hash,salt,AUTH_ITERATIONS,userId),
    env.DB.prepare('DELETE FROM auth_sessions WHERE user_id=?').bind(userId)
  ]);
  return temporary;
}
async function authCreateUser(env,body,origin){
  const name=authValidName(body?.username),role=body?.role;
  assert(role==='admin'||role==='staff','Choose an admin or staff role');
  const id=crypto.randomUUID(),tmp=randomHex(12),salt=randomHex(16),hash=await authHash(tmp,salt);
  try{await env.DB.prepare('INSERT INTO auth_users(id,username,role,password_hash,password_salt,iterations,must_change) VALUES(?,?,?,?,?,?,1)')
    .bind(id,name,role,hash,salt,AUTH_ITERATIONS).run();}
  catch(err){if(/unique|constraint/i.test(String(err)))return json({ok:false,error:'That username already exists'},409,origin);throw err;}
  return json({ok:true,user:{id,name,role,mustChange:true,disabled:false},temporaryPassword:tmp},200,origin);
}
async function authUpdateUser(env,session,body,origin){
  const id=String(body?.userId||'');
  assert(/^[\w-]{5,80}$/.test(id),'Invalid user');
  const target=await env.DB.prepare('SELECT id,username,role,disabled FROM auth_users WHERE id=?').bind(id).first();
  assert(target,'User not found');
  const role=body?.role===undefined?target.role:body.role;
  const disabled=body?.disabled===undefined?target.disabled:(body.disabled?1:0);
  assert(role==='admin'||role==='staff','Invalid role');
  if(target.id===session.user.id && (role!=='admin'||disabled))return json({ok:false,error:'You cannot remove your own admin access'},400,origin);
  if(target.role==='admin' && !target.disabled && (role!=='admin'||disabled)){
    const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_users WHERE role='admin' AND disabled=0").first();
    if(Number(count.n)<=1)return json({ok:false,error:'At least one active admin must remain'},409,origin);
  }
  await env.DB.prepare('UPDATE auth_users SET role=?,disabled=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .bind(role,disabled,id).run();
  if(disabled||role!==target.role)await env.DB.prepare('DELETE FROM auth_sessions WHERE user_id=?').bind(id).run();
  return json({ok:true},200,origin);
}
async function authResetUser(env,session,body,origin){
  const id=String(body?.userId||'');
  assert(id&&id!==session.user.id,'Select a different user to reset');
  const u=await env.DB.prepare('SELECT id FROM auth_users WHERE id=?').bind(id).first();
  assert(u,'User not found');
  return json({ok:true,temporaryPassword:await authMakeTemporary(env,id)},200,origin);
}
async function authRecord(env,session,action,reference){
  if(!env.DB||!session)return;
  try{await env.DB.prepare('INSERT OR IGNORE INTO auth_activity(event_key,user_id,username,action,reference) VALUES(?,?,?,?,?)')
    .bind(`${action}:${reference}`,session.user.id,session.user.username,action,reference).run();}
  catch(err){console.error('Activity log failed',err);}
}

/**
 * Icy Rose Exchange — Cloudflare Worker: Discord receipts + shared inventory.
 * REPLACE the existing Worker code with this file (keep the same URL / secrets).
 * Secrets: DISCORD_WEBHOOK_URL and AUTH_BOOTSTRAP_CODE. Plain text: ALLOWED_ORIGIN.
 * Binding: existing D1 database DB. Also execute worker/login-schema.sql once.
 * The webhook URL and passphrase must NEVER be stored in your GitHub repository.
 */
const MAX_LINES=50, MAX_BODY_CHARS=30000, MAX_QTY=10000, MAX_PRICE=10000000;
const MONEY_FORMAT=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:0,maximumFractionDigits:2});
function money(cents){return MONEY_FORMAT.format(cents/100);}
function json(value,status=200,origin=''){
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  if(origin){headers['Access-Control-Allow-Origin']=origin;headers['Vary']='Origin';}
  return new Response(JSON.stringify(value),{status,headers});
}
function safe(s,n=120){return String(s??'').replace(/[\r\n\t]/g,' ').replace(/[@`*_~|>\\]/g,' ').trim().slice(0,n);}
function cleanText(s,n=200){return String(s??'').replace(/[\x00-\x1F\x7F]/g,' ').trim().slice(0,n);}
function constantTimeEqual(a,b){
  if(typeof a!=='string'||typeof b!=='string')return false;
  let v=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)v|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);
  return v===0;
}
function assert(ok,message){if(!ok)throw Error(message);}
function productId(raw){
  assert(typeof raw==='string'&&/^(item|material):/.test(raw)&&raw.length<=150&&!/[\x00-\x1F\x7F<>]/.test(raw),'Invalid product ID');
  return raw;
}
function uniqueId(raw){assert(typeof raw==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(raw),'Invalid request ID');return raw;}
function quantity(raw,min=1){assert(Number.isInteger(raw)&&raw>=min&&raw<=MAX_QTY,'Invalid quantity');return raw;}
function asPrice(value){
  assert(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=MAX_PRICE,'Invalid price');
  const cents=Math.round(value*100);
  assert(Math.abs(value*100-cents)<0.0001,'Prices must have at most two decimal places');
  return cents;
}
function validateItems(items){
  assert(Array.isArray(items)&&items.length>=1&&items.length<=MAX_LINES,'Order needs 1–50 distinct items');
  const seen=new Set();
  return items.map((line,i)=>{
    assert(line&&typeof line.name==='string'&&line.name.trim().length>0&&line.name.length<=120,`Invalid item name (line ${i+1})`);
    const id=productId(line.id);
    assert(!seen.has(id),'Duplicate product in order');seen.add(id);
    const qty=quantity(line.qty),unitCents=asPrice(line.unitPrice);
    return {id,name:safe(line.name,70),qty,unitCents,lineCents:qty*unitCents};
  });
}
function verifyTotal(lines,total){
  const cents=lines.reduce((sum,x)=>sum+x.lineCents,0);
  assert(Number.isSafeInteger(cents)&&Math.round(total*100)===cents&&typeof total==='number'&&Number.isFinite(total),'Cart total does not match line prices');
  return cents;
}
function embedLines(lines){return lines.map(l=>`• **${l.name}** × ${l.qty} @ ${money(l.unitCents)} = **${money(l.lineCents)}**`).join('\n');}
function receiptMessage(lines,kind,totalCents,receiptId,operator,fundSource='shop'){
  const isSale=kind==='pawn',isPersonal=fundSource==='personal',description=embedLines(lines);
  assert(description.length<=3900,'Too many item names for a single Discord receipt');
  return {username:'Icy Rose Exchange',allowed_mentions:{parse:[]},embeds:[{
    title:isPersonal
      ? (isSale?'👤 PERSONAL CHECKOUT — Completed Sale':'👤 PERSONAL CHECKOUT — Completed Purchase')
      : (isSale?'🧾 Pawn Shop — Completed Sale':'🧾 Buying Calculator — Completed Purchase'),
    color:isPersonal?6477291:isSale?6741745:16729454,description,
    fields:[
      {name:isSale?'Customer paid':'Paid to customer',value:`**${money(totalCents)}**`,inline:true},
      {name:'Total units',value:String(lines.reduce((n,l)=>n+l.qty,0)),inline:true},
      {name:'Money handled by',value:isPersonal?`**Personal — ${safe(operator,55)}**`:'**Pawn Shop**',inline:true},
      {name:'Processed by',value:safe(operator,60),inline:true},
      {name:'Receipt ID',value:`\`${receiptId}\``,inline:false}
    ],footer:{text:'Icy Rose Exchange • Shared stock updated • Personal/shop money recorded separately'},timestamp:new Date().toISOString()
  }]};
}
function requirementLines(reqs){
  return reqs.map(r=>`• ${safe(r.name,40)}: **${r.needed}** to take${r.shortage>0?` · **${r.shortage} short**`:''}`).join('\n');
}
function bulkMessage(order,event){
  const listed=embedLines(order.items);
  assert(listed.length<=3600,'Bulk order too long. Split into smaller orders.');
  let matText=requirementLines(order.requirements);
  if(matText.length>950)matText=matText.slice(0,920)+'\n… view full list on website';
  const title=event==='placed'?'📦 NEW Bulk Order — Crafting Requested':event==='fulfilled'?'✅ Bulk Order — Fulfilled':'🚫 Bulk Order — Cancelled';
  return {username:'Icy Rose Exchange',allowed_mentions:{parse:[]},embeds:[{
    title,color:event==='placed'?6741745:event==='fulfilled'?5689080:13448524,
    description:listed,
    fields:[
      {name:'Customer',value:safe(order.customer,80)||'Not provided',inline:true},
      {name:'Order total',value:money(order.totalCents),inline:true},
      {name:event==='placed'?'Placed by':'Updated by',value:safe(order.operator||'Staff',60),inline:true},
      {name:'Order ID',value:`\`${order.id}\``,inline:false},
      {name:'Materials for items to craft',value:matText||'None required with current finished stock',inline:false},
      ...(order.notes?[{name:'Notes',value:safe(order.notes,150),inline:false}]:[])
    ],footer:{text:'Icy Rose Exchange • Bulk orders'},timestamp:new Date().toISOString()
  }]};
}
async function sendDiscord(env,message){
  if(!env.DISCORD_WEBHOOK_URL)return false;
  try {
    const hook=new URL(env.DISCORD_WEBHOOK_URL);
    if(hook.origin!=='https://discord.com'||!/^\/api\/webhooks\/\d+\/[^/]+$/.test(hook.pathname))return false;
    hook.searchParams.set('wait','true');
    const response=await fetch(hook.toString(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message),signal:AbortSignal.timeout(12000)});
    return response.ok;
  }catch{return false;}
}
/**
 * Send a fresh stock snapshot to Discord. The browser supplies ONLY the
 * current material catalogue (IDs/names); ALL quantities come from D1.
 * This endpoint is read-only. No schema changes or stock writes are needed.
 */
function validateMaterialCatalogue(input){
  assert(Array.isArray(input)&&input.length>=1&&input.length<=200,'Choose 1–200 materials for the stock report');
  const ids=new Set();
  return input.map(row=>{
    assert(row&&typeof row.name==='string'&&row.name.trim().length>=1&&row.name.length<=100,'Invalid material name');
    const id=productId(row.id);
    assert(id.startsWith('material:'),'Stock report only accepts materials');
    assert(!ids.has(id),'Duplicate material in stock report');ids.add(id);
    return {id,name:safe(row.name,65)};
  });
}
function makeMaterialSnapshot(materials,stockRows){
  const stockMap=new Map((stockRows||[]).map(x=>[x.product_id,Number(x.qty)]));
  const rows=materials.map(m=>({name:m.name,id:m.id,qty:stockMap.get(m.id)??0}));
  rows.sort((a,b)=>a.name.localeCompare(b.name));
  const stats={types:rows.length,positive:rows.filter(x=>x.qty>0).length,
    missing:rows.filter(x=>x.qty===0).length,negative:rows.filter(x=>x.qty<0).length,
    units:rows.reduce((sum,x)=>sum+Math.max(0,x.qty),0)};
  const parts=[];
  for(let i=0;i<rows.length;i+=25){
    const chunk=rows.slice(i,i+25);
    const text=chunk.map(x=>`• ${x.name} — **${x.qty.toLocaleString('en-US')}**${x.qty<0?' ⚠️':''}`).join('\n');
    assert(text.length<=3900,'Material list too long to post');
    parts.push({title:i===0?'📦 CURRENT MATERIAL STOCK':`📦 MATERIAL STOCK — Continued (${i/25+1})`,
      color:6725367,description:text,
      ...(i===0?{fields:[
        {name:'Materials',value:String(stats.types),inline:true},
        {name:'Types in stock',value:String(stats.positive),inline:true},
        {name:'Total units',value:stats.units.toLocaleString('en-US'),inline:true},
        {name:'Empty / Short',value:`${stats.missing} empty · ${stats.negative} negative`,inline:false}
      ]}:{}),
      footer:{text:'Icy Rose Exchange • Live Cloudflare inventory • No stock changed'},
      timestamp:new Date().toISOString()});
  }
  return {message:{username:'Icy Rose Exchange',allowed_mentions:{parse:[]},embeds:parts},stats};
}
async function handlePostMaterials(env,body,origin,session){
  const materials=validateMaterialCatalogue(body?.materials);
  // Read at send time instead of trusting browser stock values or a saved cache.
  const dbResult=await env.DB.prepare('SELECT product_id,qty FROM inventory WHERE product_id LIKE ?').bind('material:%').all();
  const report=makeMaterialSnapshot(materials,dbResult.results||[]);
  for(const embed of report.message.embeds)embed.footer.text+=` • Posted by ${safe(session.user.username,55)}`;
  const posted=await sendDiscord(env,report.message);
  if(!posted)return json({ok:false,error:'Discord did not accept the stock report. Check your webhook and try again.'},502,origin);
  await authRecord(env,session,'materials-report',crypto.randomUUID());
  return json({ok:true,discordPosted:true,materialCount:report.stats.types,totalUnits:report.stats.units},200,origin);
}
async function readBody(request){
  assert((request.headers.get('Content-Type')||'').includes('application/json'),'Expected JSON');
  const raw=await request.text();assert(raw.length<=MAX_BODY_CHARS,'Request too large');
  return JSON.parse(raw);
}
function rowToOrder(row){
  return {id:row.id,customer:row.customer,notes:row.notes,status:row.status,items:JSON.parse(row.items_json),requirements:JSON.parse(row.requirements_json),totalCents:row.total_cents,createdAt:row.created_at,updatedAt:row.updated_at,discordStatus:row.discord_status};
}
async function getState(env){
  const [stock,orders]=await Promise.all([
    env.DB.prepare('SELECT product_id, qty, updated_at FROM inventory ORDER BY product_id').all(),
    env.DB.prepare('SELECT * FROM bulk_orders ORDER BY created_at DESC LIMIT 150').all()
  ]);
  return {inventory:(stock.results||[]).map(x=>({id:x.product_id,qty:x.qty,updatedAt:x.updated_at})),orders:(orders.results||[]).map(rowToOrder)};
}
async function handleReceipt(env,body,origin,session){
  assert(body?.kind==='pawn'||body?.kind==='buying','Invalid receipt type');
  const fundSource=body.fundSource===undefined?'shop':body.fundSource;
  assert(fundSource==='shop'||fundSource==='personal','Invalid checkout funding');
  const lines=validateItems(body.items),cents=verifyTotal(lines,body.clientTotal);
  await checkActiveOffers(env,lines,body.kind==='pawn'?'canSell':'canBuy');
  const id=uniqueId(body.orderId);
  const message=receiptMessage(lines,body.kind,cents,id,session.user.username,fundSource); // validate Discord limits before recording stock
  let saved=false;
  if(env.DB){
    try {
      await env.DB.prepare('INSERT INTO shop_receipts(id,kind,items_json,total_cents) VALUES(?,?,?,?)')
        .bind(id,body.kind,JSON.stringify(lines.map(l=>({id:l.id,qty:l.qty,name:l.name,unitCents:l.unitCents}))),cents).run();
      saved=true;
    }catch(err){
      if(String(err).includes('UNIQUE')||String(err).includes('constraint')) {
        const old=await env.DB.prepare('SELECT id,discord_status FROM shop_receipts WHERE id=?').bind(id).first();
        if(old)return json({ok:true,receiptId:id,alreadyProcessed:true,stockUpdated:true,discordPosted:old.discord_status==='posted'},200,origin);
      }
      throw err;
    }
  }
  const sent=await sendDiscord(env,message);
  if(saved){
    await env.DB.prepare('UPDATE shop_receipts SET discord_status=? WHERE id=?').bind(sent?'posted':'failed',id).run();
    await authRecord(env,session,fundSource==='personal'?'receipt-personal':'receipt',id);
  }
  // With no DB the old Discord-only relay still works, but say so explicitly.
  if(!saved&&!sent)return json({ok:false,error:'Discord delivery failed'},502,origin);
  return json({ok:true,receiptId:id,discordPosted:sent,stockUpdated:saved},200,origin);
}
function readRequirements(input){
  assert(Array.isArray(input)&&input.length<=100,'Too many materials');
  return input.map(x=>{
    const needed=x.needed,shortage=x.shortage;
    assert(Number.isInteger(needed)&&needed>=0&&needed<=1000000&&Number.isInteger(shortage)&&shortage>=0&&shortage<=1000000,'Invalid material requirements');
    return {id:productId(x.id),name:safe(x.name,60),needed,shortage};
  });
}
function parseBulk(body){
  const lines=validateItems(body.items);
  assert(lines.every(l=>l.id.startsWith('item:')),'Bulk orders must contain finished items');
  const cents=verifyTotal(lines,body.clientTotal);
  const customer=cleanText(body.customer,80),notes=cleanText(body.notes,180);
  const requirements=readRequirements(body.requirements||[]);
  return {id:uniqueId(body.orderId),customer,notes,status:'pending',items:lines,requirements,totalCents:cents};
}
async function handleBulkPlace(env,body,origin,session){
  const order=parseBulk(body);
  order.operator=session.user.username;
  await checkActiveOffers(env,order.items,'canSell');
  const message=bulkMessage(order,'placed'); // validate all Discord limits before storing order
  try {
    await env.DB.prepare('INSERT INTO bulk_orders(id,customer,notes,items_json,requirements_json,total_cents) VALUES(?,?,?,?,?,?)')
      .bind(order.id,order.customer,order.notes,JSON.stringify(order.items),JSON.stringify(order.requirements),order.totalCents).run();
  }catch(err){
    if(String(err).includes('UNIQUE')||String(err).includes('constraint')) {
      const old=await env.DB.prepare('SELECT * FROM bulk_orders WHERE id=?').bind(order.id).first();
      if(old)return json({ok:true,order:rowToOrder(old),alreadyProcessed:true,discordPosted:old.discord_status==='posted'},200,origin);
    }
    throw err;
  }
  const sent=await sendDiscord(env,message);
  await env.DB.prepare('UPDATE bulk_orders SET discord_status=? WHERE id=?').bind(sent?'posted':'failed',order.id).run();
  await authRecord(env,session,'bulk-placed',order.id);
  return json({ok:true,orderId:order.id,discordPosted:sent},200,origin);
}
async function handleBulkStatus(env,body,origin,session){
  const id=uniqueId(body?.orderId);
  const status=body.status;
  assert(status==='fulfilled'||status==='cancelled','Choose fulfilled or cancelled');
  const result=await env.DB.prepare("UPDATE bulk_orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(status,id).run();
  if(!result.meta?.changes)return json({ok:false,error:'This order is no longer pending. Refresh the orders list.'},409,origin);
  // DB trigger changes stock atomically exactly once on fulfilled transition.
  const row=await env.DB.prepare('SELECT * FROM bulk_orders WHERE id=?').bind(id).first();
  const order=rowToOrder(row);
  order.operator=session.user.username;
  const sent=await sendDiscord(env,bulkMessage({...order,totalCents:row.total_cents},status));
  await authRecord(env,session,'bulk-'+status,id);
  return json({ok:true,order,discordPosted:sent},200,origin);
}
async function handleStockAdjust(env,body,origin,session){
  const eventId=uniqueId(body.eventId),id=productId(body.productId),mode=body.mode;
  assert(mode==='delta'||mode==='set','Invalid stock change mode');
  const qty=body.quantity;
  assert(Number.isInteger(qty)&&Math.abs(qty)<=1000000&&(mode==='set'?qty>=0:qty!==0),'Invalid stock count');
  const note=cleanText(body.note,100);
  try {
    await env.DB.prepare('INSERT INTO stock_events(id,action,product_id,mode,quantity,note) VALUES(?,?,?,?,?,?)')
      .bind(eventId,'manual',id,mode,qty,note).run();
  }catch(err){if(String(err).includes('UNIQUE'))return json({ok:true,alreadyProcessed:true},200,origin);throw err;}
  await authRecord(env,session,'stock-adjust',eventId);
  return json({ok:true},200,origin);
}
async function handleStockCraft(env,body,origin,session){
  const eventId=uniqueId(body.eventId),itemId=productId(body.itemId),qty=quantity(body.qty);
  assert(itemId.startsWith('item:'),'Choose a finished item to craft');
  assert(Array.isArray(body.requirements)&&body.requirements.length>=1&&body.requirements.length<=30,'Crafting recipe is missing');
  const byId=new Map();
  for(const r of body.requirements){
    const id=productId(r.id);assert(id.startsWith('material:'),'Only materials can be used in a recipe');
    const amount=quantity(r.qty);byId.set(id,(byId.get(id)||0)+amount);
  }
  const statements=[env.DB.prepare('INSERT INTO stock_events(id,action,product_id,mode,quantity,note) VALUES(?,?,?,?,?,?)').bind(eventId+':made','craft',itemId,'delta',qty,'Craft batch')];
  let i=0;
  for(const [id,amount] of byId){statements.push(env.DB.prepare('INSERT INTO stock_events(id,action,product_id,mode,quantity,note) VALUES(?,?,?,?,?,?)').bind(eventId+':mat'+i++,'craft',id,'delta',-amount,'Craft materials used'));}
  try{await env.DB.batch(statements);}catch(err){
    if(String(err).includes('UNIQUE'))return json({ok:true,alreadyProcessed:true},200,origin);
    throw err;
  }
  await authRecord(env,session,'stock-craft',eventId);
  return json({ok:true},200,origin);
}
/* Public price overlays contain no secrets. Writes require the staff PIN. */
// Extra server-side guard: staff-disabled products cannot be submitted by a stale browser.
// Only live D1 edits are available to the Worker; Excel-only flags are enforced
// by the website until those products also receive a staff edit.
async function checkActiveOffers(env,lines,field){
  if(!env.DB)return;
  let rows;
  try{const result=await env.DB.prepare('SELECT product_id,edit_json FROM catalogue_edits').all();rows=result.results||[];}
  catch(error){if(/no such table/i.test(String(error)))return;throw error;}
  const flags=new Map(rows.map(x=>[x.product_id,JSON.parse(x.edit_json)]));
  for(const line of lines){
    const edit=flags.get(line.id);
    assert(!edit?.archived && edit?.[field]!==false,`This item is not currently available for ${field==='canSell'?'selling':'buying'}: ${line.name}`);
  }
}
async function catalogueRecords(env){
  const db=await env.DB.prepare('SELECT product_id,edit_json,is_new,version,updated_at FROM catalogue_edits ORDER BY updated_at DESC').all();
  return (db.results||[]).map(r=>({id:r.product_id,edit:JSON.parse(r.edit_json),isNew:!!r.is_new,version:r.version,updatedAt:r.updated_at}));
}
function optionalPrice(raw,label){
  if(raw===null||raw===''||raw===undefined)return null;
  assert(typeof raw==='number'&&Number.isFinite(raw)&&raw>=0&&raw<=MAX_PRICE&&Math.abs(raw*100-Math.round(raw*100))<0.0001,`Invalid ${label}`);
  return Math.round(raw*100)/100;
}
function validateCatalogueEdit(input){
  assert(input&&typeof input==='object','Missing item details');
  const id=productId(input.id),type=input.type;
  assert((type==='item'&&id.startsWith('item:'))||(type==='material'&&id.startsWith('material:')),'Item type does not match ID');
  const name=cleanText(input.name,100);
  assert(name.length>=2&&name.length<=100,'Enter an item name (2–100 characters)');
  const group=type==='item'?cleanText(input.group,80):'Materials';
  if(type==='item')assert(group.length>0,'Enter a bench/category');
  // Existing edits created before the switch feature default to allowed in both directions.
  assert(input.canSell===undefined||typeof input.canSell==='boolean','Can Sell must be a checkbox value');
  assert(input.canBuy===undefined||typeof input.canBuy==='boolean','Can Buy must be a checkbox value');
  const edit={id,type,name,group,archived:!!input.archived,canSell:input.canSell!==false,canBuy:input.canBuy!==false,
    shopSellOverride:optionalPrice(input.shopSellOverride,'pawn selling price')};
  if(type==='material'){
    edit.materialCost=optionalPrice(input.materialCost,'material unit cost');
    edit.materialSell=optionalPrice(input.materialSell,'material selling price');
    edit.materialBuy=optionalPrice(input.materialBuy,'material buying price');
    assert(edit.materialCost!==null,'Material unit cost is required');
  }else{
    edit.itemSellOverride=optionalPrice(input.itemSellOverride,'item selling price');
    edit.itemBuyFixed=optionalPrice(input.itemBuyFixed,'fixed item buying price');
    edit.itemBuyPercent=optionalPrice(input.itemBuyPercent,'item buying percentage');
    assert(edit.itemBuyPercent===null||edit.itemBuyPercent<=1,'Item buying percentage must be 0%–100%');
    assert(Array.isArray(input.ingredients)&&input.ingredients.length<=30,'You can use up to 30 ingredients');
    const seen=new Set();
    edit.ingredients=input.ingredients.map(line=>{
      const material=productId(line.id);
      assert(material.startsWith('material:'),'Ingredients must be materials');
      assert(!seen.has(material),'Ingredient listed more than once');seen.add(material);
      assert(typeof line.qty==='number'&&Number.isFinite(line.qty)&&line.qty>0&&line.qty<=10000,'Invalid ingredient quantity');
      return {id:material,qty:line.qty};
    });
  }
  return edit;
}
async function handleCatalogueSave(env,body,origin,session){
  const edit=validateCatalogueEdit(body.edit);
  const expected=Number(body.expectedVersion);
  assert(Number.isInteger(expected)&&expected>=0,'Missing item version; refresh the page');
  const old=await env.DB.prepare('SELECT edit_json,base_json,version,is_new FROM catalogue_edits WHERE product_id=?').bind(edit.id).first();
  if((old?.version||0)!==expected)return json({ok:false,error:'This item changed in another tab. Refresh and try again.'},409,origin);
  const base=old?.base_json||JSON.stringify(body.base&&typeof body.base==='object'?body.base:{});
  if(base.length>12000)throw Error('Item backup is too large');
  const isNew=old?!!old.is_new:!!body.isNew;
  let updated;
  if(old){
    updated=await env.DB.prepare('UPDATE catalogue_edits SET edit_json=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND version=?')
      .bind(JSON.stringify(edit),edit.id,expected).run();
  }else{
    try{updated=await env.DB.prepare('INSERT INTO catalogue_edits(product_id,edit_json,base_json,is_new) VALUES(?,?,?,?)')
      .bind(edit.id,JSON.stringify(edit),base,isNew?1:0).run();}
    catch(err){if(String(err).includes('UNIQUE')||String(err).includes('constraint'))return json({ok:false,error:'This item was just saved in another tab. Refresh.'},409,origin);throw err;}
  }
  if(!updated.meta?.changes)return json({ok:false,error:'Item changed while saving. Refresh before retrying.'},409,origin);
  await env.DB.prepare('INSERT INTO catalogue_history(product_id,action,before_json,after_json) VALUES(?,?,?,?)')
    .bind(edit.id,edit.archived?'archived':isNew?'created':'edited',old?.edit_json||null,JSON.stringify(edit)).run();
  await authRecord(env,session,'catalogue-edit',edit.id+':'+(expected+1));
  return json({ok:true,id:edit.id,version:expected+1,updatedAt:new Date().toISOString()},200,origin);
}
async function handleCatalogueRestore(env,body,origin,session){
  const id=productId(body?.id),auditId=Number(body?.auditId);
  assert(Number.isInteger(auditId)&&auditId>0,'Choose a history entry');
  const audit=await env.DB.prepare('SELECT before_json FROM catalogue_history WHERE id=? AND product_id=?').bind(auditId,id).first();
  assert(!!audit,'History entry not found');
  const existing=await env.DB.prepare('SELECT base_json,edit_json,version FROM catalogue_edits WHERE product_id=?').bind(id).first();
  assert(existing,'Item no longer exists');
  const previous=audit.before_json?JSON.parse(audit.before_json):JSON.parse(existing.base_json);
  const edit=validateCatalogueEdit(previous);
  const updated=await env.DB.prepare('UPDATE catalogue_edits SET edit_json=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND version=?')
    .bind(JSON.stringify(edit),id,existing.version).run();
  if(!updated.meta?.changes)return json({ok:false,error:'Item changed while restoring. Refresh.'},409,origin);
  await env.DB.prepare('INSERT INTO catalogue_history(product_id,action,before_json,after_json) VALUES(?,?,?,?)')
    .bind(id,'restored',existing.edit_json,JSON.stringify(edit)).run();
  await authRecord(env,session,'catalogue-restore',id+':'+(existing.version+1));
  return json({ok:true,version:existing.version+1},200,origin);
}

export default {
  async fetch(request,env){
    const origin=request.headers.get('Origin')||'';
    const path=new URL(request.url).pathname;
    // GitHub Actions uses a separate private export token. It cannot sign into staff accounts.
    if(path==='/catalogue/export'){
      if(request.method!=='GET')return json({ok:false,error:'Method not allowed'},405);
      if(!env.SYNC_EXPORT_TOKEN||!constantTimeEqual(request.headers.get('Authorization')||'',`Bearer ${env.SYNC_EXPORT_TOKEN}`))return json({ok:false,error:'Unauthorized'},401);
      if(!env.DB)return json({ok:false,error:'Database not connected'},503);
      try{return json({ok:true,edits:await catalogueRecords(env)});}catch{return json({ok:false,error:'Run the catalogue migration in D1'},503);}
    }
    const allowed=String(env.ALLOWED_ORIGIN||'').trim().replace(/\/$/,'');
    if(!allowed||origin!==allowed)return json({ok:false,error:'Origin not allowed'},403);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{
      'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type, Authorization', 'Access-Control-Max-Age':'600',
      'Cache-Control':'no-store','Vary':'Origin'
    }});
    const methods={
      '/auth/login':'POST','/auth/me':'GET','/auth/password':'POST','/auth/logout':'POST',
      '/auth/users':'GET','/auth/users/add':'POST','/auth/users/update':'POST','/auth/users/reset':'POST',
      '/receipt':'POST','/checkout/capabilities':'GET','/state':'GET','/inventory/adjust':'POST','/inventory/craft':'POST',
      '/bulk-orders':'POST','/bulk-orders/status':'POST','/inventory/post-materials':'POST',
      '/catalogue/changes':'GET','/catalogue/edit':'POST','/catalogue/history':'GET','/catalogue/restore':'POST'
    };
    if(!(path in methods))return json({ok:false,error:'Not found'},404,origin);
    if(methods[path]!==request.method)return json({ok:false,error:'Method not allowed'},405,origin);
    if(path==='/checkout/capabilities')return json({ok:true,personalCheckout:true},200,origin);
    if(!env.DB)return json({ok:false,error:'D1 binding DB is required for sign-in'},503,origin);
    try{
      if(path==='/auth/login')return await authLogin(env,await readBody(request),origin);
      const session=await getAuthSession(env,request);
      if(path==='/auth/me'){
        if(!session)return json({ok:false,error:'Sign in required'},401,origin);
        return json({ok:true,user:userPublic(session.user)},200,origin);
      }
      if(path==='/auth/password')return await authChangePassword(env,session,await readBody(request),origin);
      if(path==='/auth/logout'){
        if(session)await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash=?').bind(session.tokenHash).run();
        return json({ok:true},200,origin);
      }
      const role=(path==='/receipt'||path==='/catalogue/changes')?'staff':'admin';
      authRequire(session,role);
      if(path==='/auth/users')return await authListUsers(env,origin);
      if(path==='/auth/users/add')return await authCreateUser(env,await readBody(request),origin);
      if(path==='/auth/users/update')return await authUpdateUser(env,session,await readBody(request),origin);
      if(path==='/auth/users/reset')return await authResetUser(env,session,await readBody(request),origin);
      if(path==='/catalogue/changes')return json({ok:true,edits:await catalogueRecords(env)},200,origin);
      if(path==='/state')return json({ok:true,...await getState(env)},200,origin);
      if(path==='/catalogue/history'){
        const rows=await env.DB.prepare('SELECT id,product_id,action,before_json,after_json,created_at FROM catalogue_history ORDER BY id DESC LIMIT 80').all();
        return json({ok:true,history:(rows.results||[]).map(r=>({id:r.id,productId:r.product_id,action:r.action,before:r.before_json?JSON.parse(r.before_json):null,after:JSON.parse(r.after_json),createdAt:r.created_at}))},200,origin);
      }
      const body=await readBody(request);
      if(path==='/catalogue/edit')return await handleCatalogueSave(env,body,origin,session);
      if(path==='/catalogue/restore')return await handleCatalogueRestore(env,body,origin,session);
      if(path==='/receipt')return await handleReceipt(env,body,origin,session);
      if(path==='/inventory/adjust')return await handleStockAdjust(env,body,origin,session);
      if(path==='/inventory/craft')return await handleStockCraft(env,body,origin,session);
      if(path==='/inventory/post-materials')return await handlePostMaterials(env,body,origin,session);
      if(path==='/bulk-orders')return await handleBulkPlace(env,body,origin,session);
      if(path==='/bulk-orders/status')return await handleBulkStatus(env,body,origin,session);
      return json({ok:false,error:'Route not found'},404,origin);
    }catch(err){
      const msg=String(err?.message||err);
      if(/D1_ERROR|no such table|SQLITE_ERROR/i.test(msg))return json({ok:false,error:'Database setup incomplete: run worker/login-schema.sql and the original schemas'},503,origin);
      return json({ok:false,error:msg.slice(0,190)},err.httpStatus||422,origin);
    }
  }
};
