// Lehrerin v1 – alles lokal, KI über eigenen Gemini-Schlüssel
const $=s=>document.querySelector(s);
const DAY=86400000, INTERVALS=[1,3,7,14,30];
const LS={get:(k,d)=>{try{const v=localStorage.getItem('lehrerin.'+k);return v===null?d:JSON.parse(v)}catch{return d}},set:(k,v)=>localStorage.setItem('lehrerin.'+k,JSON.stringify(v))};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const today=()=>new Date().toLocaleDateString('sv-SE');
const toast=(t,ms=2600)=>{document.querySelectorAll('.toast').forEach(x=>x.remove());const d=document.createElement('div');d.className='toast';d.textContent=t;document.body.append(d);setTimeout(()=>d.remove(),ms)};
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);

/* ---------- IndexedDB ---------- */
let dbp;
function db(){return dbp||(dbp=new Promise((res,rej)=>{const r=indexedDB.open('lehrerin',1);r.onupgradeneeded=()=>{const d=r.result;
  d.createObjectStore('projects',{keyPath:'id'});
  for(const s of ['docs','chunks','cards','messages']){const o=d.createObjectStore(s,{keyPath:'id'});o.createIndex('pid','projectId')}};
  r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}))}
async function tx(store,mode,fn){const d=await db();return new Promise((res,rej)=>{const t=d.transaction(store,mode);const s=t.objectStore(store);let out;const r=fn(s);if(r)r.onsuccess=()=>out=r.result;t.oncomplete=()=>res(out);t.onerror=()=>rej(t.error)})}
const put=(s,v)=>tx(s,'readwrite',o=>o.put(v));
const putMany=(s,arr)=>tx(s,'readwrite',o=>{arr.forEach(v=>o.put(v))});
const all=s=>tx(s,'readonly',o=>o.getAll());
const byP=(s,pid)=>tx(s,'readonly',o=>o.index('pid').getAll(pid));
const del=(s,id)=>tx(s,'readwrite',o=>o.delete(id));
async function delByP(s,pid){const items=await byP(s,pid);await tx(s,'readwrite',o=>{items.forEach(i=>o.delete(i.id))})}

/* ---------- Navigation ---------- */
let cur=null; // aktuelles Projekt
const views=['home','project','chat','quiz','settings'];let stack=['home'];
function show(v,push=true){views.forEach(x=>$('#v-'+x).classList.toggle('hidden',x!==v));if(push&&stack.at(-1)!==v)stack.push(v);window.scrollTo(0,0);stopSpeak()}
document.addEventListener('click',e=>{if(e.target.closest('[data-back]')){if(stack.at(-1)==='quiz')endSession();stack.pop();const v=stack.at(-1)||'home';show(v,false);if(v==='home')renderHome();if(v==='project')renderProject()}});

/* ---------- Text, Chunks, Suche ---------- */
const STOP=new Set('der die das und oder aber ein eine einer eines einem einen ist sind war waren wird werden wurde den dem des im in am an auf aus bei mit nach von vor zu zum zur für über unter durch um als auch nicht nur noch schon so wie was wer wo wann warum welche welcher welches ich du er sie es wir ihr mir mich dir dich sich man kann können muss soll hat haben hatte dass da dann wenn mal bitte erkläre erklär sag sage mir gibt es the and of to a is are be this that for on with'.split(' '));
function tokens(t){return (t.toLowerCase().normalize('NFC').match(/[a-zäöüß0-9]{2,}/g)||[]).filter(w=>!STOP.has(w)).map(w=>w.length>6?w.slice(0,6):w)}
function chunkPages(pages,docId,docName,projectId,label){const out=[];
  for(const p of pages){const txt=p.text.replace(/\s+/g,' ').trim();if(!txt)continue;
    const sents=txt.match(/[^.!?]+[.!?]*\s*/g)||[txt];let buf='';
    const flush=()=>{if(buf.trim())out.push({id:uid(),projectId,docId,docName,page:p.page,label,text:buf.trim()});buf=''};
    for(const s of sents){if((buf+s).length>900&&buf)flush();buf+=s}flush()}
  return out}
