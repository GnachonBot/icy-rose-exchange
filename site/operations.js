"use strict";
// All shared inventory/order information lives in Cloudflare D1, not localStorage.
// Staff passphrases are kept in memory for this open tab only.
let staffPin="";
let remoteReady=false;
let remoteInventory=new Map();
let remoteOrders=[];
let loadingOperations=false;
let postingMaterialSnapshot=false;
let inventorySearch="";
let inventoryFilter="All";
const remoteBase=String(window.ICY_ROSE_CONFIG?.receiptEndpoint||"").trim().replace(/\/receipt\/?$/,'');
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function stockOf(id){return remoteInventory.get(id)??0;}
function reservedStock(id){
  return remoteOrders.filter(order=>order.status==='pending').reduce((sum,order)=>
    sum+(order.items||[]).filter(line=>line.id===id).reduce((n,line)=>n+(Number(line.qty)||0),0),0);
}
function availableStock(id){return Math.max(0,stockOf(id)-reservedStock(id));}
function recipeFor(id){return (data?.recipes||[]).find(r=>r.itemId===id);}
function randomId(){return crypto.randomUUID();}
async function cloud(path,method="GET",payload=null,pin=staffPin){
  if(!remoteBase)throw Error("Configure your Cloudflare Worker URL in site/config.js first.");
  const response=await fetch(remoteBase+path,{
    method,headers:{"Content-Type":"application/json","X-Receipt-Pin":pin},
    ...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(16000)
  });
  const out=await response.json().catch(()=>({}));
  if(!response.ok||!out.ok)throw Error(out.error||`Request failed: ${response.status}`);
  return out;
}
async function loadRemoteStock(){
  const result=await cloud('/state');
  remoteInventory=new Map(result.inventory.map(x=>[x.id,Number(x.qty)]));
  remoteOrders=result.orders||[];
  remoteReady=true;
  return result;
}
function lockPanel(name){
  APP.innerHTML=heading(VIEWS[name])+`<section class="card unlock-card"><div class="card-body">
    <div class="eyebrow">STAFF ACCESS</div><h2>Unlock shared ${name==='bulk'?'orders':'inventory'}</h2>
    <p class="card-subtitle">Use the same staff passphrase you already use for Discord receipts. Your password is not saved.</p>
    <form id="unlock-form" class="unlock-row"><input id="unlock-pin" type="password" autocomplete="off" class="input" placeholder="Staff passphrase" required />
    <button type="submit" class="btn btn-primary">Unlock & sync</button></form>
    <p class="hint">This needs your Cloudflare Worker connected to a D1 database. The existing receipt webhook remains in place.</p>
  </div></section>`;
  document.getElementById('unlock-form').addEventListener('submit',async e=>{
    e.preventDefault();if(loadingOperations)return;
    const pass=document.getElementById('unlock-pin').value;
    loadingOperations=true;const button=e.target.querySelector('button');button.disabled=true;button.textContent='Connecting…';
    try{staffPin=pass;await loadRemoteStock();setView(name);notify('Shared stock and orders loaded');}
    catch(err){staffPin='';remoteReady=false;notify(err.message);button.disabled=false;button.textContent='Unlock & sync';}
    finally{loadingOperations=false;}
  });
}
async function syncAndShow(name){
  await loadRemoteStock();setView(name);
}
function renderInventory(){
  if(!remoteReady){lockPanel('inventory');return;}
  const values=[...catalogue];
  const stocks=values.filter(p=>stockOf(p.id)>0).length;
  const units=values.reduce((n,p)=>n+Math.max(0,stockOf(p.id)),0);
  const deficits=values.filter(p=>stockOf(p.id)<0).length;
  APP.innerHTML=heading(VIEWS.inventory)+`<div class="metrics">
      ${metric('Different items stocked',stocks,'Positive quantity')}${metric('Units available',units,'Across all items')}${metric('Needs restocking',deficits,'Negative balances')}
    </div>
    <div class="two-panel">
      <section class="card"><div class="card-header"><div><h2 class="card-title">Manual stock updates</h2><p class="card-subtitle">Count existing stock or add and remove deliveries.</p></div></div>
       <div class="card-body"><form id="stock-form" class="form-stack">
         <div><label class="form-label" for="stock-product">Product / material</label><input id="stock-product" class="input" list="inventory-products" placeholder="Select a product…" required/></div>
         <datalist id="inventory-products"></datalist>
         <div class="grid-fields"><div><label class="form-label" for="stock-mode">Action</label><select id="stock-mode" class="input"><option value="set">Set exact stock count</option><option value="add">Add stock</option><option value="remove">Remove stock</option></select></div>
         <div><label class="form-label" for="stock-qty">Quantity</label><input id="stock-qty" class="input" type="number" min="0" max="1000000" step="1" value="1" required/></div></div>
         <p id="stock-current" class="inline-note">Select a product to see current stock.</p>
         <button type="submit" class="btn btn-primary">Save stock change</button>
       </form></div></section>
      <section class="card"><div class="card-header"><div><h2 class="card-title">Record a crafted batch</h2><p class="card-subtitle">Deduct recipe materials and add the finished items.</p></div></div>
      <div class="card-body"><form id="craft-form" class="form-stack">
       <div><label class="form-label" for="craft-product">Craftable item</label><select id="craft-product" class="input"></select></div>
       <div><label class="form-label" for="craft-qty">Quantity crafted</label><input id="craft-qty" class="input" min="1" max="10000" type="number" step="1" value="1" required/></div>
       <div id="craft-preview" class="inline-note"></div><button type="submit" class="btn btn-ice">＋ Add finished stock & use materials</button>
      </form></div></section>
    </div>
    <section class="card" style="margin-top:20px"><div class="card-header"><div><h2 class="card-title">Live stock list</h2><p class="card-subtitle">Shared with other staff using this site.</p></div><div class="stock-header-actions"><button id="post-materials" type="button" class="btn btn-primary" title="Send current material stock to the same Discord channel">↗ Post Materials to Discord</button><button id="stock-refresh" type="button" class="btn btn-ice">↻ Refresh</button></div></div>
      <div class="card-body"><div class="price-search-row"><input id="inventory-search" class="input" type="search" placeholder="Find an item or material…" value="${esc(inventorySearch)}" />
        <select id="inventory-filter" class="input narrow-select"><option>All</option><option>In stock</option><option>Needs restocking</option></select></div>
        <div class="table-scroll"><table class="data-table"><thead><tr><th>Product / material</th><th>Type</th><th>In stock</th><th>Bulk reserved</th><th>Available</th></tr></thead><tbody id="inventory-table"></tbody></table></div></div>
    </section>`;
  const productInput=document.getElementById('stock-product');const datalist=document.getElementById('inventory-products');
  catalogue.forEach(p=>{const op=node('option');op.value=`${p.displayName} · ${p.group}`;datalist.append(op);});
  function updateStockCurrent(){const p=findProduct(productInput.value);document.getElementById('stock-current').textContent=p?`${p.displayName}: currently ${stockOf(p.id)} in stock`:'Select a product to see current stock.';}
  productInput.addEventListener('change',updateStockCurrent);
  const craftSelect=document.getElementById('craft-product');
  const craftable=catalogue.filter(p=>p.type==='item'&&recipeFor(p.id)?.complete);
  craftable.forEach(p=>{const op=node('option',null,`${p.displayName} · ${p.group}`);op.value=p.id;craftSelect.append(op);});
  function previewCraft(){
    const r=recipeFor(craftSelect.value),qty=Math.floor(Number(document.getElementById('craft-qty').value))||0;
    const text=r?.ingredients.map(i=>`${i.name}: ${i.qty*qty} needed / ${stockOf(i.id)} available`).join('  ·  ')||'Select an item with a recipe.';
    document.getElementById('craft-preview').textContent=text;
  }
  craftSelect.addEventListener('change',previewCraft);document.getElementById('craft-qty').addEventListener('input',previewCraft);previewCraft();
  document.getElementById('stock-form').addEventListener('submit',async e=>{
    e.preventDefault();const p=findProduct(productInput.value),num=Number(document.getElementById('stock-qty').value),mode=document.getElementById('stock-mode').value;
    if(!p){notify('Choose a listed product or material.');return;}
    if(!Number.isInteger(num)||num<0||num>1000000||(mode!=='set'&&num===0)){notify('Enter a valid stock quantity.');return;}
    const quantity=mode==='remove'?-num:num;
    if(!confirm(`${mode==='set'?'Set stock for':mode==='add'?'Add to':'Remove from'} ${p.displayName}: ${num} unit(s)?`))return;
    const b=e.submitter;b.disabled=true;
    try{await cloud('/inventory/adjust','POST',{eventId:randomId(),productId:p.id,mode:mode==='set'?'set':'delta',quantity});await syncAndShow('inventory');notify('Stock updated for everyone.');}
    catch(err){notify(err.message);b.disabled=false;}
  });
  document.getElementById('craft-form').addEventListener('submit',async e=>{
    e.preventDefault();const r=recipeFor(craftSelect.value),qty=Number(document.getElementById('craft-qty').value);
    if(!r?.complete||!Number.isInteger(qty)||qty<1||qty>10000){notify('Choose a valid recipe and quantity.');return;}
    const deficits=r.ingredients.filter(i=>stockOf(i.id)<i.qty*qty);
    const warning=deficits.length?'\nSome materials are below the required amount; negative stock will show as a shortage.':'';
    if(!confirm(`Record crafting ${qty} × ${r.itemName}? Materials will be deducted and the finished item added.${warning}`))return;
    const b=e.submitter;b.disabled=true;
    try{await cloud('/inventory/craft','POST',{eventId:randomId(),itemId:r.itemId,qty,requirements:r.ingredients.map(i=>({id:i.id,qty:i.qty*qty}))});await syncAndShow('inventory');notify('Crafted items added and materials deducted.');}
    catch(err){notify(err.message);b.disabled=false;}
  });
  document.getElementById('inventory-search').addEventListener('input',e=>{inventorySearch=e.target.value;drawInventory();});
  document.getElementById('inventory-filter').value=inventoryFilter;
  document.getElementById('inventory-filter').addEventListener('change',e=>{inventoryFilter=e.target.value;drawInventory();});
  document.getElementById('post-materials').addEventListener('click',async e=>{
    if(postingMaterialSnapshot)return;
    const materials=catalogue.filter(p=>p.type==='material').map(p=>({id:p.id,name:p.displayName}));
    if(!materials.length){notify('No materials found in your Excel list.');return;}
    if(!confirm(`Post your CURRENT material inventory (${materials.length} materials) to Discord? The live quantities will be read from Cloudflare, and no stock will change.`))return;
    const button=e.currentTarget;
    postingMaterialSnapshot=true;
    button.disabled=true;
    button.textContent='Posting current stock…';
    try{
      const result=await cloud('/inventory/post-materials','POST',{materials});
      notify(result.discordPosted?`Material stock posted to Discord (${result.materialCount} materials).`:'Discord did not confirm the message. Please check your channel.');
    }catch(err){notify(`Could not post material stock: ${err.message}`);}
    finally{postingMaterialSnapshot=false;button.disabled=false;button.textContent='↗ Post Materials to Discord';}
  });
  document.getElementById('stock-refresh').addEventListener('click',async()=>{try{await syncAndShow('inventory');notify('Latest stock loaded.');}catch(err){notify(err.message);}});
  drawInventory();
}
function drawInventory(){
  const target=document.getElementById('inventory-table');if(!target)return;
  const q=inventorySearch.toLowerCase().trim();const rows=catalogue.filter(p=>
    (!q||`${p.displayName} ${p.group}`.toLowerCase().includes(q))&&
    (inventoryFilter==='All'||(inventoryFilter==='In stock'&&stockOf(p.id)>0)||(inventoryFilter==='Needs restocking'&&stockOf(p.id)<=0)));
  target.replaceChildren();
  for(const p of rows){
    const tr=node('tr'),name=node('td');name.append(node('span','product-name',p.displayName));tr.append(name);
    tr.append(node('td','product-sub',p.group));
    tr.append(node('td',stockOf(p.id)<0?'negative-stock':'money money-ice',String(stockOf(p.id))));
    tr.append(node('td','money',String(reservedStock(p.id))));
    tr.append(node('td','money money-ice',String(availableStock(p.id))));
    target.append(tr);
  }
  if(!rows.length){const tr=node('tr'),td=node('td','empty-state','No matching stock records.');td.colSpan=5;tr.append(td);target.append(tr);}
}
function bulkPlan(){
  const lines=state.bulkDraft.map(x=>({item:lookup.get(x.id),qty:Number(x.qty)||0,override:x.override})).filter(x=>x.item&&x.qty>0);
  const mats=new Map(),items=[],missing=[];let total=0;
  for(const line of lines){
    const stock=availableStock(line.item.id);const toCraft=Math.max(0,line.qty-stock);
    const unit=line.override!==null&&line.override!==undefined?Number(line.override):line.item.shopPrice;
    if(unit!==null&&Number.isFinite(unit))total+=unit*line.qty;
    const recipe=recipeFor(line.item.id);
    if(!recipe?.complete)missing.push(line.item.displayName);
    items.push({...line,stock,toCraft,recipe,unit});
    for(const component of recipe?.ingredients||[]){
      if(!mats.has(component.id))mats.set(component.id,{id:component.id,name:component.name,all:0,needed:0});
      const target=mats.get(component.id);
      target.all+=component.qty*line.qty;target.needed+=component.qty*toCraft;
    }
  }
  const materials=[...mats.values()].map(m=>({...m,stock:stockOf(m.id),shortage:Math.max(0,m.needed-Math.max(0,stockOf(m.id)))}))
    .sort((a,b)=>b.needed-a.needed||a.name.localeCompare(b.name));
  return {items,materials,missing,total};
}
function renderBulk(){
  if(!remoteReady){lockPanel('bulk');return;}
  const p=bulkPlan(),pending=remoteOrders.filter(x=>x.status==='pending').length;
  APP.innerHTML=heading(VIEWS.bulk)+`<div class="metrics">
    ${metric('Draft order',currency(p.total),'Estimated retail total')}${metric('Items requested',p.items.reduce((n,x)=>n+x.qty,0),'Units in this order')}${metric('Pending orders',pending,'Saved in Cloudflare')}
    </div>
    <section class="card"><div class="card-header"><div><h2 class="card-title">Create a customer bulk order</h2><p class="card-subtitle">Available finished stock is calculated after reserving pending bulk orders.</p></div><span class="tag">${p.items.length} items</span></div>
      <div class="card-body">
      <div class="grid-fields"><div><label class="form-label" for="bulk-customer">Customer name (optional)</label><input id="bulk-customer" maxlength="80" class="input" value="${esc(state.bulkCustomer)}" placeholder="Customer / group"/></div>
      <div><label class="form-label" for="bulk-notes">Order notes (optional)</label><input id="bulk-notes" maxlength="180" class="input" value="${esc(state.bulkNotes)}" placeholder="Delivery, requests…"/></div></div>
      <form id="bulk-add" class="add-form" style="margin-top:17px"><div><label class="form-label" for="bulk-product">Item to craft</label><input id="bulk-product" class="input" list="bulk-choices" required placeholder="Choose finished item…"/><datalist id="bulk-choices"></datalist></div>
      <div><label class="form-label" for="bulk-qty">Qty</label><input id="bulk-qty" class="input" min="1" max="10000" type="number" step="1" value="1" required/></div>
      <button type="submit" class="btn btn-primary">＋ Add item</button></form>
      <div class="table-scroll" style="margin-top:15px"><table class="data-table"><thead><tr><th>Item</th><th>Order qty</th><th>Available stock*</th><th>Need to craft</th><th>Sale price</th><th></th></tr></thead><tbody id="bulk-draft-table"></tbody></table></div>
      ${p.missing.length?`<p class="inline-note danger-note">Missing recipe(s): ${esc(p.missing.join(', '))}. Add them in Excel before placing the order.</p>`:''}
      </div></section>
    <p class="hint" style="margin:10px 0 0">*Available stock excludes finished items already committed to other pending bulk orders. Pending orders reserve finished items; they do not deduct physical inventory until fulfilled.</p>
    <div class="two-panel" style="margin-top:20px">
      <section class="card"><div class="card-header"><div><h2 class="card-title">Combined material packing list</h2><p class="card-subtitle">All materials added across every product in this bulk order.</p></div></div>
      <div class="card-body"><div class="table-scroll"><table class="data-table"><thead><tr><th>Material</th><th>Whole batch</th><th>To take*</th><th>In stock</th><th>Missing</th></tr></thead><tbody id="bulk-material-table"></tbody></table></div>
      <p class="hint">*To take = materials for items still needing crafting, after using available finished-item stock. "Whole batch" shows what you'd need if crafting everything.</p></div></section>
      <section class="card"><div class="card-header"><div><h2 class="card-title">Submit order</h2><p class="card-subtitle">New bulk orders post into your existing Discord channel.</p></div></div>
      <div class="checkout"><div class="form-label">ORDER TOTAL</div><div class="checkout-total money-ice">${currency(p.total)}</div><p class="inline-note">Submitting saves a <strong>Pending</strong> order but does not remove stock yet. Use Inventory to record crafting, then mark the order fulfilled to subtract delivered items.</p>
      <div class="checkout-actions" style="margin-top:20px"><button class="btn btn-primary" id="place-bulk" ${!p.items.length||p.missing.length||p.items.some(x=>!Number.isFinite(x.unit))?'disabled':''}>📦 Place order & notify Discord</button><button class="btn btn-danger" id="clear-bulk">Clear draft</button></div></div></section>
    </div>
    <section class="card" style="margin-top:20px"><div class="card-header"><div><h2 class="card-title">Saved bulk orders</h2><p class="card-subtitle">Shared live with staff; mark fulfilled when collected.</p></div><button class="btn btn-ice" id="bulk-refresh">↻ Refresh</button></div><div class="card-body" id="bulk-history"></div></section>`;
  const datalist=document.getElementById('bulk-choices');catalogue.filter(x=>x.type==='item').forEach(x=>{const o=node('option');o.value=`${x.displayName} · ${x.group}`;datalist.append(o);});
  const rows=document.getElementById('bulk-draft-table');
  p.items.forEach((x)=>{
    const tr=node('tr');tr.innerHTML=`<td><span class="product-name">${esc(x.item.displayName)}</span><span class="product-sub">${esc(x.item.group)}</span></td>
      <td>${x.qty}</td><td>${x.stock}</td><td class="money money-ice">${x.toCraft}</td><td>${currency(x.unit)}</td><td><button class="icon-button" aria-label="Remove ${esc(x.item.displayName)}" type="button">×</button></td>`;
    tr.querySelector('button').addEventListener('click',()=>{state.bulkDraft=state.bulkDraft.filter(z=>z.id!==x.item.id);state.bulkRequestId=null;persist();renderBulk();});rows.append(tr);
  });
  if(!p.items.length){const tr=node('tr'),td=node('td','empty-state','Add an item to calculate materials.');td.colSpan=6;tr.append(td);rows.append(tr);}
  const mRows=document.getElementById('bulk-material-table');
  p.materials.forEach(x=>{const tr=node('tr');tr.innerHTML=`<td>${esc(x.name)}</td><td>${x.all}</td><td class="money money-ice">${x.needed}</td><td>${x.stock}</td><td class="${x.shortage?'negative-stock':'money'}">${x.shortage}</td>`;mRows.append(tr);});
  if(!p.materials.length){const tr=node('tr'),td=node('td','empty-state','Materials will appear when you add recipes.');td.colSpan=5;tr.append(td);mRows.append(tr);}
  document.getElementById('bulk-customer').addEventListener('input',e=>{state.bulkCustomer=e.target.value;state.bulkRequestId=null;persist();});
  document.getElementById('bulk-notes').addEventListener('input',e=>{state.bulkNotes=e.target.value;state.bulkRequestId=null;persist();});
  document.getElementById('bulk-add').addEventListener('submit',e=>{
    e.preventDefault();const product=findProduct(document.getElementById('bulk-product').value),qty=Number(document.getElementById('bulk-qty').value);
    if(!product||product.type!=='item'){notify('Choose a craftable finished item.');return;}
    if(!Number.isInteger(qty)||qty<1||qty>10000){notify('Enter a valid quantity.');return;}
    const existing=state.bulkDraft.find(i=>i.id===product.id);
    if(existing)existing.qty=Math.min(10000,existing.qty+qty);else state.bulkDraft.push({id:product.id,qty});
    state.bulkRequestId=null;persist();renderBulk();
  });
  document.getElementById('clear-bulk').addEventListener('click',()=>{if(!confirm('Clear draft bulk order?'))return;state.bulkDraft=[];state.bulkRequestId=null;persist();renderBulk();});
  document.getElementById('place-bulk').addEventListener('click',async e=>{
    const plan=bulkPlan();if(!plan.items.length||plan.missing.length)return;
    if(!confirm(`Save a new bulk order for ${currency(plan.total)} and send it to Discord?`))return;
    const b=e.currentTarget;b.disabled=true;b.textContent='Saving order…';
    state.bulkRequestId ||= randomId();persist();
    const payload={orderId:state.bulkRequestId,customer:state.bulkCustomer,notes:state.bulkNotes,
      items:plan.items.map(x=>({id:x.item.id,name:x.item.displayName,qty:x.qty,unitPrice:x.unit})),
      requirements:plan.materials.map(x=>({id:x.id,name:x.name,needed:x.needed,shortage:x.shortage})),clientTotal:Math.round(plan.total*100)/100};
    try{const response=await cloud('/bulk-orders','POST',payload);state.bulkDraft=[];state.bulkNotes='';state.bulkCustomer='';state.bulkRequestId=null;persist();await syncAndShow('bulk');notify(response.discordPosted?'Order saved and posted to Discord!':'Order saved, but Discord notification failed. Please check your channel.');}
    catch(err){notify(err.message);b.disabled=false;b.textContent='📦 Place order & notify Discord';}
  });
  document.getElementById('bulk-refresh').addEventListener('click',async()=>{try{await syncAndShow('bulk');notify('Order statuses refreshed');}catch(err){notify(err.message);}});
  renderBulkHistory();
}
function renderBulkHistory(){
  const list=document.getElementById('bulk-history');if(!list)return;
  if(!remoteOrders.length){list.innerHTML='<div class="empty-state">No bulk orders yet. New orders will appear here.</div>';return;}
  list.replaceChildren();
  for(const order of remoteOrders){
    const article=node('article','bulk-history-item');
    const ordered=(order.items||[]).map(x=>`${x.qty} × ${x.name}`).join(' · ');
    const stamp=new Date(order.createdAt+'Z');
    article.innerHTML=`<div class="bulk-history-head"><div><strong>${esc(order.customer||'Customer order')}</strong> <span class="status-pill ${esc(order.status)}">${esc(order.status.toUpperCase())}</span>
      <p class="product-sub">${esc(order.id)} · ${esc(order.createdAt||'')}</p></div><strong class="money money-ice">${currency(order.totalCents/100)}</strong></div>
      <p class="bulk-order-lines">${esc(ordered)}</p>
      ${order.notes?`<p class="product-sub">Note: ${esc(order.notes)}</p>`:''}
      ${order.status==='pending'?'<div class="history-actions"><button class="btn btn-ice" data-action="fulfilled">✓ Mark fulfilled</button><button class="btn btn-danger" data-action="cancelled">Cancel order</button></div>':''}`;
    article.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',async()=>{
      const status=button.dataset.action;
      const msg=status==='fulfilled'?'This will subtract all delivered finished items from stock and post a Discord update.':'Cancel the order without changing stock?';
      if(!confirm(msg))return;
      button.disabled=true;
      try{const res=await cloud('/bulk-orders/status','POST',{orderId:order.id,status});await syncAndShow('bulk');notify(res.discordPosted?`Order ${status} and Discord notified.`:`Order ${status}; Discord notification was not confirmed.`);}
      catch(err){notify(err.message);button.disabled=false;}
    }));
    list.append(article);
  }
}
