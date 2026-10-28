/* dsh-sidebar-pet — no build dependencies; browser module-loader entry. */
(function(){
'use strict';
window.__ModuleLoader__.load({id:'dsh-sidebar-pet',factory(require){
 const React=require('react'),h=React.createElement,{useState,useEffect}=React;
 const OWNER='dsh-sidebar-pet',BASE='/dsh-pet-7340/menu',ATTR='data-dsh-sidebar-pet-hidden';
 const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
 function title(e){try{const x=e.options.label;return normalize(typeof x==='function'?x():x);}catch{return '';}}
 function id(e){return String(e.options.id||e.options.key||'');}
 async function request(url,body,signal,method){const r=await fetch(url,{method:method||(body===undefined?'GET':'POST'),cache:'no-store',signal,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();if(!r.ok||data.ok===false)throw Error(data.message||data.error||data.reason||String(r.status));return data;}
 function apply(ctx){
  let stopped=false,selected=[],catalog=[],listeners=new Set(),message='',signature='',saving=false,pending=false;
  const abort=new AbortController(),cleanups=[];
  const style=document.createElement('style');style.textContent='['+ATTR+']{display:none!important}.dsp-settings{padding:16px 0;max-width:680px}.dsp-settings label{display:flex;align-items:center;gap:10px;padding:9px 0}.dsp-settings small{opacity:.65}';document.head.appendChild(style);
  const all=slot=>{try{return ctx.slots.entriesOfSlot(slot)||[];}catch{return [];}};
  function emit(){for(const fn of listeners)fn();}
  // The desktop pet hitbox can overlap the top-left New session control.
  // Forward only that pointer-down to the real button; pet dragging remains intact elsewhere.
  function forwardNewSessionPointer(e){
   if(e.button!==0)return;
   const hit=e.target?.closest?.('.dsh-pet-hit');
   if(!hit)return;
   const node=[...document.querySelectorAll('button[aria-label="新建会话"],[role="button"][aria-label="新建会话"]')].find(button=>{
    const r=button.getBoundingClientRect();
    return r.width>0&&r.height>0&&e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom;
   });
   if(!node)return;
   e.preventDefault();
   e.stopPropagation();
   e.stopImmediatePropagation();
   node.click();
  }
  function discover(){
   const next=[];const used=new Set();
   const panelButtons=[...document.querySelectorAll('button[aria-label]')].filter(n=>n.querySelector('[data-slot="sidebar.panellist"]'));
   for(const entry of all('sidebar.panellist')){const key=id(entry),label=title(entry);if(!key||!label)continue;const node=panelButtons.find(n=>normalize(n.getAttribute('aria-label'))===label);next.push({key:'panel:'+key,label,node,run:()=>ctx.layout.selectPanel(key)});}
   const footer=[...document.querySelectorAll('[data-slot="sidebar.footer.action"] button,[data-slot="sidebar.footer.action"] [role="button"],[data-slot="sidebar.footer.action"] a[href]')];
   const footerEntries=all('sidebar.footer.action');
   for(const node of footer){const raw=normalize(node.getAttribute('aria-label')||node.title||node.textContent);const label=raw==='导入会话导入会话'?'导入会话':raw;if(!label||used.has(label)||node.closest('.dsp-settings'))continue;used.add(label);const e=footerEntries.find(e=>title(e)===label);const key='footer:'+(e?id(e):label);next.push({key,label,node,run:()=>node.click()});}
   catalog=next;const wanted=new Set(selected);const nodes=new Set(next.filter(e=>wanted.has(e.key)).map(e=>e.node).filter(Boolean));
   document.querySelectorAll('['+ATTR+']').forEach(n=>{if(!nodes.has(n))n.removeAttribute(ATTR)});
   nodes.forEach(n=>{if(!n.hasAttribute(ATTR))n.setAttribute(ATTR,'1')});
   emit();void sync();
  }
  function menuEntries(){const used=new Set();return catalog.filter(e=>selected.includes(e.key)).map(e=>{let label=e.label.slice(0,28),n=2;while(used.has(label))label=e.label.slice(0,25)+' ('+(n++)+')';used.add(label);return {...e,menuLabel:label};});}
  async function sync(){if(stopped)return;const items=menuEntries(),sig=JSON.stringify(items.map(e=>e.menuLabel));if(sig===signature)return;signature=sig;try{if(items.length>20)throw Error('大肥鱼当前最多支持 20 个迁移入口');if(items.length)await request(BASE+'/item',{owner:OWNER,labels:items.map(e=>e.menuLabel)},abort.signal);else await request(BASE+'/item?owner='+OWNER,undefined,abort.signal,'DELETE');message='';}catch(e){signature='';if(!stopped)message='菜单同步失败：'+e.message;}emit();}
  async function save(value){if(saving)return;saving=true;emit();try{await request('/sidebar-pet/config',{selected:value},abort.signal);selected=value;discover();message='已保存';}catch(e){message='保存失败：'+e.message;}finally{saving=false;emit();}}
  function Settings(){const [,setRevision]=useState(0);useEffect(()=>{const fn=()=>setRevision(x=>x+1);listeners.add(fn);return()=>listeners.delete(fn)},[]);return h('section',{className:'dsp-settings'},h('h3',null,'左侧栏入口迁移'),h('p',null,'勾选的入口将隐藏在左侧，并平铺到大肥鱼右键菜单。取消勾选立即恢复；新插件默认保留在左侧。'),catalog.map(e=>h('label',{key:e.key},h('input',{type:'checkbox',disabled:saving,checked:selected.includes(e.key),onChange:()=>save(selected.includes(e.key)?selected.filter(x=>x!==e.key):[...selected,e.key])}),e.label)),!catalog.length&&h('p',null,'展开左侧栏后自动发现入口。'),h('small',{role:'status'},message));}
  // Append inside the existing pet section while preserving the renderer's original injection.
  ctx.slots.inject('settings.section',()=>{
   const pet=all('settings.section').find(e=>id(e)==='pet-config');
   if(pet){const Original=pet.component;return ctx.slots.register({...pet.options,priority:(pet.options.priority||0)-100,label:pet.options.label,inject:pet.inject||pet.options.inject},props=>h(React.Fragment,null,h(Original,props),h(Settings)));}
   return ctx.slots.register({name:'settings.section',id:OWNER,order:31,label:'大肥鱼右键栏'},Settings);
  });
  for(const slot of ['sidebar.panellist','sidebar.footer.action']){const off=ctx.slots.subscribe(slot,()=>queueDiscover());if(typeof off==='function')cleanups.push(off);}
  function queueDiscover(){if(pending||stopped)return;pending=true;queueMicrotask(()=>{pending=false;if(!stopped)discover()});}
  const observer=new MutationObserver(records=>{if(records.some(r=>!r.target.closest?.('.dsp-settings')))queueDiscover()});observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-label']});
  document.addEventListener('pointerdown',forwardNewSessionPointer,true);
  cleanups.push(()=>document.removeEventListener('pointerdown',forwardNewSessionPointer,true));
  const delay=ms=>new Promise(resolve=>{const done=()=>{clearTimeout(timer);abort.signal.removeEventListener('abort',done);resolve()};const timer=setTimeout(done,ms);abort.signal.addEventListener('abort',done,{once:true})});
  async function poll(){while(!stopped){try{if(!menuEntries().length){await delay(1500);continue;}const data=await request(BASE+'/events?owner='+OWNER+'&wait=10000',undefined,abort.signal);for(const [label,pet] of Object.entries(data.events||{})){if(!pet)continue;const item=menuEntries().find(e=>e.menuLabel===label);if(item)item.run();}}catch(e){if(stopped)break;signature='';await sync();await delay(1500);}}}
  request('/sidebar-pet/config',undefined,abort.signal).then(data=>{selected=data.selected||[];discover();void poll()}).catch(e=>{message='配置读取失败：'+e.message;emit()});
  const interval=setInterval(()=>{signature='';queueDiscover()},30000);
  discover();
  ctx.effect(()=>()=>{stopped=true;abort.abort();clearInterval(interval);observer.disconnect();cleanups.forEach(fn=>fn());style.remove();document.querySelectorAll('['+ATTR+']').forEach(n=>n.removeAttribute(ATTR));void request(BASE+'/item?owner='+OWNER,undefined,undefined,'DELETE').catch(()=>{});listeners.clear();});
 }
 return {name:'dsh-sidebar-pet',inject:['slots','layout'],apply};
}});
})();