function bm25(chunks,query,k=5){const q=[...new Set(tokens(query))];if(!q.length||!chunks.length)return[];
  const docs=chunks.map(c=>{const t=tokens(c.text);const tf={};t.forEach(w=>tf[w]=(tf[w]||0)+1);return{c,tf,len:t.length}});
  const avg=docs.reduce((a,d)=>a+d.len,0)/docs.length||1;const N=docs.length;
  const df={};q.forEach(w=>df[w]=docs.filter(d=>d.tf[w]).length);
  return docs.map(d=>{let s=0;for(const w of q){const f=d.tf[w];if(!f)continue;const idf=Math.log(1+(N-df[w]+.5)/(df[w]+.5));s+=idf*f*2.2/(f+1.2*(1-.75+.75*d.len/avg))}return{c:d.c,s}})
    .filter(x=>x.s>0).sort((a,b)=>b.s-a.s).slice(0,k).map(x=>x.c)}
const ref=c=>`${c.docName}, ${c.label||'Seite'} ${c.page}`;

/* ---------- PDF ---------- */
let pdfjs;
async function readPdf(file,onp){if(!pdfjs){pdfjs=await import('./vendor/pdf.min.mjs');pdfjs.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.min.mjs',location.href).href}
  const doc=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;const pages=[];
  for(let i=1;i<=doc.numPages;i++){const pg=await doc.getPage(i);const tc=await pg.getTextContent();
    let s='';for(const it of tc.items){s+=it.str+(it.hasEOL?'\n':' ')}pages.push({page:i,text:s});onp&&onp(i,doc.numPages)}
  return pages}
function textToPages(t){const parts=[];const paras=t.split(/\n\s*\n/);let buf='',n=1;
  for(const p of paras){if((buf+p).length>1800&&buf){parts.push({page:n++,text:buf});buf=''}buf+=p+'\n\n'}if(buf.trim())parts.push({page:n,text:buf});return parts}
async function addDoc(name,pages,label){const id=uid();const chunks=chunkPages(pages,id,name,cur.id,label);
  if(!chunks.length){toast('In dieser Datei wurde kein Text gefunden (evtl. eingescannt).',4000);return}
  await put('docs',{id,projectId:cur.id,name,pages:pages.length,label,added:Date.now()});await putMany('chunks',chunks);
  toast(`„${name}“ gespeichert ✓`)}

/* ---------- Gemini ---------- */
const DEFAULT_MODEL='gemini-3.5-flash-lite';
const key=()=>LS.get('key',''), model=()=>LS.get('model',DEFAULT_MODEL)||DEFAULT_MODEL;
async function gemini({system,contents,json=false,temp=.6}){
  if(!key())throw new Error('NOKEY');
  const body={contents,generationConfig:{temperature:temp,maxOutputTokens:1200}};
  if(system)body.systemInstruction={parts:[{text:system}]};
  if(json)body.generationConfig.responseMimeType='application/json';
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model())}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key()},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){const m=j.error?.message||r.statusText;const e=new Error(m);e.status=r.status;throw e}
  const t=(j.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();
  if(!t)throw new Error('Leere Antwort');return t}
function errText(e){if(e.message==='NOKEY')return 'Mir fehlt noch dein Gemini-Schlüssel. Trag ihn bitte unter Einstellungen ein, dann können wir loslegen. 🌱';
  if(e.status===429)return 'Das kostenlose Kontingent ist gerade aufgebraucht. Mach eine kleine Pause und versuch es in ein paar Minuten nochmals.';
  if(e.status===400||e.status===403)return 'Der Schlüssel oder das Modell funktioniert nicht ('+e.message+'). Bitte unter Einstellungen prüfen.';
  if(e.status===404)return 'Das Modell „'+model()+'“ gibt es nicht (mehr). Bitte unter Einstellungen ein anderes wählen.';
  return 'Ich erreiche die KI gerade nicht ('+e.message+'). Bist du online?'}

