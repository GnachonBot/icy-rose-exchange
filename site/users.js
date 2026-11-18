"use strict";
// User management is server-authorized. UI visibility alone never grants permissions.
window.IcyUsers = (()=>{
  const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=String(text);return el;};
  const show=(msg)=>{const el=document.getElementById('users-status');if(el)el.textContent=msg;};
  const pending = new Set();
  async function render(){
    if(!window.IcyAuth?.isAdmin()){setView('pawn');return;}
    APP.innerHTML=heading(VIEWS.users)+`<div class="user-manager-grid">
      <section class="card"><div class="card-header"><div><h2 class="card-title">Add a staff account</h2><p class="card-subtitle">Choose who can manage the entire shop.</p></div></div>
        <div class="card-body"><form id="new-user-form" class="form-stack">
          <div><label class="form-label" for="new-user-name">Name</label><input id="new-user-name" class="input" minlength="2" maxlength="35" placeholder="Enter their name" autocomplete="off" required /></div>
          <div><label class="form-label" for="new-user-role">Access</label><select id="new-user-role" class="input"><option value="staff">Staff — buy and sell only</option><option value="admin">Admin — all features</option></select></div>
          <button type="submit" class="btn btn-primary">+ Create account</button>
        </form><div id="new-user-code" class="auth-temp-code" hidden></div><p class="hint">A unique temporary password is shown once. Give it privately to the person; they must change it at first login.</p></div>
      </section>
      <section class="card"><div class="card-header"><div><h2 class="card-title">Staff & admins</h2><p class="card-subtitle">Reset passwords or remove access without losing old receipts.</p></div><button type="button" id="user-refresh" class="btn btn-ice">↻ Refresh</button></div>
        <div class="card-body"><p id="users-status" class="hint" role="status">Loading accounts…</p><div class="table-scroll"><table class="data-table"><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody id="user-rows"></tbody></table></div></div>
      </section></div>`;
    document.getElementById('user-refresh').onclick=load;
    document.getElementById('new-user-form').onsubmit=async e=>{
      e.preventDefault();const submit=e.submitter;submit.disabled=true;
      try{
        const result=await IcyAuth.api('/users/add','POST',{username:document.getElementById('new-user-name').value,role:document.getElementById('new-user-role').value});
        showTemporary(result.user.name,result.temporaryPassword);
        document.getElementById('new-user-name').value='';await load();
      }catch(error){show(error.message)}finally{submit.disabled=false;}
    };
    await load();
  }
  function showTemporary(name,password){
    const container=document.getElementById('new-user-code');container.hidden=false;container.replaceChildren();
    container.append(node('strong',null,`Temporary password for ${name}:`));
    const code=node('code',null,password),copy=node('button','btn btn-ice','Copy temporary password');copy.type='button';
    copy.onclick=()=>navigator.clipboard.writeText(password).then(()=>show('Copied. Share it privately.')).catch(()=>show('Copy unavailable; select the code instead.'));
    container.append(code,copy);
  }
  async function load(){
    try{
      const result=await IcyAuth.api('/users');
      const target=document.getElementById('user-rows');if(!target)return;
      target.replaceChildren();
      for(const u of result.users){
        const tr=node('tr');tr.append(node('td','user-name',u.name));
        const roleCell=node('td'),selector=node('select','input role-select');
        for(const [value,label] of [['staff','Staff'],['admin','Admin']]){const opt=node('option',null,label);opt.value=value;opt.selected=u.role===value;selector.append(opt);}
        selector.disabled=u.id===IcyAuth.currentUser()?.id;selector.onchange=()=>updateUser(u,{role:selector.value});roleCell.append(selector);tr.append(roleCell);
        tr.append(node('td',u.disabled?'amount-warning':'',u.disabled?'Disabled':u.mustChange?'Setup pending':'Active'));
        const actions=node('td'),wrap=node('div','table-actions');
        const reset=node('button','small-action','Reset password');reset.onclick=()=>resetPassword(u);
        const disable=node('button','small-action pink',u.disabled?'Restore access':'Remove access');
        disable.disabled=u.id===IcyAuth.currentUser()?.id;
        disable.onclick=()=>updateUser(u,{disabled:!u.disabled});
        wrap.append(reset,disable);actions.append(wrap);tr.append(actions);target.append(tr);
      }
      show(`${result.users.length} accounts · Admins can add, remove and reset access.`);
    }catch(error){show(error.message);}
  }
  async function updateUser(user,patch){
    if(pending.has(user.id))return;
    if(!confirm(`${patch.disabled===true?'Remove access for':patch.disabled===false?'Restore access for':`Change access for`} ${user.name}?`)) {await load();return;}
    pending.add(user.id);
    try{await IcyAuth.api('/users/update','POST',{userId:user.id,...patch});await load();}
    catch(error){show(error.message);await load();}
    finally{pending.delete(user.id)}
  }
  async function resetPassword(user){
    if(!confirm(`Reset ${user.name}'s password? Their current sessions will be signed out.`))return;
    try{const response=await IcyAuth.api('/users/reset','POST',{userId:user.id});showTemporary(user.name,response.temporaryPassword);await load();}
    catch(error){show(error.message);}
  }
  return {render};
})();
