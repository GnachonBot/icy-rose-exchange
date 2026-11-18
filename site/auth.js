"use strict";
// Browser-only session: short-lived opaque token. No user passwords are stored here.
window.IcyAuth = (() => {
  const key='icy-rose-session-v1';
  const endpoint=String(window.ICY_ROSE_CONFIG?.receiptEndpoint||'').trim().replace(/\/receipt\/?$/,'');
  let token=''; let user=null; let resume=null;
  try{token=sessionStorage.getItem(key)||'';}catch{}
  const screen=()=>document.getElementById('auth-screen');
  const message=(txt)=>{const node=document.getElementById('auth-notice');if(node)node.textContent=txt;};
  function hide(){const node=screen();if(node)node.hidden=true;const app=document.querySelector('.app-shell');if(app)app.hidden=false;}
  function show(html){const app=document.querySelector('.app-shell');if(app)app.hidden=true;const node=screen();node.hidden=false;document.getElementById('auth-panel').innerHTML=html;message('');}
  function escape(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function savedToken(value){token=value;try{value?sessionStorage.setItem(key,value):sessionStorage.removeItem(key);}catch{}}
  async function api(path,method='GET',body=null){
    if(!endpoint)throw Error('Set your Cloudflare Worker URL in site/config.js first.');
    const response=await fetch(endpoint+'/auth'+path,{method,headers:{'Content-Type':'application/json',...headers()},...(body===null?{}:{body:JSON.stringify(body)}),cache:'no-store',signal:AbortSignal.timeout(16000)});
    const value=await response.json().catch(()=>({}));
    if(!response.ok||!value.ok)throw Error(value.error||`Request failed (${response.status})`);
    return value;
  }
  function headers(){return token?{'Authorization':`Bearer ${token}`}:{ };}
  function currentUser(){return user;}
  function isAdmin(){return user?.role==='admin'&&user.mustChange!==true;}
  function signedIn(){return !!user&&user.mustChange!==true;}
  function ready(){hide();if(resume){const go=resume;resume=null;go(user);}}
  function showSignIn(){
    show(`<div class="auth-eyebrow">ICY ROSE EXCHANGE / STAFF ACCESS</div><h1>Welcome back.</h1>
      <p class="auth-copy">Sign in with your own name to record orders and receipts.</p>
      <form id="auth-signin-form" class="auth-form">
        <label for="auth-username">Your name</label><input id="auth-username" name="username" class="input" type="text" maxlength="35" list="auth-initial-names" autocomplete="username" placeholder="David, Ice, Rick…" required autofocus />
        <datalist id="auth-initial-names"><option value="David"><option value="Ice"><option value="Rick"><option value="Tink"><option value="Tiff"></datalist>
        <label for="auth-password">Password / first-time setup code</label><input id="auth-password" name="password" class="input" type="password" autocomplete="current-password" required />
        <button class="btn btn-primary" type="submit">Sign in →</button>
        <p id="auth-notice" role="alert" class="auth-error"></p>
      </form><p class="auth-footnote">First login? Use the private setup code given by the shop owner. You'll then choose your personal password.</p>`);
    document.getElementById('auth-signin-form').addEventListener('submit',async e=>{
      e.preventDefault();const button=e.submitter;button.disabled=true;button.textContent='Signing in…';
      try{
        const username=document.getElementById('auth-username').value;
        const password=document.getElementById('auth-password').value;
        const result=await api('/login','POST',{username,password});
        savedToken(result.token);user=result.user;
        if(user.mustChange)showChangePassword(true);else ready();
      }catch(error){message(error.message);button.disabled=false;button.textContent='Sign in →';}
    });
  }
  function showChangePassword(required=false){
    show(`<div class="auth-eyebrow">${required?'FIRST-TIME ACCOUNT SETUP':'ACCOUNT SECURITY'}</div>
      <h1>${required?'Choose your password.':'Change password.'}</h1>
      <p class="auth-copy">${required?'Welcome '+escape(user?.name||'')+'. Set your own password before entering the shop.':'Your current sign-in will stay active.'}</p>
      <form id="auth-change-form" class="auth-form">
        ${required?'':'<label for="auth-current">Current password</label><input id="auth-current" class="input" type="password" autocomplete="current-password" required />'}
        <label for="auth-new">New password (12+ characters)</label><input id="auth-new" class="input" type="password" minlength="12" maxlength="128" autocomplete="new-password" required />
        <label for="auth-confirm">Confirm new password</label><input id="auth-confirm" class="input" type="password" minlength="12" maxlength="128" autocomplete="new-password" required />
        <button class="btn btn-primary" type="submit">Save personal password</button>
        ${required?'':'<button id="auth-cancel" class="btn btn-ice" type="button">Cancel</button>'}
        <p id="auth-notice" class="auth-error" role="alert"></p>
      </form>`);
    if(!required)document.getElementById('auth-cancel').onclick=hide;
    document.getElementById('auth-change-form').addEventListener('submit',async e=>{
      e.preventDefault();const value=document.getElementById('auth-new').value;
      if(value!==document.getElementById('auth-confirm').value){message('The two passwords do not match.');return;}
      const button=e.submitter;button.disabled=true;
      try{
        const body={newPassword:value};
        if(!required)body.currentPassword=document.getElementById('auth-current').value;
        const result=await api('/password','POST',body);
        user=result.user;ready();
      }catch(error){message(error.message);button.disabled=false;}
    });
  }
  async function start(){
    if(token){
      try{const result=await api('/me');user=result.user;if(!user.mustChange)return user;}
      catch{savedToken('');user=null;}
    }
    return new Promise(resolve=>{resume=resolve;if(user?.mustChange)showChangePassword(true);else showSignIn();});
  }
  async function signOut(){
    try{await api('/logout','POST',{});}catch{}
    savedToken('');user=null;
    // Prevent a different employee seeing the previous staff member's cart.
    try{localStorage.removeItem('icy-rose-shop-v1');}catch{}
    location.reload();
  }
  function expired(){savedToken('');user=null;location.reload();}
  function attachHeader(){
    const header=document.querySelector('.topbar');
    if(!header||!user)return;
    const right=header.querySelector('.topbar-account');if(right)right.remove();
    const div=document.createElement('div');div.className='topbar-account';
    const name=document.createElement('span');name.className='topbar-username';name.textContent=`${user.name} · ${user.role==='admin'?'Admin':'Staff'}`;
    const change=document.createElement('button');change.type='button';change.textContent='Password';change.className='account-link';change.onclick=()=>showChangePassword(false);
    const logout=document.createElement('button');logout.type='button';logout.textContent='Sign out';logout.className='account-link';logout.onclick=signOut;
    div.append(name,change,logout);header.append(div);
  }
  return {start,api,headers,currentUser,isAdmin,signedIn,signOut,expired,attachHeader};
})();