const PERSONA=`Du bist „die Lehrerin“: eine warme, geduldige, sehr freundliche Lehrerin. Du sprichst Deutsch (Schweizer Rechtschreibung mit „ss“ statt „ß“) und duzt die lernende Person.
Regeln:
1. Antworte AUSSCHLIESSLICH auf Grundlage des MATERIALS unten. Nutze kein Allgemeinwissen für Fakten.
2. Nenne bei jeder fachlichen Aussage die Stelle in Klammern, genau so wie im Material angegeben, z. B. (Skript.pdf, Seite 4).
3. Wenn die Antwort nicht im Material steht, sag ehrlich und freundlich: „Das steht leider nicht in deinem Material.“ und schlag vor, was man stattdessen im Material anschauen könnte. Erfinde nichts.
4. Lobe Einsatz und Fortschritt konkret, nicht nur Ergebnisse. Sei immer motivierend, nie belehrend oder herablassend.
5. Wenn die Person frustriert, müde oder entmutigt wirkt: zeig Verständnis, mach die Aufgabe kleiner (ein einziger kleiner nächster Schritt), schlag ggf. eine kurze Pause vor.
6. Du bist ausschliesslich Lehrerin. Auf romantische, flirtende, körperliche oder sexuelle Themen gehst du nicht ein – auch nicht im Spiel. Lenke höflich, kurz und ohne Vorwurf zurück aufs Lernen.
7. Halte Antworten kurz (meist 2–6 Sätze), klar, gut vorlesbar. Kein Markdown, keine Sternchen. Gerne am Ende eine kleine Rückfrage oder Mini-Übung.`;
const FRUST=/frustr|verstehe? (das |es )?(nicht|nix)|kapier|schaff (es|das) nicht|zu schwer|keine lust|aufgeben|bin (zu )?(dumm|blöd|müde)|hoffnungslos|nerv/i;

/* ---------- Stimme ---------- */
let voices=[];
function loadVoices(){voices=(speechSynthesis?.getVoices()||[]).filter(v=>/^de/i.test(v.lang));const sel=$('#k-voicesel');if(!sel)return;
  sel.innerHTML=voices.length?voices.map(v=>`<option value="${esc(v.name)}">${esc(v.name)} (${v.lang})</option>`).join(''):'<option value="">Keine deutsche Stimme gefunden</option>';
  const c=pickVoice();if(c)sel.value=c.name}
function pickVoice(){const saved=LS.get('voice','');let v=voices.find(v=>v.name===saved);if(v)return v;
  const fem=/anna|petra|helena|marlene|vicki|katja|hedda|yannick|sarah|female|frau/i;
  return voices.find(v=>/de-CH/i.test(v.lang)&&fem.test(v.name))||voices.find(v=>/anna/i.test(v.name))||voices.find(v=>fem.test(v.name)&&!/yannick/i.test(v.name))||voices.find(v=>/de-DE/i.test(v.lang))||voices[0]}
