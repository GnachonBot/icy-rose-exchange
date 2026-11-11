"use strict";

const VIEWS = {
  pawn: { title: "Pawn Shop", eyebrow: "SHOP / CUSTOMER SALES", subtitle: "Build a customer order. Choose items, set quantities, and the total updates instantly.", chip: "Selling to customers" },
  buying: { title: "Buying Calculator", eyebrow: "SHOP / CUSTOMER PURCHASES", subtitle: "Work out exactly what to pay customers, using your fixed buying prices and custom item offers.", chip: "Buying from customers" },
  cash: { title: "Cash Calculator", eyebrow: "SHOP / CASH COUNTER", subtitle: "Count Stacks and Rolls together, even when each one has a different value.", chip: "Two cash types" },
  prices: { title: "Items & Prices", eyebrow: "SHOP / LIVE PRICE LIST", subtitle: "Browse every item and material from the latest Excel workbook, with separate selling and buying prices.", chip: "Linked to your workbook" }
};

let data = null;
let catalogue = [];
let lookup = new Map();
let currentView = "pawn";
let toastTimer;
let orderPosting = false;
const RECEIPT_LIMIT = 50;
const MAX_RECEIPT_QTY = 10000;
const MAX_RECEIPT_PRICE = 10000000;
const receiptEndpoint = String(window.ICY_ROSE_CONFIG?.receiptEndpoint || "").trim();
const APP = document.getElementById("app");

const localKey = "icy-rose-shop-v1";
let saved = {};
try { saved = JSON.parse(localStorage.getItem(localKey) || "{}"); } catch { saved = {}; }
const state = {
  pawnCart: Array.isArray(saved.pawnCart) ? saved.pawnCart : [],
  buyingCart: Array.isArray(saved.buyingCart) ? saved.buyingCart : [],
  cash: saved.cash || {},
  priceFilter: "All",
  priceSearch: ""
};

function persist() {
  try { localStorage.setItem(localKey, JSON.stringify({pawnCart:state.pawnCart,buyingCart:state.buyingCart,cash:state.cash})); } catch {}
}
function currency(num) {
  if (num === null || num === undefined || !Number.isFinite(Number(num))) return "Not set";
  const n = Number(num);
  return "$" + n.toLocaleString("en-US", {minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits:2});
}
function node(tag, cls, text) {
  const n=document.createElement(tag);
  if (cls) n.className=cls;
  if (text!==undefined && text!==null) n.textContent=String(text);
  return n;
}
function el(html) {
  const wrapper=document.createElement("div");
  wrapper.innerHTML=html.trim();
  return wrapper.firstElementChild;
}
function notify(msg) {
  const t=document.getElementById("toast");
  clearTimeout(toastTimer); t.textContent=msg; t.classList.add("visible");
  toastTimer=setTimeout(()=>t.classList.remove("visible"),3200);
}
function priceFor(product, mode) {
  return mode === "pawn" ? product.shopPrice : product.buyPrice;
}
function cartFor(mode) { return mode === "pawn" ? state.pawnCart : state.buyingCart; }
function getLine(mode, entry) {
  const item=lookup.get(entry.id);
  if (!item) return null;
  const qty = Number(entry.qty) || 0;
  const base=priceFor(item,mode);
  const unit=entry.override !== null && entry.override !== undefined && entry.override !== "" ? Number(entry.override) : base;
  return {item,qty,unit,total:unit===null||unit===undefined?null:qty*unit,override:entry.override};
}
function cartMetrics(mode) {
  const lines=cartFor(mode).map(x=>getLine(mode,x)).filter(Boolean);
  return {lines,units:lines.reduce((a,l)=>a+l.qty,0),total:lines.reduce((a,l)=>a+(l.total||0),0),unset:lines.filter(l=>l.unit===null).length};
}
function heading(view) {
  return `<div class="page-heading"><div><div class="eyebrow">${view.eyebrow}</div><h1>${view.title}</h1><p>${view.subtitle}</p></div><div class="label-chip">${view.chip}</div></div>`;
}
function metric(title,value,description="") {
  return `<div class="metric"><span class="metric-title">${title}</span><strong>${value}</strong><small>${description}</small></div>`;
}
function setView(name) {
  if (!data || !VIEWS[name]) return;
  currentView=name;
  document.querySelectorAll(".nav-item").forEach(x=>{
    x.classList.toggle("selected", x.dataset.view===name);
    x.setAttribute("aria-current",x.dataset.view===name?"page":"false");
  });
  document.getElementById("current-section").textContent=VIEWS[name].title;
  if(name==="pawn" || name==="buying") renderCart(name);
  else if(name==="cash") renderCash();
  else renderPrices();
}

