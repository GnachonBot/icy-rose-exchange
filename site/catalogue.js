/* Live editable catalogue overlay: prices and recipes stay linked to Cloudflare D1. */
"use strict";
window.IcyCatalogue = (() => {
  const numeric = value => value === null || value === '' || value === undefined ? null : Number(value);
  const price = value => value === null || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100) / 100;
  const alias = {"boost usb":"Blue USB","stolen phone":"S Phone","stolen radio":"S Radio","oxy":"Ox*","oxy (50%)":"Ox* (50%)"};
  const clone = x => JSON.parse(JSON.stringify(x));
  function apply(base, records = []) {
    const data = clone(base);
    const products = new Map([...data.items,...data.materials].map(p=>[p.id,p]));
    const recipes = new Map((data.recipes||[]).map(r=>[r.itemId,r]));
    const edits = new Map(records.map(x=>[x.id,x]));
    for (const row of records) {
      const e=row.edit || row;
      if(!e || !e.id || !['item','material'].includes(e.type)) continue;
      let product=products.get(e.id);
      if(!product) {
        product={id:e.id,type:e.type,group:e.type==='material'?'Materials':'Normal Bench',name:e.name,canSell:true,canBuy:true,
          displayName:e.name,craftCost:null,sellPrice:null,buyPrice:null,shopPrice:null,
          priceSource:'not set',buySource:'not set'};
        products.set(e.id,product);
      }
      product.name=e.name;
      product.displayName=alias[e.name.toLowerCase()]||e.name;
      product.group=e.type==='material'?'Materials':e.group;
      product.type=e.type;
      product.archived=!!e.archived;
      // Older staff edits didn't have availability flags: they remain allowed in both.
      product.canSell=e.canSell!==false;
      product.canBuy=e.canBuy!==false;
      if(e.type==='material') {
        product.materialCost=price(e.materialCost);
        product.customSellPrice=price(e.materialSell);
        product.buyPrice=price(e.materialBuy);
        product.buySource=product.buyPrice===null?'not set':'material fixed';
      } else {
        product.customSellPrice=price(e.itemSellOverride);
        product.buyFixed=price(e.itemBuyFixed);
        product.buyPercent=price(e.itemBuyPercent);
        if(Array.isArray(e.ingredients)) recipes.set(e.id,{itemId:e.id,itemName:e.name,bench:e.group,
          ingredients:e.ingredients.map(x=>({id:x.id,qty:Number(x.qty)})),complete:false});
      }
      product.shopSellOverride=price(e.shopSellOverride);
      product._editVersion=row.version||0;
      product._isNew=!!row.isNew;
    }
    const mats=new Map([...products.values()].filter(p=>p.type==='material').map(p=>[p.id,p]));
    for(const m of mats.values()) {
      if(!edits.has(m.id)) {
        // Older export files lack materialCost; derive the last known unit cost.
        m.materialCost = price(m.materialCost ?? m.baseMaterialCost ?? m.sellPrice);
        m.customSellPrice = price(m.customSellPrice);
      }
      m.sellPrice=price(m.customSellPrice ?? m.materialCost);
      m.shopPrice=price(m.shopSellOverride ?? (m.hasShopOverride ? m.shopPrice : m.sellPrice));
      if(edits.has(m.id)) m.shopPrice=price(m.shopSellOverride ?? m.sellPrice);
      m.priceSource=m.customSellPrice!==null?'custom':'material';
    }
    for(const p of products.values()) if(p.type==='item') {
      const recipe=recipes.get(p.id);
      if(recipe) {
        recipe.itemName=p.name;
        recipe.bench=p.group;
        recipe.ingredients=(recipe.ingredients||[]).map(i=>{
          const m=mats.get(i.id);
          return {id:i.id,name:m?.displayName||i.name||i.id,qty:Number(i.qty),known:!!m&&!m.archived};
        });
        recipe.complete=recipe.ingredients.length>0 && recipe.ingredients.every(i=>i.known && Number.isFinite(i.qty) && i.qty>0 && mats.get(i.id)?.materialCost!==null);
        if(recipe.complete) p.craftCost=price(recipe.ingredients.reduce((n,i)=>n+i.qty*mats.get(i.id).materialCost,0));
        else if(recipe.ingredients.length) p.craftCost=null;
      }
      if(!edits.has(p.id)) {
        // Old workbook exports can carry manual prices without the new explicit fields.
        p.customSellPrice=price(p.customSellPrice);
        p.buyFixed=price(p.buyFixed);
        p.buyPercent=price(p.buyPercent);
      }
      p.sellPrice=price(p.customSellPrice ?? (p.craftCost===null?null:2*p.craftCost));
      p.shopPrice=price(p.shopSellOverride ?? (p.hasShopOverride ? p.shopPrice : p.sellPrice));
      if(edits.has(p.id)) p.shopPrice=price(p.shopSellOverride ?? p.sellPrice);
      p.buyPrice=price(p.buyFixed ?? (p.sellPrice===null?null:p.sellPrice*(p.buyPercent ?? data.defaultBuyPercent ?? 0.5)));
      p.priceSource=p.customSellPrice!==null?'custom':'2x craft cost';
      p.buySource=p.buyFixed!==null?'fixed item offer':p.buyPercent!==null?'custom percentage':'percentage';
      if(!edits.has(p.id)&&!p.displayName)p.displayName=alias[p.name.toLowerCase()]||p.name;
    }
    for(const p of products.values()){
      if(p.canSell===undefined)p.canSell=true;
      if(p.canBuy===undefined)p.canBuy=true;
    }
    data.items=[...products.values()].filter(p=>p.type==='item'&&!p.archived);
    data.materials=[...products.values()].filter(p=>p.type==='material'&&!p.archived);
    data.recipes=[...recipes.values()].filter(r=>data.items.some(i=>i.id===r.itemId));
    data.catalogueEdits=records;
    return data;
  }
  return {apply};
})();