if('speechSynthesis' in window){loadVoices();speechSynthesis.onvoiceschanged=loadVoices}
const speakOn=()=>LS.get('speak',false);
function speak(t){if(!speakOn()||!('speechSynthesis' in window))return;stopSpeak();
  const clean=t.replace(/\(([^)]*Seite[^)]*)\)/g,'').replace(/[*_#]/g,'');const u=new SpeechSynthesisUtterance(clean);
  const v=pickVoice();if(v){u.voice=v;u.lang=v.lang}else u.lang='de-DE';u.rate=.98;u.pitch=1.05;speechSynthesis.speak(u)}
function stopSpeak(){try{speechSynthesis.cancel()}catch{}}
function voiceBtn(){$('#b-voice').textContent=speakOn()?'🔊 Stimme an':'🔇 Stimme aus'}

/* ---------- Home ---------- */
function learnDays(){return LS.get('days',[])}
function weekCount(){const d=learnDays();const cut=Date.now()-7*DAY;return d.filter(x=>new Date(x).getTime()>cut).length}
async function renderHome(){
  const [ps,cards]=await Promise.all([all('projects'),all('cards')]);const now=Date.now();
  const due=c=>c.seen&&c.due<=now;
  $('#s-due').textContent=cards.filter(due).length;
  const goal=+LS.get('goal',10);const done=LS.get('doneDay','')===today()?LS.get('doneCount',0):0;
  $('#s-today').textContent=`${Math.min(done,goal)}/${goal}`;
  $('#s-days').textContent=learnDays().length;
  const wk=weekCount();
  $('#s-streaknote').textContent=learnDays().length?`Diese Woche: ${wk} von 7 Tagen. Jeder Lerntag zählt – verpasste Tage löschen nichts. 💛`:'Jeder Lerntag zählt – verpasste Tage löschen nichts.';
  const h=new Date().getHours();$('#greet').textContent=(h<11?'Guten Morgen!':h<18?'Schön, dass du da bist!':'Guten Abend!')+' Kleine Schritte bringen dich weit.';
  $('#nokey').classList.toggle('hidden',!!key());
  $('#projlist').innerHTML=ps.length?ps.sort((a,b)=>b.created-a.created).map(p=>{const pc=cards.filter(c=>c.projectId===p.id);const d=pc.filter(due).length,n=pc.filter(c=>!c.seen).length;
    return `<div class="item" data-open="${p.id}"><span class="name">${esc(p.name)}</span>${d?`<span class="badge">${d} fällig</span>`:n?`<span class="small muted">${n} neu</span>`:''}<span class="muted">›</span></div>`}).join(''):'<p class="muted small">Noch kein Projekt. Leg eins an, z. B. pro Buch oder Kapitel.</p>'}
$('#projlist').addEventListener('click',async e=>{const it=e.target.closest('[data-open]');if(!it)return;cur=(await all('projects')).find(p=>p.id===it.dataset.open);show('project');renderProject()});
$('#b-addproj').onclick=async()=>{const n=$('#newproj').value.trim();if(!n)return $('#newproj').focus();const p={id:uid(),name:n,created:Date.now()};await put('projects',p);$('#newproj').value='';cur=p;show('project');renderProject()};
$('#newproj').addEventListener('keydown',e=>{if(e.key==='Enter')$('#b-addproj').click()});
$('#b-settings').onclick=()=>{show('settings');renderSettings()};$('#go-settings').onclick=e=>{e.preventDefault();$('#b-settings').click()};

/* ---------- Projekt ---------- */
async function renderProject(){if(!cur)return;$('#p-title').textContent=cur.name;
  const [docs,chunks,cards]=await Promise.all([byP('docs',cur.id),byP('chunks',cur.id),byP('cards',cur.id)]);const now=Date.now();
  $('#doclist').innerHTML=docs.length?docs.map(d=>`<div class="item"><span class="name">📄 ${esc(d.name)}</span><span class="small muted">${d.pages} ${d.label==='Abschnitt'?'Abschn.':'S.'}</span><button class="ghost small" data-deldoc="${d.id}">✕</button></div>`).join(''):'<p class="muted small">Noch kein Material. Lade ein PDF hoch oder füge Text ein.</p>';
  $('#p-stats').textContent=chunks.length?`${chunks.length} Textabschnitte bereit für Fragen.`:'';
  const due=cards.filter(c=>c.seen&&c.due<=now).length,nw=cards.filter(c=>!c.seen).length;
  $('#p-due').textContent=due+nw;$('#p-cards').textContent=cards.length?`${cards.length} Karten · ${due} fällig · ${nw} neu`:'Noch keine Karten. Die Lehrerin erstellt sie aus deinem Material.'}
$('#doclist').addEventListener('click',async e=>{const b=e.target.closest('[data-deldoc]');if(!b)return;if(!confirm('Dieses Material löschen?'))return;const id=b.dataset.deldoc;
  const ch=(await byP('chunks',cur.id)).filter(c=>c.docId===id);await tx('chunks','readwrite',o=>{ch.forEach(c=>o.delete(c.id))});await del('docs',id);renderProject()});
$('#b-delproj').onclick=async()=>{if(!confirm(`Projekt „${cur.name}“ mit allem Material und allen Karten löschen?`))return;
  for(const s of ['docs','chunks','cards','messages'])await delByP(s,cur.id);await del('projects',cur.id);cur=null;stack=['home'];show('home',false);renderHome()};
$('#b-upload').onclick=()=>$('#file').click();
$('#file').onchange=async e=>{const files=[...e.target.files];e.target.value='';
  for(const f of files){try{
    if(/pdf$/i.test(f.type)||/\.pdf$/i.test(f.name)){$('#p-progress').textContent=`Lese „${f.name}“ …`;
      const pages=await readPdf(f,(i,n)=>$('#p-progress').textContent=`Lese „${f.name}“: Seite ${i} von ${n}`);await addDoc(f.name,pages,'Seite')}
    else{await addDoc(f.name,textToPages(await f.text()),'Abschnitt')}
  }catch(err){console.error(err);toast('Konnte „'+f.name+'“ nicht lesen.',4000)}}
  $('#p-progress').textContent='';renderProject()};
$('#b-addtext').onclick=async()=>{const t=$('#t-body').value.trim();if(!t)return;await addDoc($('#t-name').value.trim()||'Eingefügter Text',textToPages(t),'Abschnitt');$('#t-body').value='';$('#t-name').value='';renderProject()};

/* ---------- Karten erzeugen ---------- */
async function generateCards(n=5){const chunks=await byP('chunks',cur.id);if(!chunks.length){toast('Lade zuerst Material hoch.');return 0}
  const used=new Set(LS.get('used.'+cur.id,[]));let pool=chunks.filter(c=>!used.has(c.id));if(pool.length<3){pool=chunks;used.clear()}
  const start=Math.floor(Math.random()*Math.max(1,pool.length-3));const pick=pool.slice(start,start+3);
  const mat=pick.map(c=>`[${ref(c)}]\n${c.text}`).join('\n\n');
  const prompt=`Erstelle ${n} kurze Lernkarten auf Deutsch (Schweizer Rechtschreibung) NUR aus diesem Material. Jede Karte prüft genau einen wichtigen Fakt.
Gib JSON zurück: [{"fakt":"der Fakt als 1-2 klare Sätze zum Einprägen","frage":"eine kurze Frage dazu","antwort":"kurze richtige Antwort","stelle":"die Stellenangabe genau wie in eckigen Klammern"}]
MATERIAL:\n${mat}`;
  const raw=await gemini({contents:[{role:'user',parts:[{text:prompt}]}],json:true,temp:.4});
  let arr;try{arr=JSON.parse(raw.replace(/^```(json)?|```$/g,''))}catch{throw new Error('Antwort war kein gültiges JSON')}
  if(!Array.isArray(arr))arr=arr.karten||arr.cards||[];
  const cards=arr.filter(x=>x.frage&&x.antwort).slice(0,n).map(x=>({id:uid(),projectId:cur.id,q:x.frage,a:x.antwort,fact:x.fakt||x.antwort,src:x.stelle||ref(pick[0]),level:0,due:0,seen:false,created:Date.now()}));
  await putMany('cards',cards);pick.forEach(c=>used.add(c.id));LS.set('used.'+cur.id,[...used]);return cards.length}
$('#b-gen').onclick=async()=>{const b=$('#b-gen');b.disabled=true;b.textContent='Die Lehrerin bereitet Fragen vor …';
  try{const k=await generateCards(5);if(k)toast(`${k} neue Karten ✓`)}catch(e){toast(errText(e),5000)}
  b.disabled=false;b.textContent='✨ 5 neue Fragen aus dem Material erstellen';renderProject()};

/* ---------- Chat ---------- */
let history=[];
$('#b-chat').onclick=()=>openChat();
async function openChat(){show('chat');$('#c-title').textContent=cur.name;voiceBtn();
  const msgs=(await byP('messages',cur.id)).sort((a,b)=>a.ts-b.ts);history=msgs.slice(-12);$('#chatlog').innerHTML='';
  if(!msgs.length)addMsg('bot',`Hallo! Schön, dass du da bist. 😊 Ich helfe dir mit „${cur.name}“. Frag mich einfach, was du wissen möchtest – ich antworte nur aus deinem Material und sag dir, auf welcher Seite es steht.`,false);
  else msgs.slice(-30).forEach(m=>addMsg(m.role,m.text,false));
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;$('#b-mic').classList.toggle('hidden',!SR);
  $('#c-hint').textContent=SR?'':'Tipp: Zum Sprechen das 🎤 auf der iPhone-Tastatur antippen.';
  setTimeout(()=>window.scrollTo(0,document.body.scrollHeight),50)}
function addMsg(role,text,save=true){const d=document.createElement('div');d.className='msg '+role;d.innerHTML=(role==='bot'?'<div class="who">Lehrerin</div>':'')+esc(text);$('#chatlog').append(d);
  window.scrollTo(0,document.body.scrollHeight);if(save){const m={id:uid(),projectId:cur.id,role,text,ts:Date.now()};put('messages',m);history.push(m);history=history.slice(-12)}return d}
async function send(){const t=$('#c-in').value.trim();if(!t)return;$('#c-in').value='';addMsg('user',t);
  const typing=addMsg('bot','schreibt …',false);typing.classList.add('typing');$('#b-send').disabled=true;
  try{const chunks=await byP('chunks',cur.id);const ctxQ=t+' '+(history.filter(m=>m.role==='user').slice(-2,-1)[0]?.text||'');
    const top=bm25(chunks,ctxQ,5);
    const mat=top.length?top.map(c=>`[${ref(c)}]\n${c.text}`).join('\n\n'):(chunks.length?'(Zu dieser Frage wurde im Material nichts Passendes gefunden.)':'(Es wurde noch kein Material hochgeladen.)');
    let sys=PERSONA+`\n\nPROJEKT: ${cur.name}\nMATERIAL (Auszüge, mit Stellenangabe in eckigen Klammern):\n${mat}`;
    if(FRUST.test(t))sys+='\n\nHINWEIS: Die Person wirkt gerade frustriert. Sei besonders verständnisvoll und mach den nächsten Schritt sehr klein.';
    const contents=history.slice(0,-1).slice(-8).map(m=>({role:m.role==='user'?'user':'model',parts:[{text:m.text}]}));contents.push({role:'user',parts:[{text:t}]});
    const ans=await gemini({system:sys,contents});typing.remove();addMsg('bot',ans);speak(ans)}
  catch(e){typing.remove();addMsg('bot',errText(e),false)}
  $('#b-send').disabled=false}
$('#b-send').onclick=send;
$('#c-in').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!/iPhone|iPad|Android/.test(navigator.userAgent)){e.preventDefault();send()}});
$('#b-voice').onclick=()=>{LS.set('speak',!speakOn());voiceBtn();if(!speakOn())stopSpeak();else speak('Gerne lese ich dir meine Antworten vor.')};
$('#b-clear').onclick=async()=>{if(!confirm('Gespräch neu beginnen?'))return;await delByP('messages',cur.id);openChat()};
let rec=null;
$('#b-mic').onclick=()=>{const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR)return;
  if(rec){rec.stop();return}stopSpeak();rec=new SR();rec.lang='de-CH';rec.interimResults=true;rec.continuous=false;const base=$('#c-in').value;
  rec.onresult=e=>{$('#c-in').value=(base+' '+[...e.results].map(r=>r[0].transcript).join('')).trim()};
  rec.onerror=e=>{if(e.error==='language-not-supported'){rec.lang='de-DE'}toast('Mikrofon: '+e.error)};
  rec.onend=()=>{rec=null;$('#b-mic').textContent='🎤'};$('#b-mic').textContent='⏹';try{rec.start()}catch{rec=null}};