function appendSearchOptions(input) {
  const datalist=node("datalist");
  datalist.id="product-options";
  catalogue.forEach(p=>{
    const option=node("option");
    option.value=`${p.displayName} · ${p.group}`;
    datalist.appendChild(option);
  });
  input.setAttribute("list",datalist.id);
  return datalist;
}
function findProduct(raw) {
  const term=String(raw||"").trim().toLowerCase();
  return catalogue.find(p=>`${p.displayName} · ${p.group}`.toLowerCase()===term)
    || catalogue.find(p=>p.displayName.toLowerCase()===term || p.name.toLowerCase()===term)
    || (catalogue.filter(p=>p.displayName.toLowerCase().includes(term)).length===1 && term
        ? catalogue.find(p=>p.displayName.toLowerCase().includes(term)):null);
}
function addItem(mode,id,qty=1) {
  const product=lookup.get(id);
  if(!product) return;
  const cart=cartFor(mode);
  const prior=cart.find(x=>x.id===id);
  if(prior) prior.qty=Math.min(MAX_RECEIPT_QTY,prior.qty+qty);
  else cart.push({id,qty,override:null});
  persist();
  setView(mode);
  notify(`${product.displayName} added to ${mode==="pawn"?"sales":"buying"} cart`);
}
function renderCart(mode) {
  const summary=cartMetrics(mode);
  const isPawn=mode==="pawn";
  const label=isPawn?"TOTAL TO CHARGE":"TOTAL TO PAY";
  APP.innerHTML=heading(VIEWS[mode])+
    `<section class="metrics">${metric(label,currency(summary.total),"Automatically calculated")}${metric("Products in cart",summary.lines.length,"Different items")}${metric("Total quantity",summary.units,"Units in this order")}</section>
    <div class="workspace">
      <section class="card">
        <div class="card-header"><div><h2 class="card-title">${isPawn?"Customer sale":"Customer buying order"}</h2><p class="card-subtitle">Select a product or material, then add a quantity.</p></div><span class="tag ${isPawn?"":"tag-rose"}">${summary.lines.length} lines</span></div>
        <div class="card-body"><form id="add-form" class="add-form" autocomplete="off"><div><label class="form-label" for="product-search">Search items & materials</label><input id="product-search" class="input" type="search" placeholder="Type or choose an item…" required></div><div><label class="form-label" for="product-qty">Quantity</label><input id="product-qty" class="input qty-field" type="number" min="1" max="10000" step="1" value="1" required></div><button class="btn btn-primary" type="submit">＋ Add item</button></form><div id="list-holder"></div></div>
      </section>
      <aside class="card"><div class="card-header"><div><h2 class="card-title">Order summary</h2><p class="card-subtitle">${isPawn?"Customer pays you":"You pay the customer"}</p></div></div>
        <div class="checkout"><div class="form-label">${label}</div><div class="checkout-total ${isPawn?"money-ice":"money-rose"}">${currency(summary.total)}</div>
          <div class="summary-rows"><div class="summary-row"><span>Item lines</span><strong>${summary.lines.length}</strong></div><div class="summary-row"><span>Total units</span><strong>${summary.units}</strong></div><div class="summary-row"><span>Unpriced items</span><strong>${summary.unset}</strong></div></div>
          <div class="receipt-controls">
            <label class="form-label" for="receipt-pin">Staff receipt passphrase</label>
            <input id="receipt-pin" class="input" type="password" autocomplete="off" placeholder="Enter passphrase to send" aria-describedby="receipt-help" />
            <p class="hint" id="receipt-help">${receiptEndpoint ? "Complete an order to post its receipt to Discord. Passphrase is never saved." : "Discord isn't connected yet. Set your Worker URL in site/config.js."}</p>
          </div>
          <div class="checkout-actions"><button type="button" id="complete-order" class="btn btn-primary" ${receiptEndpoint ? "" : "disabled"}>✓ Complete order &amp; send receipt</button><button type="button" id="copy-receipt" class="btn btn-ice">Copy order</button><button type="button" id="clear-cart" class="btn btn-danger">Clear cart</button></div>
        </div>
      </aside>
    </div>`;
  const addInput=document.getElementById("product-search");
  addInput.after(appendSearchOptions(addInput));
  document.getElementById("add-form").addEventListener("submit",e=>{
    e.preventDefault();
    const product=findProduct(addInput.value);
    if(!product) { notify("Choose a valid item from the suggestions."); addInput.focus(); return; }
    const qty=Math.floor(Number(document.getElementById("product-qty").value));
    if(!Number.isFinite(qty)||qty<1||qty>MAX_RECEIPT_QTY) {notify("Enter a quantity of at least 1.");return;}
    addItem(mode,product.id,qty);
  });
  document.getElementById("clear-cart").addEventListener("click",()=>{
    if(!cartFor(mode).length)return;
    if(!confirm("Clear this cart?"))return;
    cartFor(mode).length=0;persist();setView(mode);notify("Cart cleared");
  });
  document.getElementById("copy-receipt").addEventListener("click",()=>copyReceipt(mode));
  document.getElementById("complete-order").addEventListener("click",()=>completeOrder(mode));
  renderCartTable(mode);
}
function renderCartTable(mode) {
  const holder=document.getElementById("list-holder");
  const lines=cartMetrics(mode).lines;
  holder.innerHTML="";
  if(!lines.length){
    holder.append(el(`<div class="empty-state"><div class="empty-icon">▣</div><strong>Your cart is empty</strong><p>Choose an item above to start calculating ${mode==="pawn"?"a customer sale":"a customer payout"}.</p></div>`));return;
  }
  const divider=node("div","divider");holder.append(divider);
  const scroll=node("div","table-scroll");const table=node("table","data-table");
  table.innerHTML=`<thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Custom price</th><th>Line total</th><th aria-label="Remove"></th></tr></thead>`;
  const tbody=node("tbody");
  lines.forEach(line=>{
    const tr=node("tr");
    const tdName=node("td");tdName.append(node("span","product-name",line.item.displayName),node("span","product-sub",line.item.group));tr.append(tdName);
    const tdQty=node("td");const qty=node("input","input numeric-input");qty.type="number";qty.min="1";qty.max=String(MAX_RECEIPT_QTY);qty.step="1";qty.value=line.qty;qty.setAttribute("aria-label",`Quantity for ${line.item.displayName}`);tdQty.append(qty);tr.append(tdQty);
    const tdUnit=node("td","money money-ice",currency(priceFor(line.item,mode)));tr.append(tdUnit);
    const tdOverride=node("td");const override=node("input","input numeric-input price-override");override.type="number";override.min="0";override.step="0.01";override.placeholder="Default";override.value=line.override===null||line.override===undefined?"":line.override;override.setAttribute("aria-label",`Custom unit price for ${line.item.displayName}`);tdOverride.append(override);tr.append(tdOverride);
    const tdTotal=node("td",line.unit===null?"amount-warning":"money money-rose",line.total===null?"Not set":currency(line.total));tr.append(tdTotal);
    const tdRemove=node("td");const remove=node("button","icon-button","×");remove.type="button";remove.title=`Remove ${line.item.displayName}`;tdRemove.append(remove);tr.append(tdRemove);
    const row=cartFor(mode).find(x=>x.id===line.item.id);
    qty.addEventListener("change",()=>{const value=Math.floor(Number(qty.value));row.qty=Number.isFinite(value)?Math.min(MAX_RECEIPT_QTY,Math.max(1,value)):1;persist();setView(mode);});
    override.addEventListener("change",()=>{
      if(override.value.trim()==="")row.override=null;
      else {const value=Number(override.value);if(!Number.isFinite(value)||value<0){notify("Price must be zero or more.");return;}row.override=Math.round(value*100)/100;}
      persist();setView(mode);
    });
    remove.addEventListener("click",()=>{const cart=cartFor(mode);cart.splice(cart.findIndex(x=>x.id===line.item.id),1);persist();setView(mode);});
    tbody.append(tr);
  });
  table.append(tbody);scroll.append(table);holder.append(scroll);
  holder.append(node("p","hint","Custom price is optional and applies only to this order, not to the workbook."));
}
async function completeOrder(mode) {
  if (orderPosting) return;
  const summary = cartMetrics(mode);
  if (!summary.lines.length) { notify("Add items before completing an order."); return; }
  if (summary.lines.length > RECEIPT_LIMIT) { notify(`Receipts support up to ${RECEIPT_LIMIT} different items. Split the order.`); return; }
  if (summary.lines.some(l => !Number.isInteger(l.qty) || l.qty < 1 || l.qty > MAX_RECEIPT_QTY || !Number.isFinite(l.unit) || l.unit < 0 || l.unit > MAX_RECEIPT_PRICE)) {
    notify("Set a valid quantity and price for every item before completing."); return;
  }
  if (!receiptEndpoint) { notify("Discord isn't connected. Set the Worker URL in site/config.js."); return; }
  const passphraseInput = document.getElementById("receipt-pin");
  const passphrase = passphraseInput?.value || "";
  if (!passphrase.trim()) { notify("Enter your staff receipt passphrase first."); passphraseInput?.focus(); return; }
  if (!confirm(`Complete this ${mode === "pawn" ? "customer sale" : "customer purchase"} for ${currency(summary.total)} and post a receipt in Discord?`)) return;

  const button = document.getElementById("complete-order");
  orderPosting = true;
  button.disabled = true;
  button.textContent = "Sending receipt…";
  const payload = {
    kind: mode,
    orderId: crypto.randomUUID(),
    items: summary.lines.map(l => ({name: l.item.displayName, qty: l.qty, unitPrice: Math.round(l.unit * 100) / 100})),
    clientTotal: Math.round(summary.total * 100) / 100
  };
  try {
    const response = await fetch(receiptEndpoint, {
      method: "POST",
      headers: {"Content-Type": "application/json", "X-Receipt-Pin": passphrase},
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    let result = {};
    try { result = await response.json(); } catch {}
    if (!response.ok || !result.ok) throw new Error(result.error || `Server returned ${response.status}`);
    // Discord accepted the message. Only clear this cart on confirmed success.
    const cart = cartFor(mode);
    cart.length = 0;
    persist();
    setView(mode);
    notify(`Order complete. Receipt ${result.receiptId || ""} posted to Discord!`);
  } catch (error) {
    notify(`Receipt not confirmed: ${error.message || "Connection failed"}. Cart kept.`);
    // If the network drops after Discord accepted the receipt, checking the
    // channel before retrying avoids a possible duplicate.
    button.disabled = false;
    button.textContent = "✓ Complete order & send receipt";
  } finally {
    orderPosting = false;
  }
}

async function copyReceipt(mode) {
  const sum=cartMetrics(mode);
  if(!sum.lines.length){notify("Add items before copying an order.");return;}
  const rows=sum.lines.map(l=>`${l.item.displayName} × ${l.qty} @ ${currency(l.unit)} = ${currency(l.total)}`);
  const message=`ICY ROSE EXCHANGE — ${mode==="pawn"?"SALE":"BUYING ORDER"}\n${rows.join("\n")}\n\n${mode==="pawn"?"TOTAL TO CHARGE":"TOTAL TO PAY"}: ${currency(sum.total)}`;
  try {await navigator.clipboard.writeText(message);notify("Order copied to clipboard");} catch {notify("Clipboard access unavailable here. Use HTTPS / GitHub Pages.");}
}
function renderCash() {
  const cash=state.cash;
  const stackValue=cash.stackValue??data.cash.stackValue;
  const rollValue=cash.rollValue??data.cash.rollValue;
  const stackQty=cash.stackQty??0;
  const rollQty=cash.rollQty??0;
  const a=stackValue*stackQty,b=rollValue*rollQty;
  APP.innerHTML=heading(VIEWS.cash)+`<div class="metrics">${metric("TOTAL CASH",currency(a+b),"Stacks + Rolls")}${metric("Total stacks",String(stackQty),"Counted stacks")}${metric("Total rolls",String(rollQty),"Counted rolls")}</div>
    <div class="cash-layout">
      <section class="card cash-card"><div class="cash-icon">▤</div><h2>Stacks</h2><p>Enter the value of one Stack and how many you have.</p><div class="cash-fields"><div><label class="form-label" for="stacks-value">Value per Stack</label><input class="input" id="stacks-value" type="number" min="0" step="0.01" value="${stackValue}"></div><div><label class="form-label" for="stacks-qty">Stacks held</label><input class="input" id="stacks-qty" type="number" min="0" step="1" value="${stackQty}"></div></div><div class="cash-result"><span>STACKS VALUE</span><strong id="stacks-total">${currency(a)}</strong></div></section>
      <section class="card cash-card"><div class="cash-icon">＄</div><h2>Rolls</h2><p>Rolls can have a completely different value from Stacks.</p><div class="cash-fields"><div><label class="form-label" for="rolls-value">Value per Roll</label><input class="input" id="rolls-value" type="number" min="0" step="0.01" value="${rollValue}"></div><div><label class="form-label" for="rolls-qty">Rolls held</label><input class="input" id="rolls-qty" type="number" min="0" step="1" value="${rollQty}"></div></div><div class="cash-result"><span>ROLLS VALUE</span><strong id="rolls-total">${currency(b)}</strong></div></section>
    </div><div class="cash-grand"><div><span>GRAND TOTAL CASH</span><div class="hint">Your counts are saved in this browser.</div></div><strong id="cash-grand">${currency(a+b)}</strong></div><p class="hint" style="margin-top:17px">Default Stack and Roll values come from the Cash Calculator tab in your workbook. You can change them here without altering the source Excel file.</p>`;
  const inputs={stackValue:document.getElementById("stacks-value"),stackQty:document.getElementById("stacks-qty"),rollValue:document.getElementById("rolls-value"),rollQty:document.getElementById("rolls-qty")};
  Object.values(inputs).forEach(i=>i.addEventListener("input",()=>{
    for(const [key,inp] of Object.entries(inputs)){const val=Number(inp.value);state.cash[key]=Number.isFinite(val)?Math.max(0,val):0;}
    const x=state.cash.stackValue*state.cash.stackQty,y=state.cash.rollValue*state.cash.rollQty;
    document.getElementById("stacks-total").textContent=currency(x);
    document.getElementById("rolls-total").textContent=currency(y);
    document.getElementById("cash-grand").textContent=currency(x+y);
    const cards=APP.querySelectorAll(".metric strong");cards[0].textContent=currency(x+y);cards[1].textContent=state.cash.stackQty;cards[2].textContent=state.cash.rollQty;
    persist();
  }));
}
function renderPrices() {
  const filters=["All","Normal Bench","Heist Bench","Recycle Center","Materials"];
  const itemCount=data.items.length, materialCount=data.materials.length;
  APP.innerHTML=heading(VIEWS.prices)+`<section class="metrics">${metric("Finished items",itemCount,"All benches")}${metric("Materials",materialCount,"Fixed buy prices supported")}${metric("Total catalogue",itemCount+materialCount,"Updated from Excel")}</section>
    <section class="card"><div class="card-header"><div><h2 class="card-title">Full price list</h2><p class="card-subtitle">Sell prices and customer buying offers in one place.</p></div><span class="tag">${itemCount+materialCount} entries</span></div>
    <div class="card-body"><div class="price-search-row"><input class="input" id="price-search" placeholder="Search by item or material name…" type="search" aria-label="Search prices"/></div><div id="filterbar" class="filterbar"></div><div class="table-scroll"><table class="data-table price-table"><thead><tr><th>Item / material</th><th>Category</th><th>Sell price</th><th>Buy price</th><th>Quick add</th></tr></thead><tbody id="price-body"></tbody></table></div><p class="hint" id="price-result-count"></p></div></section>`;
  document.getElementById("price-search").value=state.priceSearch;
  document.getElementById("price-search").addEventListener("input",e=>{state.priceSearch=e.target.value;drawPriceTable();});
  const filterbar=document.getElementById("filterbar");
  filters.forEach(f=>{
    const button=node("button","filter"+(state.priceFilter===f?" active":""),f==="Normal Bench"?"Normal":f==="Heist Bench"?"Heist":f==="Recycle Center"?"Recycling":f);
    button.type="button";button.addEventListener("click",()=>{state.priceFilter=f;filterbar.querySelectorAll(".filter").forEach(b=>b.classList.remove("active"));button.classList.add("active");drawPriceTable();});filterbar.append(button);
  });
  drawPriceTable();
}
function drawPriceTable() {
  const target=document.getElementById("price-body");if(!target)return;
  target.replaceChildren();
  const query=state.priceSearch.toLocaleLowerCase().trim();
  const listed=catalogue.filter(p=>(state.priceFilter==="All"||state.priceFilter===p.group) && (!query||`${p.name} ${p.displayName} ${p.group}`.toLowerCase().includes(query)));
  for(const p of listed){
    const tr=node("tr");
    const item=node("td");item.append(node("span","product-name",p.displayName));if(p.displayName!==p.name)item.append(node("span","product-sub",`Workbook: ${p.name}`));tr.append(item);
    const group=node("td");group.append(node("span","badge-group "+(p.type==="material"?"material":p.group==="Heist Bench"?"heist":""),p.group));tr.append(group);
    tr.append(node("td","money money-ice",currency(p.shopPrice)),node("td",p.buyPrice===null?"amount-warning":"money money-rose",currency(p.buyPrice)));
    const buttons=node("td");const actions=node("div","table-actions");
    const addSale=node("button","small-action","Sell +");addSale.type="button";addSale.addEventListener("click",()=>addItem("pawn",p.id));
    const addBuy=node("button","small-action pink","Buy +");addBuy.type="button";addBuy.addEventListener("click",()=>addItem("buying",p.id));
    actions.append(addSale,addBuy);buttons.append(actions);tr.append(buttons);target.append(tr);
  }
  if(!listed.length){const row=node("tr");const td=node("td","empty-state","No matching products found.");td.colSpan=5;row.append(td);target.append(row);}
  document.getElementById("price-result-count").textContent=`Showing ${listed.length} of ${catalogue.length} entries · Missing prices display as “Not set”`;
}

async function init() {
  try {
    const res=await fetch("data/prices.json",{cache:"no-store"});
    if(!res.ok)throw new Error(`HTTP ${res.status}`);
    data=await res.json();
    catalogue=[...data.items,...data.materials];
    lookup=new Map(catalogue.map(x=>[x.id,x]));
    state.pawnCart=state.pawnCart.filter(x=>lookup.has(x.id));
    state.buyingCart=state.buyingCart.filter(x=>lookup.has(x.id));
    persist();
    const updated=new Date(data.generatedAt);
    document.getElementById("data-updated").textContent=`Data refreshed ${updated.toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}`;
    document.querySelectorAll("[data-view]").forEach(button=>button.addEventListener("click",()=>setView(button.dataset.view)));
    setView(currentView);
  } catch(err) {
    APP.replaceChildren(el(`<section class="card"><div class="card-body"><h1>Couldn't load the price data</h1><p class="hint">Start a local web server or deploy the project to GitHub Pages. File:// opening won't load the JSON file in some browsers.</p><p class="hint">Details: ${String(err.message||err).replace(/[<>]/g,"")}</p></div></section>`));
  }
}
init();
