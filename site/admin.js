"use strict";
/* Staff catalogue editor. No credentials are stored in localStorage. */
let adminHistory=[];
let adminSelection='';
let adminDraft=null;
let adminSearch='';
let adminWorking=false;
const adminDraftNew=()=>({id:'item:USER-'+crypto.randomUUID().slice(0,12),type:'item',name:'',group:'Normal Bench',archived:false,
  itemSellOverride:null,itemBuyFixed:null,itemBuyPercent:null,shopSellOverride:null,canSell:true,canBuy:true,ingredients:[]});
function baseEdit(product){
  if(!product)return null;
  const common={id:product.id,type:product.type,name:product.name,group:product.group,archived:false,canSell:product.canSell!==false,canBuy:product.canBuy!==false,shopSellOverride:product.shopSellOverride??null};
  if(product.type==='material')return {...common,materialCost:product.materialCost??product.sellPrice??0,
    materialSell:product.customSellPrice??null,materialBuy:product.buyPrice??null};
  const recipe=(data?.recipes||[]).find(r=>r.itemId===product.id);
  return {...common,itemSellOverride:product.customSellPrice??null,itemBuyFixed:product.buyFixed??null,
    itemBuyPercent:product.buyPercent??null,ingredients:(recipe?.ingredients||[]).map(r=>({id:r.id,qty:r.qty}))};
}
function adminItem(){
  if(adminDraft)return adminDraft;
  const saved=data?.catalogueEdits?.find(x=>x.id===adminSelection);
  if(saved)return structuredClone(saved.edit);
  const p=lookup.get(adminSelection);
  return p?baseEdit(p):null;
}
function adminNum(id){
  const val=document.getElementById(id)?.value?.trim();
  if(val===''||val===undefined)return null;
  const n=Number(val);
  if(!Number.isFinite(n)||n<0)throw Error('Enter a valid non-negative price.');
  return n;
}
function adminPriceField(id,title,value,extra=''){
  return `<div><label class="form-label" for="${id}">${title}</label><input class="input" id="${id}" type="number" min="0" step="0.01" value="${value===null||value===undefined?'':esc(value)}" placeholder="${extra||'Leave empty for automatic'}"></div>`;
}
function adminPreview(edit){
  if(!edit)return '';
  const p=lookup.get(edit.id);
  if(edit.type==='material')return `Cost: ${currency(edit.materialCost)} · Sell: ${currency(edit.materialSell??edit.materialCost)} · Buy: ${currency(edit.materialBuy)}`;
  const cost=p?.craftCost;
  const sell=edit.itemSellOverride??(cost===null||cost===undefined?null:cost*2);
  const buy=edit.itemBuyFixed??(sell===null?null:sell*(edit.itemBuyPercent??data.defaultBuyPercent??0.5));
  return `Crafting cost: ${currency(cost)} · Sell: ${currency(sell)} · Buy: ${currency(buy)}`;
}
function renderAdmin(){
  if(!staffPin){
    APP.innerHTML=heading(VIEWS.admin)+`<section class="card unlock-card"><div class="card-body"><div class="eyebrow">STAFF ONLY</div><h2>Unlock Price &amp; Item Manager</h2><p class="card-subtitle">Use the same staff passphrase as Inventory and Discord receipts. We won't save it on this device.</p><form id="admin-unlock" class="unlock-row"><input id="admin-pin" class="input" type="password" autocomplete="off" required placeholder="Staff passphrase"/><button class="btn btn-primary">Unlock editor</button></form><p class="hint">Editing requires the catalogue D1 migration and updated Cloudflare Worker.</p></div></section>`;
    document.getElementById('admin-unlock').onsubmit=async e=>{
      e.preventDefault();const button=e.submitter;button.disabled=true;
      try{const pin=document.getElementById('admin-pin').value;const result=await cloud('/catalogue/history','GET',null,pin);staffPin=pin;adminHistory=result.history||[];renderAdmin();}
      catch(err){notify(err.message);button.disabled=false;}
    };
    return;
  }
  const chosen=adminItem();
  const options=catalogue.filter(x=>`${x.displayName} ${x.group}`.toLowerCase().includes(adminSearch.toLowerCase()))
    .sort((a,b)=>a.displayName.localeCompare(b.displayName));
  APP.innerHTML=heading(VIEWS.admin)+`<div class="metrics">
    ${metric('Active finished items',data.items.length,'Prices linked to recipes')}
    ${metric('Active materials',data.materials.length,'Separate buy/sell prices')}
    ${metric('Recent changes',adminHistory.length,'Saved in Cloudflare D1')}
  </div>
  <div class="admin-layout"><section class="card"><div class="card-header"><div><h2 class="card-title">Catalogue</h2><p class="card-subtitle">Choose an item or add a new one.</p></div></div><div class="card-body admin-picker">
    <input class="input" type="search" id="admin-search" placeholder="Find an item or material…" value="${esc(adminSearch)}"/>
    <select id="admin-select" class="input" size="11" aria-label="Catalogue products">${options.map(x=>`<option value="${esc(x.id)}" ${chosen?.id===x.id?'selected':''}>${esc(x.displayName)} · ${esc(x.group)}</option>`).join('')}</select>
    <div class="admin-picker-actions"><button id="admin-new-item" class="btn btn-ice" type="button">+ Finished item</button><button id="admin-new-mat" class="btn btn-ice" type="button">+ Material</button></div>
    <button id="admin-refresh" class="btn btn-outline" type="button">↻ Refresh prices</button>
  </div></section>
  <section class="card"><div class="card-header"><div><h2 class="card-title">${chosen?'Edit product':'Choose a product'}</h2><p class="card-subtitle">Choose Can Sell and/or Can Buy independently, then save.</p></div>${chosen?`<span class="tag">${chosen.type==='item'?'Finished item':'Material'}</span>`:''}</div>
    <div class="card-body">${chosen?adminForm(chosen):'<div class="empty-state">Select an item on the left, or create a new one.</div>'}</div>
  </section></div>
  <section class="card" style="margin-top:20px"><div class="card-header"><div><h2 class="card-title">Change history</h2><p class="card-subtitle">Every edit is recorded, with a restore button for earlier versions.</p></div><button type="button" class="btn btn-ice" id="admin-history-refresh">Refresh</button></div><div class="card-body" id="admin-history-body"></div></section>`;
  document.getElementById('admin-search').oninput=e=>{adminSearch=e.target.value;renderAdmin();document.getElementById('admin-search')?.focus();};
  document.getElementById('admin-select').onchange=e=>{adminSelection=e.target.value;adminDraft=null;renderAdmin();};
  document.getElementById('admin-new-item').onclick=()=>{adminSelection='';adminDraft=adminDraftNew();renderAdmin();};
  document.getElementById('admin-new-mat').onclick=()=>{adminSelection='';adminDraft={id:'material:user-'+crypto.randomUUID().slice(0,12),type:'material',name:'',group:'Materials',archived:false,materialCost:0,materialSell:null,materialBuy:null,shopSellOverride:null,canSell:true,canBuy:true};renderAdmin();};
  document.getElementById('admin-refresh').onclick=()=>adminRefresh();
  document.getElementById('admin-history-refresh').onclick=()=>adminRefreshHistory();
  if(chosen)wireAdminForm(chosen);
  renderAdminHistory();
}
function adminForm(e){
  const isMat=e.type==='material';
  return `<form id="admin-edit" class="form-stack"><div class="grid-fields"><div><label class="form-label" for="admin-name">Item name</label><input class="input" id="admin-name" required minlength="2" maxlength="100" value="${esc(e.name)}"/></div>
  ${isMat?'<div><label class="form-label">Category</label><input class="input" value="Materials" disabled/></div>':`<div><label class="form-label" for="admin-group">Bench / category</label><input class="input" id="admin-group" required maxlength="80" list="admin-benches" value="${esc(e.group)}"/><datalist id="admin-benches"><option>Normal Bench</option><option>Heist Bench</option><option>Recycle Center</option></datalist></div>`}</div>
  <div class="admin-help">${isMat?'Material cost affects crafting recipes. Buying and selling prices are separate.':'Leave the selling price blank to use 2× crafting cost. Leave the buying offer blank to use 50% (or a chosen percentage).'}</div>
  <div class="grid-fields">${isMat?
    `${adminPriceField('admin-cost','Material cost / unit',e.materialCost)}${adminPriceField('admin-sell','Selling price',e.materialSell)}`:
    `${adminPriceField('admin-sell','Custom selling price',e.itemSellOverride)}${adminPriceField('admin-buy','Fixed buying offer',e.itemBuyFixed)}`}
    ${isMat?adminPriceField('admin-buy','Buying price',e.materialBuy):`<div><label class="form-label" for="admin-pct">Buying percentage (optional)</label><input class="input" type="number" id="admin-pct" min="0" max="100" step="0.01" placeholder="Default: 50%" value="${e.itemBuyPercent===null||e.itemBuyPercent===undefined?'':esc(e.itemBuyPercent*100)}"></div>`}
    ${adminPriceField('admin-pawn','Pawn-only price override',e.shopSellOverride)}
  </div>
  ${isMat?'':`<div><div class="admin-recipe-title"><h3>Crafting recipe</h3><button id="admin-add-ingredient" type="button" class="btn btn-ice">+ Ingredient</button></div><div id="admin-ingredients"></div><p class="hint">Material quantities are per 1 item. Updating a recipe also updates bulk-order material calculations.</p></div>`}
  <fieldset class="admin-offers"><legend>Where is this item available?</legend>
    <label class="admin-offer-switch"><input id="admin-can-sell" type="checkbox" ${e.canSell!==false?'checked':''}/><span><strong>Can Sell</strong><small>Show in Pawn Shop and allow bulk orders</small></span></label>
    <label class="admin-offer-switch"><input id="admin-can-buy" type="checkbox" ${e.canBuy!==false?'checked':''}/><span><strong>Can Buy</strong><small>Show in Buying Calculator for customer purchases</small></span></label>
  </fieldset>
  <div class="admin-preview" id="admin-preview">${esc(adminPreview(e))}</div>
  <label class="admin-archive"><input id="admin-archive" type="checkbox" ${e.archived?'checked':''}/> Archive / hide this item from the shop</label>
  <div class="checkout-actions"><button type="submit" class="btn btn-primary" id="admin-save">✓ Save changes</button><button type="button" class="btn btn-ice" id="admin-cancel">Discard changes</button></div>
  </form>`;
}
function wireAdminForm(e){
  const form=document.getElementById('admin-edit');
  const ingredients=(e.ingredients||[]).map(x=>({...x}));
  function redrawRecipe(){
    const holder=document.getElementById('admin-ingredients');if(!holder)return;
    holder.replaceChildren();
    ingredients.forEach((i,index)=>{
      const row=node('div','admin-ingredient-line');
      const select=node('select','input');select.setAttribute('aria-label','Ingredient material');
      data.materials.forEach(mat=>{const opt=node('option',null,mat.displayName);opt.value=mat.id;opt.selected=mat.id===i.id;select.append(opt);});
      if(!data.materials.some(m=>m.id===i.id)){const opt=node('option',null,'Missing material '+i.id);opt.value=i.id;opt.selected=true;select.append(opt);}
      select.value=i.id;
      select.onchange=()=>{i.id=select.value;};
      const qty=node('input','input');qty.type='number';qty.min='0.01';qty.max='10000';qty.step='0.01';qty.value=i.qty;qty.setAttribute('aria-label','Quantity per item');qty.oninput=()=>{i.qty=Number(qty.value);};
      const remove=node('button','btn btn-danger','×');remove.type='button';remove.title='Remove ingredient';remove.onclick=()=>{ingredients.splice(index,1);redrawRecipe();};
      row.append(select,qty,remove);holder.append(row);
    });
    if(!ingredients.length)holder.innerHTML='<p class="hint">No recipe set. Add materials to enable crafting and bulk-order calculations.</p>';
  }
  if(e.type==='item'){
    document.getElementById('admin-add-ingredient').onclick=()=>{if(!data.materials.length){notify('Add a material first.');return;}ingredients.push({id:data.materials[0].id,qty:1});redrawRecipe();};
    redrawRecipe();
  }
  document.getElementById('admin-cancel').onclick=()=>{adminDraft=null;renderAdmin();};
  form.onsubmit=async event=>{
    event.preventDefault();if(adminWorking)return;
    let edit;
    try{
      edit={...e,name:document.getElementById('admin-name').value.trim(),group:e.type==='material'?'Materials':document.getElementById('admin-group').value.trim(),
        archived:document.getElementById('admin-archive').checked,canSell:document.getElementById('admin-can-sell').checked,canBuy:document.getElementById('admin-can-buy').checked,shopSellOverride:adminNum('admin-pawn')};
      if(e.type==='material'){
        edit.materialCost=adminNum('admin-cost');edit.materialSell=adminNum('admin-sell');edit.materialBuy=adminNum('admin-buy');
        if(edit.materialCost===null)throw Error('Enter a material cost.');
      }else{
        edit.itemSellOverride=adminNum('admin-sell');edit.itemBuyFixed=adminNum('admin-buy');
        const pct=adminNum('admin-pct');edit.itemBuyPercent=pct===null?null:pct/100;
        if(pct!==null&&pct>100)throw Error('Buying percentage cannot exceed 100%.');
        edit.ingredients=ingredients.map(x=>({id:x.id,qty:Number(x.qty)}));
        if(edit.ingredients.some(i=>!(i.qty>0)))throw Error('Ingredient quantities must be greater than zero.');
        if(new Set(edit.ingredients.map(x=>x.id)).size!==edit.ingredients.length)throw Error('Remove duplicate ingredients.');
      }
      if(edit.archived&&!confirm(`Archive ${edit.name}? It will disappear from carts and the live list, but existing inventory history is kept.`))return;
      const row=data.catalogueEdits?.find(x=>x.id===edit.id);
      const result=await cloud('/catalogue/edit','POST',{edit,isNew:!!adminDraft,expectedVersion:row?.version||0,
        base:baseEdit(lookup.get(edit.id))||edit});
      adminWorking=true;adminDraft=null;adminSelection=edit.id;
      await refreshCatalogue(true);await adminRefreshHistory(false);
      if(!lookup.has(edit.id))adminSelection='';
      renderAdmin();notify(`Saved ${edit.name}. Buy/Sell availability is live; Excel syncs through GitHub Actions.`);
    }catch(err){notify(err.message);}
    finally{adminWorking=false;}
  };
}
async function adminRefresh(){
  try{await refreshCatalogue(true);renderAdmin();notify('Live catalogue refreshed.');}catch(err){notify(err.message);}
}
async function adminRefreshHistory(show=true){
  try{const result=await cloud('/catalogue/history');adminHistory=result.history||[];if(show)renderAdminHistory();}
  catch(err){notify(err.message);}
}
function renderAdminHistory(){
  const holder=document.getElementById('admin-history-body');if(!holder)return;holder.replaceChildren();
  if(!adminHistory.length){holder.textContent='No changes yet.';return;}
  for(const h of adminHistory.slice(0,30)){
    const row=node('div','admin-history-entry');
    const text=node('div');text.append(node('strong',null,`${h.after?.name||h.productId} · ${h.action}`),node('small',null,`${h.createdAt} · ${h.productId}`));
    const btn=node('button','btn btn-ice','Restore previous');btn.type='button';
    btn.onclick=async()=>{
      if(!confirm(`Restore the state of ${h.after?.name||h.productId} from immediately before this edit?`))return;
      btn.disabled=true;
      try{await cloud('/catalogue/restore','POST',{id:h.productId,auditId:h.id});await refreshCatalogue(true);await adminRefreshHistory(false);renderAdmin();notify('Previous item version restored.');}
      catch(err){notify(err.message);btn.disabled=false;}
    };
    row.append(text,btn);holder.append(row);
  }
}