/* ---------- Heute lernen (Spaced Repetition, fehlerfreies Lernen) ---------- */
let S=null;
$('#b-learn').onclick=()=>startSession();
async function startSession(){const goal=+LS.get('goal',10);let cards=await byP('cards',cur.id);const now=Date.now();
  if(!cards.some(c=>!c.seen)&&!cards.some(c=>c.seen&&c.due<=now)){
    if(!(await byP('chunks',cur.id)).length){toast('Lade zuerst Material hoch. 📄');return}
    toast('Die Lehrerin bereitet neue Fragen vor …',3000);
    try{await generateCards(5)}catch(e){toast(errText(e),5000);return}cards=await byP('cards',cur.id)}
  const due=cards.filter(c=>c.seen&&c.due<=now).sort((a,b)=>a.due-b.due);
  const nw=cards.filter(c=>!c.seen).sort((a,b)=>a.created-b.created);
  const queue=[...due.slice(0,goal),...nw.slice(0,Math.max(0,Math.min(5,goal-due.length)))];
  if(!queue.length){toast('Heute ist alles erledigt. Super! 🌟');return}
  S={queue,i:0,ok:0,start:Date.now(),timer:setInterval(tick,1000)};show('quiz');step()}
function tick(){if(!S)return;const m=Math.floor((Date.now()-S.start)/60000);$('#q-timer').textContent=`${m} Min.`;
  if(m>=12&&!S.warned){S.warned=true;toast('Du lernst schon 12 Minuten – toll! Eine Pause ist jetzt völlig okay. ☕',4500)}}
function endSession(){if(S){clearInterval(S.timer);S=null}stopSpeak()}
function step(){const box=$('#q-box');$('#q-bar').style.width=(S.i/S.queue.length*100)+'%';
  if(S.i>=S.queue.length){const n=S.queue.length;
    box.innerHTML=`<h2>Geschafft! 🎉</h2><p>Du hast ${n} ${n===1?'Karte':'Karten'} geübt und ${S.ok} davon gewusst. Jede Wiederholung stärkt dein Gedächtnis – darauf kannst du stolz sein.</p><p class="muted small">Morgen geht es mit ein paar Minuten weiter. Ganz entspannt.</p><button class="primary big" id="q-done">Fertig</button>`;
    speak(`Geschafft! Du hast ${n} Karten geübt. Darauf kannst du stolz sein.`);$('#q-done').onclick=history_back;return}
  const c=S.queue[S.i];
  if(!c.seen&&!c._factShown){box.innerHTML=`<p class="small muted">Neu · Zuerst einprägen</p><p class="fact">${esc(c.fact)}</p><p class="src">${esc(c.src)}</p><button class="primary big" id="q-next">Verstanden – frag mich</button>`;
    speak(c.fact);$('#q-next').onclick=()=>{c._factShown=true;step()};return}
  box.innerHTML=`<p class="small muted">Karte ${S.i+1} von ${S.queue.length}</p><p class="quizq">${esc(c.q)}</p><p class="small muted">Überleg kurz in Ruhe – oder sag die Antwort laut.</p><button class="primary big" id="q-show">Antwort zeigen</button>`;
  speak(c.q);$('#q-show').onclick=()=>{
    box.innerHTML=`<p class="small muted">Karte ${S.i+1} von ${S.queue.length}</p><p class="quizq">${esc(c.q)}</p><p class="fact">${esc(c.a)}</p><p class="src">${esc(c.src)}</p><div class="row"><button id="q-no">Noch nicht sicher</button><button class="primary" id="q-yes">Gewusst ✓</button></div>`;
    $('#q-yes').onclick=()=>grade(c,true);$('#q-no').onclick=()=>grade(c,false)}}
const PRAISE=['Super gemacht!','Toll, weiter so!','Sehr gut!','Du wirst immer sicherer!','Klasse!'];
const COMFORT=['Kein Problem – genau so lernt man. Wir üben das morgen nochmals.','Gut, dass du ehrlich bist. Morgen sitzt es schon besser.','Das ist völlig okay. Schritt für Schritt!'];
async function grade(c,ok){const now=Date.now();
  if(ok){c.level=Math.min((c.seen?c.level:0)+1,INTERVALS.length);c.due=now+INTERVALS[c.level-1]*DAY;S.ok++}
  else{c.level=0;c.due=now+DAY}
  c.seen=true;delete c._factShown;c.last=now;await put('cards',c);
  const d=today();if(LS.get('doneDay','')!==d){LS.set('doneDay',d);LS.set('doneCount',0)}LS.set('doneCount',LS.get('doneCount',0)+1);
  const days=learnDays();if(!days.includes(d)){days.push(d);LS.set('days',days)}
  const msg=ok?PRAISE[Math.floor(Math.random()*PRAISE.length)]:COMFORT[Math.floor(Math.random()*COMFORT.length)];toast(msg,1500);S.i++;step()}
function history_back(){document.querySelector('#v-quiz [data-back]').click()}

/* ---------- Einstellungen ---------- */
function renderSettings(){$('#k-key').value=key();$('#k-model').value=model();$('#k-speak').checked=speakOn();$('#k-goal').value=String(LS.get('goal',10));loadVoices();$('#k-status').textContent=''}
$('#b-savekey').onclick=()=>{LS.set('key',$('#k-key').value.trim());LS.set('model',$('#k-model').value.trim()||DEFAULT_MODEL);$('#k-status').textContent='Gespeichert ✓'};
$('#b-testkey').onclick=async()=>{$('#b-savekey').click();$('#k-status').textContent='Teste …';
  try{const t=await gemini({contents:[{role:'user',parts:[{text:'Sag in einem kurzen Satz auf Deutsch Hallo.'}]}]});$('#k-status').textContent='Funktioniert ✓ – '+t}catch(e){$('#k-status').textContent=errText(e)}};
$('#k-speak').onchange=e=>LS.set('speak',e.target.checked);
$('#k-voicesel').onchange=e=>LS.set('voice',e.target.value);
$('#b-voicetest').onclick=()=>{const was=speakOn();LS.set('speak',true);speak('Hallo! Ich bin deine Lehrerin. Schön, dass du heute lernst.');LS.set('speak',was)};
$('#k-goal').onchange=e=>LS.set('goal',+e.target.value);

/* ---------- Start ---------- */
renderHome();
if('serviceWorker' in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('sw.js');
window.__lehrerin={bm25,tokens,chunkPages};
