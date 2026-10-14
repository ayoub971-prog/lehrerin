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

/* Schlüssel doppelt sichern (localStorage + IndexedDB), iOS-Speichertrennung/Löschung abfedern */
function kvDb(){return new Promise((res,rej)=>{const r=indexedDB.open('lehrerin-kv',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function kvGet(k){try{const d=await kvDb();return await new Promise(r=>{const q=d.transaction('kv').objectStore('kv').get(k);q.onsuccess=()=>r(q.result);q.onerror=()=>r(undefined)})}catch{return undefined}}
async function kvSet(k,v){try{const d=await kvDb();await new Promise(r=>{const t=d.transaction('kv','readwrite');t.objectStore('kv').put(v,k);t.oncomplete=r;t.onerror=r})}catch{}}
let memKey='';
function saveKey(v){v=(v||'').trim();if(!v)return;memKey=v;try{LS.set('key',v)}catch{}return kvSet('key',v)}
let keySynced=null;
function syncKey(){return keySynced||(keySynced=(async()=>{const l=LS.get('key',''),i=await kvGet('key');
  if(i)memKey=i;if(!l&&i){try{LS.set('key',i)}catch{}}else if(l&&l!==i)await kvSet('key',l)})())}
try{navigator.storage&&navigator.storage.persist&&navigator.storage.persist()}catch{}
async function tx(store,mode,fn){const d=await db();return new Promise((res,rej)=>{const t=d.transaction(store,mode);const s=t.objectStore(store);let out;const r=fn(s);if(r)r.onsuccess=()=>out=r.result;t.oncomplete=()=>res(out);t.onerror=()=>rej(t.error)})}
const put=(s,v)=>tx(s,'readwrite',o=>o.put(v));
const putMany=(s,arr)=>tx(s,'readwrite',o=>{arr.forEach(v=>o.put(v))});
const all=s=>tx(s,'readonly',o=>o.getAll());
const byP=(s,pid)=>tx(s,'readonly',o=>o.index('pid').getAll(pid));
const del=(s,id)=>tx(s,'readwrite',o=>o.delete(id));
async function delByP(s,pid){const items=await byP(s,pid);await tx(s,'readwrite',o=>{items.forEach(i=>o.delete(i.id))})}

/* ---------- Navigation ---------- */
let cur=null; // aktuelles Projekt
const views=['home','project','chat','quiz','settings','book','flash','sum'];let stack=['home'];
function show(v,push=true){views.forEach(x=>$('#v-'+x).classList.toggle('hidden',x!==v));if(push&&stack.at(-1)!==v)stack.push(v);window.scrollTo(0,0);stopSpeak();if(typeof SUM!=='undefined')SUM.playing=false;if(v!=='chat'&&typeof talkMode!=='undefined'&&(talkMode||rec||mr)){talkMode=false;try{stopMic()}catch{}}}
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
const key=()=>LS.get('key','')||memKey, model=()=>LS.get('model',DEFAULT_MODEL)||DEFAULT_MODEL;
async function gemini({system,contents,json=false,temp=.6,maxTokens=1200}){
  if(!key())throw new Error('NOKEY');
  const body={contents,generationConfig:{temperature:temp,maxOutputTokens:maxTokens}};
  if(system)body.systemInstruction={parts:[{text:system}]};
  if(json)body.generationConfig.responseMimeType='application/json';
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model())}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key()},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){const m=j.error?.message||r.statusText;const e=new Error(m);e.status=r.status;throw e}
  const t=(j.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();
  if(!t)throw new Error('Leere Antwort');return t}
function errText(e){if(e.message==='NOKEY')return 'Mir fehlt noch dein Gemini-Schlüssel. Trag ihn bitte unter Einstellungen ein, dann können wir loslegen. 🌱';
  if(e.status===429)return 'Das kostenlose Kontingent ist gerade aufgebraucht. Mach eine kleine Pause und versuch es in ein paar Minuten nochmals.';
  if((e.status===400||e.status===403||e.status===401)&&/key|schlüssel|API_KEY|permission|denied|expired/i.test(e.message))return 'Dein Gemini-Schlüssel fehlt oder ist ungültig (vielleicht gelöscht). Bitte unter ⚙︎ Einstellungen einen neuen Schlüssel eintragen.';
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
7. Halte Antworten kurz (meist 2–6 Sätze), klar, gut vorlesbar. Kein Markdown, keine Sternchen. Gerne am Ende eine kleine Rückfrage oder Mini-Übung.
8. Bei Fragen: Wenn du der Person etwas fragst, hole die Frage immer aus dem Original-PDF oder Text, stelle sie selbst her und stelle jede Frage, die zu dem Verfügbaren gestellt werden kann. Beurteile eine Antwort der Person nie aus dem Gedächtnis und nie mit einem blossen Urteil, sondern vergleiche sie immer mit dem Originaltext im PDF oder Text und zeige diesen Vergleich: zitiere die passende Stelle wörtlich mit Seitenangabe und erkläre, was gleich ist und was abweicht. Am Ende sag klar: richtig oder nicht richtig.
9. Nur richtig beantwortete Fragen gelten für den Tag als erledigt. Wenn du an einem Tag drei Fragen gestellt hast und die Person alle richtig beantwortet hat, stellst du diese Fragen an diesem Tag nicht noch einmal. Eine falsch beantwortete Frage darfst und sollst du am selben Tag erneut stellen. Neue Fragen für den Rest des Tages holst du aus dem Original-PDF oder Text, und zwar nur solche, die noch nicht richtig beantwortet wurden.
10. Wenn die Person eine Frage falsch beantwortet, stellst du diese Frage immer wieder, bis die Antwort richtig ist.
11. Wiederholung nach dem Anki-Prinzip: Eine richtig beantwortete Frage kommt erst nach wachsendem Abstand wieder (1 Tag, 3 Tage, 1 Woche, 2 Wochen, 1 Monat, danach jeweils doppelt so lang). Eine falsch beantwortete Frage beginnt wieder von vorne.
12. Jede Frage, die du stellst, beginnt mit einem Emoji, das zum Inhalt der Frage passt.
13. Kennzeichne die Wichtigkeit des Inhalts direkt nach dem Emoji mit einem farbigen Punkt: 🔴 sehr wichtig, 🟡 wichtig, 🔵 normal.
14. Wenn die Person Lernkarten für Anki möchte (zum Beispiel „das will ich als Anki importieren“), gib die relevanten Inhalte als Anki-Importtext aus: in der ersten Zeile „#separator:Semicolon“, danach pro Zeile genau eine Karte im Format Frage;Antwort, ohne weitere Erklärungen dazwischen, alles nur aus dem Material.
15. Prüfe vor jeder Aussage mehrfach, ob sie wörtlich oder sinngemäss genau durch das MATERIAL gedeckt ist. Was nicht gedeckt ist, lässt du weg oder sagst: „Das steht nicht in deinem Material.“ Lieber eine kurze, sichere Antwort als eine lange, unsichere.
16. Wenn du eine Antwort der Person beurteilst: Zitiere zuerst die passende Originalstelle wörtlich mit Stellenangabe, vergleiche die Antwort Punkt für Punkt mehrfach mit diesem Originaltext und sag erst danach klar „richtig“ oder „nicht richtig“. Bist du unsicher, sag das ehrlich.
17. Wenn unten KORREKTUREN DER LERNENDEN PERSON stehen, haben sie Vorrang vor deinen früheren Aussagen, sofern sie durch das Material gedeckt sind. Widerspricht eine Korrektur dem Material, sag das freundlich und zeig die Originalstelle.
18. Wenn die Person dich korrigiert, nimm es dankbar an, prüfe es am Material und sag klar, ob die Korrektur stimmt. Wiederhole einen Fehler, der korrigiert wurde, nie wieder.`;
const wishText=p=>{const w=(p&&p.wishes||'').trim();return w?'\n\nWÜNSCHE DER LERNENDEN PERSON FÜR DIE KARTEIKARTEN (hohe Priorität: Schwerpunkte, Themen, Anregungen, Bedenken – beachte sie, aber alles weiterhin NUR aus dem Material, nichts erfinden):\n'+w.slice(0,1500):''};
const corrText=p=>{const c=(p&&p.corrections||[]).slice(-20);return c.length?'\n\nKORREKTUREN DER LERNENDEN PERSON (haben Vorrang, sofern durch das Material gedeckt):\n'+c.map(x=>'- '+x.text+(x.about?' (bezieht sich auf: „'+x.about.slice(0,160)+'“)':'')).join('\n'):''};
/* Prüf-Durchgang: ein zweiter KI-Aufruf prüft jede Aussage am Material (spart Kontingent: 1 statt 5 Aufrufe) */
function verifyPrompt({draft,question,lastBot,mat,corr}){return `Du bist eine strenge Prüferin. Prüfe den ENTWURF einer Lehrerin Satz für Satz gegen das MATERIAL. Prüfe jede fachliche Aussage mehrfach: Steht sie wirklich wörtlich oder sinngemäss genau so im MATERIAL?
- Nicht gedeckte Aussagen entfernst du. Falsche Aussagen ersetzt du durch das, was im Material steht, mit Stellenangabe in Klammern.
- Falsche oder fehlende Stellenangaben korrigierst du.
- Beurteilt der Entwurf eine Antwort der lernenden Person („richtig“ / „nicht richtig“), vergleichst du die Antwort selbst mit der wörtlich zitierten Originalstelle und korrigierst das Urteil, falls nötig. Die Originalstelle muss wörtlich zitiert sein.
- Bleibt keine gedeckte fachliche Aussage übrig, schreib freundlich: „Das steht nicht in deinem Material.“ und schlag vor, was man im Material anschauen könnte.
- Lob, Ermutigung, Emojis, Rückfragen, Ton und Länge bleiben, wie sie sind. Deutsch, Schweizer Rechtschreibung („ss“), kein Markdown.
- Korrekturen der lernenden Person haben Vorrang, sofern sie durch das Material gedeckt sind.
Gib JSON zurück: {"geaendert":true oder false,"antwort":"die geprüfte, endgültige Antwort"}${corr}
${lastBot?'\nLETZTE NACHRICHT DER LEHRERIN:\n'+lastBot+'\n':''}
NACHRICHT DER PERSON:\n${question}

MATERIAL:\n${mat}

ENTWURF:\n${draft}`}
function parseVerify(raw,draft){try{let o=JSON.parse(String(raw).replace(/^```(json)?|```$/g,''));if(Array.isArray(o))o=o[0];const a=o&&typeof o.antwort==='string'?o.antwort.trim():'';return a||draft}catch{return draft}}
async function verifyAnswer(args){try{return parseVerify(await gemini({contents:[{role:'user',parts:[{text:verifyPrompt(args)}]}],json:true,temp:0,maxTokens:1500}),args.draft)}catch(e){console.warn('Prüfung',e);return args.draft}}
const FRUST=/frustr|verstehe? (das |es )?(nicht|nix)|kapier|schaff (es|das) nicht|zu schwer|keine lust|aufgeben|bin (zu )?(dumm|blöd|müde)|hoffnungslos|nerv/i;

/* ---------- Stimme ---------- */
let voices=[];
function loadVoices(){voices=(window.speechSynthesis?.getVoices()||[]).filter(v=>/^de/i.test(v.lang));const sel=$('#k-voicesel');if(!sel)return;
  sel.innerHTML=voices.length?voices.map(v=>`<option value="${esc(v.name)}">${esc(v.name)} (${v.lang})</option>`).join(''):'<option value="">Keine deutsche Stimme gefunden</option>';
  const c=pickVoice();if(c)sel.value=c.name}
function pickVoice(){const saved=LS.get('voice','');let v=voices.find(v=>v.name===saved);if(v)return v;
  const fem=/anna|petra|helena|marlene|vicki|katja|hedda|yannick|sarah|female|frau/i;
  return voices.find(v=>/de-CH/i.test(v.lang)&&fem.test(v.name))||voices.find(v=>/anna/i.test(v.name))||voices.find(v=>fem.test(v.name)&&!/yannick/i.test(v.name))||voices.find(v=>/de-DE/i.test(v.lang))||voices[0]}
if('speechSynthesis' in window){loadVoices();try{speechSynthesis.addEventListener('voiceschanged',loadVoices)}catch{speechSynthesis.onvoiceschanged=loadVoices}}
const speakOn=()=>LS.get('speak',false);
/* iOS: Sprache muss einmal per Antippen „freigeschaltet“ werden; cancel() direkt vor speak() verschluckt die Ausgabe;
   lange Texte brechen ab -> in Sätze teilen; nach Pause hängt die Ausgabe -> resume()-Anstoss. */
const SS=('speechSynthesis' in window)?window.speechSynthesis:null;
let ttsUnlocked=false,ttsGen=0,ttsKeep=null;
function unlockTTS(){if(ttsUnlocked||!SS)return;ttsUnlocked=true;try{const u=new SpeechSynthesisUtterance(' ');u.volume=0;u.lang='de-DE';SS.speak(u);SS.resume()}catch{}}
['touchend','click','keydown'].forEach(ev=>document.addEventListener(ev,unlockTTS,{capture:true,passive:true}));
function sentences(t){const out=[];for(const s of (t.match(/[^.!?;:\n]+[.!?;:]*|\n/g)||[t])){const x=s.trim();if(!x)continue;
  if(x.length<=220){out.push(x);continue}let buf='';for(const w of x.split(/\s+/)){if((buf+' '+w).length>200&&buf){out.push(buf);buf=''}buf=(buf?buf+' ':'')+w}if(buf)out.push(buf)}return out}
function speak(t,force,onDone){if((!speakOn()&&!force)||!SS||!t){onDone&&onDone();return}
  const clean=String(t).replace(/\(([^)]*Seite[^)]*)\)/g,'').replace(/[*_#]/g,'');const parts=sentences(clean);if(!parts.length){onDone&&onDone();return}
  const gen=++ttsGen;const busy=SS.speaking||SS.pending;try{SS.cancel()}catch{}
  setTimeout(()=>{if(gen!==ttsGen)return;if(!voices.length)loadVoices();const v=pickVoice();
    parts.forEach((p,i)=>{const u=new SpeechSynthesisUtterance(p);if(v){u.voice=v;u.lang=v.lang}else u.lang='de-DE';u.rate=.98;u.pitch=1.05;u.volume=1;
      u.onerror=e=>{if(e.error!=='interrupted'&&e.error!=='canceled')console.warn('TTS',e.error);if(i===parts.length-1&&gen===ttsGen)onDone&&onDone()};if(i===parts.length-1)u.onend=()=>{if(gen===ttsGen)onDone&&onDone()};SS.speak(u)});
    try{SS.resume()}catch{}
    clearInterval(ttsKeep);ttsKeep=setInterval(()=>{if(gen!==ttsGen||!SS.speaking&&!SS.pending){clearInterval(ttsKeep);return}if(SS.paused)try{SS.resume()}catch{}},2000)
  },busy?250:60)}
function stopSpeak(){ttsGen++;clearInterval(ttsKeep);try{SS&&SS.cancel()}catch{}}
function voiceBtn(){$('#b-voice').textContent=speakOn()?'🔊 Stimme an':'🔇 Stimme aus'}

/* ---------- Home ---------- */
function learnDays(){return LS.get('days',[])}
function weekCount(){const d=learnDays();const cut=Date.now()-7*DAY;return d.filter(x=>new Date(x).getTime()>cut).length}
async function renderHome(){await syncKey();
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
    return `<div class="item" data-open="${p.id}"><span class="name">${p.type==='book'?'📖 ':''}${esc(p.name)}</span>${d?`<span class="badge">${d} fällig</span>`:n?`<span class="small muted">${n} neu</span>`:''}<span class="muted">›</span></div>`}).join(''):'<p class="muted small">Noch kein Projekt. Leg eins an, z. B. pro Buch oder Kapitel.</p>'}
$('#projlist').addEventListener('click',async e=>{const it=e.target.closest('[data-open]');if(!it)return;cur=(bookObj&&bookObj.id===it.dataset.open)?bookObj:migrate((await all('projects')).find(p=>p.id===it.dataset.open));show('project');renderProject()});
$('#b-addproj').onclick=async()=>{const n=$('#newproj').value.trim();if(!n)return $('#newproj').focus();const p={id:uid(),name:n,created:Date.now()};await put('projects',p);$('#newproj').value='';cur=p;show('project');renderProject()};
$('#newproj').addEventListener('keydown',e=>{if(e.key==='Enter')$('#b-addproj').click()});
$('#b-settings').onclick=()=>{show('settings');renderSettings()};$('#go-settings').onclick=e=>{e.preventDefault();$('#b-settings').click()};

/* ---------- Projekt ---------- */
async function renderProject(){if(!cur)return;$('#p-title').textContent=cur.name;
  const [docs,chunks,cards]=await Promise.all([byP('docs',cur.id),byP('chunks',cur.id),byP('cards',cur.id)]);const now=Date.now();
  $('#doclist').innerHTML=docs.length?docs.map(d=>`<div class="item"><span class="name">📄 ${esc(d.name)}</span><span class="small muted">${d.pages} ${d.label==='Abschnitt'?'Abschn.':'S.'}</span><button class="ghost small" data-deldoc="${d.id}">✕</button></div>`).join(''):'<p class="muted small">Noch kein Material. Lade ein PDF hoch oder füge Text ein.</p>';
  $('#p-stats').textContent=chunks.length?`${chunks.length} Textabschnitte bereit für Fragen.`:'';
  const due=cards.filter(c=>c.seen&&c.due<=now).length,nw=cards.filter(c=>!c.seen).length;
  $('#p-due').textContent=due+nw;renderBook();if(document.activeElement!==$('#p-wish'))$('#p-wish').value=cur.wishes||'';$('#p-cards').textContent=cards.length?`${cards.length} Karten · ${due} fällig · ${nw} neu`:'Noch keine Karten. Die Lehrerin erstellt sie aus deinem Material.'}
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
async function generateCards(n=5,focus=false){const chunks=await byP('chunks',cur.id);if(!chunks.length){toast('Lade zuerst Material hoch.');return 0}
  const used=new Set(LS.get('used.'+cur.id,[]));let pool=chunks.filter(c=>!used.has(c.id));if(pool.length<3){pool=chunks;used.clear()}
  const start=Math.floor(Math.random()*Math.max(1,pool.length-3));let pick=pool.slice(start,start+3);
  if(focus&&(cur.wishes||'').trim()){const hit=bm25(chunks,cur.wishes,3);if(hit.length)pick=hit}
  const mat=pick.map(c=>`[${ref(c)}]\n${c.text}`).join('\n\n');
  const prompt=`Erstelle höchstens ${n} kurze Lernkarten auf Deutsch (Schweizer Rechtschreibung) NUR aus diesem Material. Jede Karte prüft genau einen wichtigen Fakt.
${CARD_RULES}
Zu jeder Frage gibt es genau 2 falsche, aber plausible Antworten (aus demselben Themengebiet des Materials, ähnlich lang wie die richtige, eindeutig falsch).
Gib JSON zurück: [{"typ":"Wissen|Verstehen|Unterscheiden|Anwenden|Fehler erkennen","fakt":"der Fakt als 1-2 klare Sätze zum Einprägen","frage":"eine kurze Frage dazu","antwort":"kurze richtige Antwort","falsch":["falsche Antwort 1","falsche Antwort 2"],"erklaerung":"1 kurzer Satz, warum die richtige Antwort stimmt","stelle":"die Stellenangabe genau wie in eckigen Klammern"}]${wishText(cur)}${corrText(cur)}
MATERIAL:\n${mat}`;
  const raw=await gemini({contents:[{role:'user',parts:[{text:prompt}]}],json:true,temp:.4});
  let arr;try{arr=JSON.parse(raw.replace(/^```(json)?|```$/g,''))}catch{throw new Error('Antwort war kein gültiges JSON')}
  if(!Array.isArray(arr))arr=arr.karten||arr.cards||[];
  const cards=arr.filter(x=>x.frage&&x.antwort).slice(0,n).map(x=>({id:uid(),projectId:cur.id,q:x.frage,a:x.antwort,fact:x.fakt||x.antwort,dis:Array.isArray(x.falsch||x.distractors)?(x.falsch||x.distractors).filter(Boolean).slice(0,2):undefined,expl:x.erklaerung||x.explanation||'',type:x.typ||'',src:x.stelle||ref(pick[0]),level:0,due:0,seen:false,created:Date.now()}));
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
  else msgs.slice(-30).forEach(m=>addMsg(m.role,m.text,false,true));
  const any=!!SRC||canRec();$('#b-mic').classList.toggle('hidden',!any);$('#b-talk').classList.toggle('hidden',!any);talkMode=false;talkBtn();
  $('#c-hint').textContent=any?'':'Tipp: Zum Sprechen das 🎤 auf der iPhone-Tastatur antippen.';
  setTimeout(()=>window.scrollTo(0,document.body.scrollHeight),50)}
function addMsg(role,text,save=true,fix=save){const d=document.createElement('div');d.className='msg '+role;d.innerHTML=(role==='bot'?'<div class="who">Lehrerin</div>':'')+esc(text);
  if(role==='bot'&&fix){const b=document.createElement('button');b.className='ghost small fixbtn';b.textContent='✏️ Korrigieren';b.onclick=()=>fixChat(text);d.append(b)}$('#chatlog').append(d);
  window.scrollTo(0,document.body.scrollHeight);if(save){const m={id:uid(),projectId:cur.id,role,text,ts:Date.now()};put('messages',m);history.push(m);history=history.slice(-12)}return d}
async function send(){const t=$('#c-in').value.trim();if(!t)return;$('#c-in').value='';addMsg('user',t);
  const typing=addMsg('bot','schreibt …',false);typing.classList.add('typing');$('#b-send').disabled=true;
  try{const chunks=await byP('chunks',cur.id);const ctxQ=t+' '+(history.filter(m=>m.role==='user').slice(-2,-1)[0]?.text||'');
    const top=bm25(chunks,ctxQ,5);
    const mat=top.length?top.map(c=>`[${ref(c)}]\n${c.text}`).join('\n\n'):(chunks.length?'(Zu dieser Frage wurde im Material nichts Passendes gefunden.)':'(Es wurde noch kein Material hochgeladen.)');
    let sys=PERSONA+`\n\nPROJEKT: ${cur.name}\nMATERIAL (Auszüge, mit Stellenangabe in eckigen Klammern):\n${mat}`+corrText(cur);
    if(FRUST.test(t))sys+='\n\nHINWEIS: Die Person wirkt gerade frustriert. Sei besonders verständnisvoll und mach den nächsten Schritt sehr klein.';
    const contents=history.slice(0,-1).slice(-8).map(m=>({role:m.role==='user'?'user':'model',parts:[{text:m.text}]}));contents.push({role:'user',parts:[{text:t}]});
    let ans=await gemini({system:sys,contents});
    if(top.length){typing.lastChild.textContent='prüft die Antwort am Material …';const lastBot=[...history].reverse().find(m=>m.role==='bot')?.text||'';
      ans=await verifyAnswer({draft:ans,question:t,lastBot,mat,corr:corrText(cur)})}
    typing.remove();addMsg('bot',ans);if(talkMode)speak(ans,true,()=>{if(talkMode&&!$('#v-chat').classList.contains('hidden'))setTimeout(startMic,350)});else speak(ans)}
  catch(e){typing.remove();addMsg('bot',errText(e),false)}
  $('#b-send').disabled=false}
$('#b-send').onclick=send;
$('#c-in').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!/iPhone|iPad|Android/.test(navigator.userAgent)){e.preventDefault();send()}});
$('#b-voice').onclick=()=>{LS.set('speak',!speakOn());voiceBtn();if(!speakOn())stopSpeak();else speak('Gerne lese ich dir meine Antworten vor.')};
$('#b-clear').onclick=async()=>{if(!confirm('Gespräch neu beginnen?'))return;await delByP('messages',cur.id);openChat()};
/* ---------- Spracheingabe ----------
   iOS: webkitSpeechRecognition fehlt im Home-Bildschirm-Modus/In-App-Browser oder bricht ab.
   Darum dort: Aufnahme (getUserMedia + MediaRecorder, iOS = audio/mp4) -> Gemini schreibt es auf Deutsch ab. */
const IOS=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const SRC=window.SpeechRecognition||window.webkitSpeechRecognition;
const canRec=()=>!!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia&&window.MediaRecorder);
let useSR=!!SRC&&!IOS&&!window.__forceRecorder;
let rec=null,mr=null,talkMode=false;
function micState(t){$('#c-hint').textContent=t||'';const qh=document.querySelector('#q-hear');if(qh)qh.textContent=t||'';$('#b-mic').textContent=(rec||mr)?'⏹':'🎤';$('#b-mic').classList.toggle('rec',!!(rec||mr))}
function micErr(e){const n=e&&(e.name||e.error||e.message)||'';
  if(/NotAllowed|not-allowed|Permission|service-not-allowed/i.test(n))return 'Das Mikrofon ist nicht erlaubt. Bitte in den iPhone-Einstellungen › Safari › Mikrofon auf „Erlauben“ stellen und die App neu öffnen.';
  if(/NotFound|audio-capture/i.test(n))return 'Ich finde kein Mikrofon.';
  if(/no-speech/i.test(n))return 'Ich habe nichts gehört. Tipp nochmals auf 🎤 und sprich.';
  return 'Spracheingabe ging nicht ('+n+'). Du kannst auch tippen.'}
function startMic(){stopSpeak();if(rec||mr)return;
  if(useSR)return startSR();if(canRec())return startRecorder();
  if(SRC)return startSR();micState('Spracheingabe wird hier nicht unterstützt – tippe auf das 🎤 der iPhone-Tastatur.')}
function stopMic(){if(rec){rec.stop()}if(mr&&mr.state==='recording')mr.stop()}
$('#b-mic').onclick=()=>{if(rec||mr){talkMode=false;talkBtn();stopMic()}else startMic()};
function startSR(){rec=new SRC();rec.lang='de-CH';rec.interimResults=true;rec.continuous=false;const base=$('#c-in').value;let got=false,failed=false;
  rec.onresult=e=>{got=true;$('#c-in').value=(base+' '+[...e.results].map(r=>r[0].transcript).join('')).trim()};
  rec.onerror=e=>{failed=true;if(e.error==='language-not-supported'){rec.lang='de-DE'}
    if(/not-allowed|service-not-allowed|network|audio-capture/.test(e.error)&&canRec()){useSR=false}else micState(micErr(e))};
  rec.onend=()=>{rec=null;micState('');if(failed&&!useSR&&canRec()){startRecorder();return}if(got&&$('#c-in').value.trim())send();else if(talkMode&&!failed)setTimeout(startMic,300)};
  try{rec.start();micState('Ich höre zu …')}catch(e){rec=null;useSR=false;if(canRec())startRecorder();else micState(micErr(e))}}
async function startRecorder(onText,maxMs=60000){let stream;
  try{stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}})}catch(e){talkMode=false;talkBtn();micState(micErr(e));if(onText)onText(null,micErr(e));return}
  const type=['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/aac'].find(t=>MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported(t))||'';
  try{mr=type?new MediaRecorder(stream,{mimeType:type}):new MediaRecorder(stream)}catch(e){stream.getTracks().forEach(t=>t.stop());micState(micErr(e));return}
  const parts=[];let heard=false,quietSince=0,ac=null,iv=null;const t0=Date.now();
  mr.ondataavailable=e=>{if(e.data&&e.data.size)parts.push(e.data)};
  mr.onstop=async()=>{clearInterval(iv);try{ac&&ac.close()}catch{}stream.getTracks().forEach(t=>t.stop());const mime=(mr.mimeType||type||'audio/mp4').split(';')[0];mr=null;
    const blob=new Blob(parts,{type:mime});if(blob.size<800){micState(talkMode?'':'Ich habe nichts gehört.');return}
    micState('Wird erkannt …');
    try{const txt=await transcribe(blob,mime);micState('');if(onText){onText(txt);return}if(!txt){micState('Ich habe dich nicht verstanden. Nochmals?');if(talkMode)setTimeout(startMic,800);return}
      $('#c-in').value=(($('#c-in').value||'')+' '+txt).trim();send()}
    catch(e){talkMode=false;talkBtn();const m=e.message==='NOKEY'||e.status?errText(e):'Erkennen ging nicht: '+e.message;micState(m);if(onText)onText(null,m)}};
  if(maxMs<60000)setTimeout(()=>{if(mr&&mr.state==='recording')stopMic()},maxMs+300);mr.start(250);micState('Ich höre zu … (zum Beenden 🎤 antippen)');
  // Stille-Erkennung: nach dem Sprechen 1,6 s Ruhe -> automatisch fertig
  try{const AC=window.AudioContext||window.webkitAudioContext;ac=new AC();const src=ac.createMediaStreamSource(stream);const an=ac.createAnalyser();an.fftSize=1024;src.connect(an);const buf=new Uint8Array(an.fftSize);
    iv=setInterval(()=>{an.getByteTimeDomainData(buf);let m=0;for(const x of buf)m=Math.max(m,Math.abs(x-128));const now=Date.now();
      if(m>18){heard=true;quietSince=0}else if(heard){quietSince=quietSince||now;if(now-quietSince>1600)stopMic()}
      if(!heard&&now-t0>Math.min(12000,maxMs))stopMic();if(now-t0>maxMs)stopMic()},120)}catch{}}
async function transcribe(blob,mime){const b64=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]);r.onerror=()=>rej(r.error);r.readAsDataURL(blob)});
  const t=await gemini({contents:[{role:'user',parts:[{inlineData:{mimeType:mime,data:b64}},{text:'Schreib genau auf, was in dieser Aufnahme auf Deutsch (evtl. Schweizerdeutsch) gesagt wird, in Hochdeutsch mit Schweizer Rechtschreibung. Gib NUR den gesprochenen Text zurück, ohne Anführungszeichen oder Kommentar. Wenn nichts Verständliches gesagt wird, gib ein leeres Ergebnis „-“ zurück.'}]}],temp:0,maxTokens:400});
  const x=t.trim().replace(/^["„“]|["“”]$/g,'');return x==='-'?'':x}
// Gesprächsmodus: zuhören -> Antwort vorlesen -> wieder zuhören
function talkBtn(){const b=$('#b-talk');if(b)b.textContent=talkMode?'🔁 Gespräch an':'🔁 Gespräch';b&&b.classList.toggle('primary',talkMode)}
$('#b-talk').onclick=()=>{talkMode=!talkMode;talkBtn();if(talkMode){toast('Gesprächsmodus: Sprich einfach, ich antworte und höre dann wieder zu.',3500);startMic()}else{stopMic();stopSpeak();micState('')}};
/* ---------- Heute lernen (Spaced Repetition, fehlerfreies Lernen) ---------- */
let S=null;
$('#b-learn').onclick=()=>startSession();
async function startSession(){const goal=+LS.get('goal',10);let cards=await byP('cards',cur.id);const now=Date.now();
  if(!cards.some(c=>!c.seen)&&!cards.some(c=>c.seen&&c.due<=now)){
    if(!(await byP('chunks',cur.id)).length){toast('Lade zuerst Material hoch. 📄');return}
    toast('Die Lehrerin bereitet neue Fragen vor …',3000);
    try{await generateCards(5)}catch(e){quizError(errText(e));return}cards=await byP('cards',cur.id)}
  const due=cards.filter(c=>c.seen&&c.due<=now).sort((a,b)=>a.due-b.due);
  const nw=cards.filter(c=>!c.seen).sort((a,b)=>a.created-b.created);
  const queue=[...due.slice(0,goal),...nw.slice(0,Math.max(0,Math.min(5,goal-due.length)))];
  if(!queue.length){toast('Heute ist alles erledigt. Super! 🌟');return}
  S={queue,i:0,ok:0,start:Date.now(),timer:setInterval(tick,1000)};show('quiz');qVoiceBtn();step()}
function quizError(m){show('quiz');$('#q-box').innerHTML=`<h3>Das hat nicht geklappt</h3><p class="fb no">${esc(m)}</p><div class="row"><button class="primary" id="q-tosettings">⚙︎ Einstellungen</button><button id="q-close">Zurück</button></div>`;
  speak(m,true);$('#q-tosettings').onclick=()=>{endSession();stack=['home'];show('settings');renderSettings()};$('#q-close').onclick=history_back}
function tick(){if(!S)return;const m=Math.floor((Date.now()-S.start)/60000);$('#q-timer').textContent=`${m} Min.`;
  if(m>=12&&!S.warned){S.warned=true;toast('Du lernst schon 12 Minuten – toll! Eine Pause ist jetzt völlig okay. ☕',4500)}}
function endSession(){delete $('#q-box').dataset.done;if(S){clearInterval(S.timer);S=null}stopSpeak();try{stopMic()}catch{}}
function step(){const box=$('#q-box');$('#q-bar').style.width=(S.i/S.queue.length*100)+'%';
  if(S.i>=S.queue.length){const n=S.queue.length;
    box.innerHTML=`<h2>Geschafft! 🎉</h2><p>Du hast ${n} ${n===1?'Karte':'Karten'} geübt und ${S.ok} davon gewusst. Jede Wiederholung stärkt dein Gedächtnis – darauf kannst du stolz sein.</p><p class="muted small">Morgen geht es mit ein paar Minuten weiter. Ganz entspannt.</p><button class="primary big" id="q-done">Fertig</button>`;
    speak(`Geschafft! Du hast ${n} Karten geübt. Darauf kannst du stolz sein.`);$('#q-done').onclick=history_back;return}
  const c=S.queue[S.i];
  if(!c.seen&&!c._factShown){box.innerHTML=`<p class="small muted">Neu · Zuerst einprägen</p><p class="fact">${esc(c.fact)}</p><p class="src">${esc(c.src)}</p><button class="primary big" id="q-next">Verstanden – frag mich</button>`;
    const goNext=()=>{if(S&&S.queue[S.i]===c&&!c._factShown){c._factShown=true;step()}};speak(c.fact,qVoice(),qVoice()?()=>setTimeout(goNext,700):null);$('#q-next').onclick=goNext;return}
  if(!(c.dis&&c.dis.length>=2)&&key()&&!c._noMc){box.innerHTML=`<p class="small muted">Karte ${S.i+1} von ${S.queue.length}</p><p class="quizq">${esc(c.q)}</p><p class="muted">Die Lehrerin bereitet drei Antworten vor …</p>`;
    ensureDistractors(c).then(()=>{if(S&&S.err){const m=S.err;endSession();quizError(m);return}if(S&&S.queue[S.i]===c)step()});return}
  if(c.dis&&c.dis.length>=2)return mc(c,box);
  box.innerHTML=`<p class="small muted">Karte ${S.i+1} von ${S.queue.length}</p><p class="quizq">${esc(c.q)}</p><p class="small muted">Überleg kurz in Ruhe – oder sag die Antwort laut.</p><button class="primary big" id="q-show">Antwort zeigen</button>`;
  speak(c.q);$('#q-show').onclick=()=>{
    box.innerHTML=`<p class="small muted">Karte ${S.i+1} von ${S.queue.length}</p><p class="quizq">${esc(c.q)}</p><p class="fact">${esc(c.a)}</p><p class="src">${esc(c.src)}</p><button class="ghost small fixbtn" id="q-fix">✏️ Korrigieren</button><div class="row"><button id="q-no">Noch nicht sicher</button><button class="primary" id="q-yes">Gewusst ✓</button></div>`;
    $('#q-fix').onclick=()=>fixCard(c,()=>{box.querySelector('.quizq').textContent=c.q;box.querySelector('.fact').textContent=c.a});$('#q-yes').onclick=()=>grade(c,true);$('#q-no').onclick=()=>grade(c,false)}}
async function ensureDistractors(c){try{
  const prompt=`Hier ist eine Lernkarte. Erfinde genau 2 falsche, aber plausible Antworten aus demselben Themengebiet (ähnlich lang wie die richtige, eindeutig falsch) und 1 kurzen Satz Erklärung, warum die richtige stimmt. Deutsch, Schweizer Rechtschreibung.
FRAGE: ${c.q}\nRICHTIGE ANTWORT: ${c.a}\nFAKT: ${c.fact}
Gib JSON zurück: {"falsch":["...","..."],"erklaerung":"..."}`;
  const raw=await gemini({contents:[{role:'user',parts:[{text:prompt}]}],json:true,temp:.5});
  let o=JSON.parse(raw.replace(/^```(json)?|```$/g,''));if(Array.isArray(o))o=o[0]||{};
  const d=(o.falsch||o.distractors||[]).filter(x=>x&&x.trim()&&x.trim()!==c.a.trim()).slice(0,2);
  if(d.length<2)throw new Error('zu wenige');c.dis=d;if(!c.expl)c.expl=o.erklaerung||o.explanation||'';
  const st={...c};delete st._factShown;delete st._opts;await put('cards',st)}catch(e){console.warn(e);c._noMc=true;if(e.message==='NOKEY'||e.status===400||e.status===401||e.status===403||e.status===404){S&&(S.err=errText(e))}}}
const ABC=['A','B','C'];
const qVoice=()=>LS.get('quizVoice',false);
function qVoiceBtn(){const b=$('#q-voicemode');if(b){b.textContent=qVoice()?'🎙 Mit Stimme: an':'🎙 Mit Stimme';b.classList.toggle('primary',qVoice())}}
function norm(t){return (t||'').toLowerCase().normalize('NFC').replace(/[^a-zäöüß0-9 ]/g,' ').replace(/\s+/g,' ').trim()}
function matchAnswer(txt,o){const t=norm(txt);if(!t)return -1;
  const ord=[/\b(a|ah|erste|ersten|erstes|eins|1)\b/,/\b(b|be|bee|zweite|zweiten|zweites|zwei|2)\b/,/\b(c|ce|zeh|tse|dritte|dritten|drittes|drei|3)\b/];
  if(t.split(' ').length<=4){const hits=ord.map((r,i)=>r.test(t)?i:-1).filter(i=>i>=0);if(hits.length===1)return hits[0]}
  const tk=new Set(tokens(t));let best=-1,bs=0;o.forEach((x,i)=>{const w=tokens(x.t);if(!w.length)return;const sc=w.filter(z=>tk.has(z)).length/w.length;if(sc>bs){bs=sc;best=i}});
  if(bs>=.5)return best;const hits=ord.map((r,i)=>r.test(t)?i:-1).filter(i=>i>=0);return hits.length===1?hits[0]:-1}
function mc(c,box){delete box.dataset.done;if(!c._opts)c._opts=[c.a,...c.dis.slice(0,2)].map(t=>({t,ok:t===c.a})).sort(()=>Math.random()-.5);const o=c._opts;
  const readQ=()=>c.q+'. '+o.map((x,i)=>`${ABC[i]}: ${x.t}.`).join(' ')+(qVoice()?' Welche Antwort ist richtig?':'');let tries=0;
  box.innerHTML=`<p class="small muted">Karte ${S.i+1} von ${S.queue.length}</p><p class="quizq">${esc(c.q)}</p>
  <div class="opts">${o.map((x,i)=>`<button class="opt" data-i="${i}"><span class="abc">${ABC[i]}</span><span>${esc(x.t)}</span></button>`).join('')}</div>
  <p class="small muted" id="q-hear"></p>
  <div id="q-fb"></div><div class="row" style="margin-top:12px"><button id="q-read">🔊 Vorlesen</button><button id="q-mic">🎤 Antworten</button><button id="q-stop">⏹ Stopp</button></div>`;
  let after=readQ();const card=S.queue[S.i];const live=()=>S&&S.queue[S.i]===card&&box.dataset.done!=='1';
  const listen=()=>{if(!live()||!canRec()||S.halt)return;startRecorder((txt,err)=>{if(!live())return;
      if(err){$('#q-hear').textContent=err;return}
      const i=matchAnswer(txt,o);if(i<0){if(tries++>=1){$('#q-hear').textContent='Ich habe dich nicht verstanden. Tippe auf eine Antwort oder auf 🎤.';speak('Ich habe dich leider nicht verstanden. Tippe einfach auf eine Antwort.',true);return}
        $('#q-hear').textContent=`Ich habe „${txt||'…'}“ nicht zuordnen können. Nochmals bitte: A, B oder C?`;speak('Das habe ich nicht verstanden. Nochmals bitte: A, B oder C?',true,()=>setTimeout(listen,300));return}
      $('#q-hear').textContent=`Du hast gesagt: „${txt}“`;choose(i)},6000)};
  speak(after,qVoice(),qVoice()?()=>setTimeout(listen,300):null);
  $('#q-read').onclick=()=>speak(after,true);$('#q-stop').onclick=()=>{S.halt=true;stopSpeak();stopMic();$('#q-hear').textContent='Gestoppt. Tippe auf eine Antwort, auf 🎤 oder auf „Mit Stimme“.'};$('#q-mic').onclick=()=>{stopSpeak();if(mr)stopMic();else{S.halt=false;tries=0;listen()}};
  if(!canRec())$('#q-mic').classList.add('hidden');
  const choose=idx=>{if(box.dataset.done==='1')return;box.dataset.done='1';try{stopMic()}catch{}
    const ch=o[idx],b=box.querySelectorAll('.opt')[idx];
    box.querySelectorAll('.opt').forEach((bb,i)=>{bb.disabled=true;if(o[i].ok){bb.classList.add('right');bb.insertAdjacentHTML('beforeend','<span class="lbl">✓ Richtige Antwort</span>')}});
    if(!ch.ok){b.classList.add('wrong');b.insertAdjacentHTML('beforeend','<span class="lbl">Deine Wahl</span>')}
    const warm=ch.ok?PRAISE[Math.floor(Math.random()*PRAISE.length)]:COMFORT[Math.floor(Math.random()*COMFORT.length)];const ri=o.findIndex(x=>x.ok);
    $('#q-fb').innerHTML=`<p class="fb ${ch.ok?'ok':'no'}">${ch.ok?'Ja, richtig! ':'Nein, leider falsch. '}${esc(warm)}</p><p class="fact">${esc(c.expl||c.fact)}</p><p class="src">📖 ${esc(c.src)}</p><button class="ghost small fixbtn" id="q-fix">✏️ Korrigieren</button><button class="primary big" id="q-weiter">Weiter →</button>`;
    $('#q-fix').onclick=()=>{stopSpeak();S.halt=true;fixCard(c,()=>{$('#q-fb .fact').textContent=c.expl||c.fact;$('#q-fb .src').textContent='📖 '+c.src})};
    after=ch.ok?`Ja, richtig! ${c.expl||c.fact}`:`Nein, leider falsch, richtig ist ${ABC[ri]}: ${c.a}. ${c.expl||c.fact}`;
    let went=false;const go=()=>{if(went)return;went=true;stopSpeak();delete box.dataset.done;grade(c,ch.ok,true)};
    speak(after,true,qVoice()?()=>setTimeout(()=>{if(S&&!S.halt&&S.queue[S.i]===card)go()},1200):null);
    $('#q-weiter').onclick=go};
  box.querySelectorAll('.opt').forEach(b=>b.onclick=()=>choose(+b.dataset.i))}
const PRAISE=['Super gemacht!','Toll, weiter so!','Sehr gut!','Du wirst immer sicherer!','Klasse!'];
const COMFORT=['Kein Problem – genau so lernt man. Wir üben das morgen nochmals.','Gut, dass du ehrlich bist. Morgen sitzt es schon besser.','Das ist völlig okay. Schritt für Schritt!'];
async function grade(c,ok,quiet){const now=Date.now(),wasRetry=!!c._retry;
  if(ok){c.level=(c.seen?(c.level||0):0)+1;const iv=c.level<=INTERVALS.length?INTERVALS[c.level-1]:Math.min(365,30*2**(c.level-INTERVALS.length));c.due=now+iv*DAY;if(!c._retry)S.ok++;delete c._retry}
  else{c.level=0;c.due=now;c._retry=true;if(S&&S.queue){const at=Math.min(S.i+3,S.queue.length);S.queue.splice(at,0,c)}}
  c.seen=true;delete c._factShown;delete c._opts;delete c._noMc;c.last=now;await put('cards',c);
  const d=today();if(LS.get('doneDay','')!==d){LS.set('doneDay',d);LS.set('doneCount',0)}if(!wasRetry)LS.set('doneCount',LS.get('doneCount',0)+1);
  const days=learnDays();if(!days.includes(d)){days.push(d);LS.set('days',days)}
  const msg=ok?PRAISE[Math.floor(Math.random()*PRAISE.length)]:COMFORT[Math.floor(Math.random()*COMFORT.length)];if(!quiet)toast(msg,1500);S.i++;step()}
function history_back(){document.querySelector('#v-quiz [data-back]').click()}

$('#q-voicemode').onclick=()=>{LS.set('quizVoice',!qVoice());qVoiceBtn();if(S)S.halt=false;if(S&&S.i<S.queue.length){stopSpeak();try{stopMic()}catch{};delete $('#q-box').dataset.done;step()}};
/* ---------- Einstellungen ---------- */
function renderSettings(){$('#k-key').value=key();$('#k-model').value=model();$('#k-speak').checked=speakOn();$('#k-goal').value=String(LS.get('goal',10));loadVoices();$('#k-status').textContent=''}
$('#b-savekey').onclick=()=>{if($('#k-key').value.trim())saveKey($('#k-key').value.trim());try{$('#nokey').classList.toggle('hidden',!!key())}catch{};LS.set('model',$('#k-model').value.trim()||DEFAULT_MODEL);$('#k-status').textContent='Gespeichert ✓'};
$('#b-testkey').onclick=async()=>{$('#b-savekey').click();$('#k-status').textContent='Teste …';
  try{const t=await gemini({contents:[{role:'user',parts:[{text:'Sag in einem kurzen Satz auf Deutsch Hallo.'}]}]});$('#k-status').textContent='Funktioniert ✓ – '+t}catch(e){$('#k-status').textContent=errText(e)}};
$('#k-speak').onchange=e=>LS.set('speak',e.target.checked);
$('#k-voicesel').onchange=e=>LS.set('voice',e.target.value);
$('#b-voicetest').onclick=()=>{const was=speakOn();LS.set('speak',true);speak('Hallo! Ich bin deine Lehrerin. Schön, dass du heute lernst.');LS.set('speak',was)};
$('#k-goal').onchange=e=>LS.set('goal',+e.target.value);

/* ---------- Buch-Modus ---------- */
const SEG=14000; // Zeichen pro KI-Anfrage (Gratis-Stufe schonen)
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function makeSegments(chunks){chunks=[...chunks].sort((a,b)=>a.order-b.order);const segs=[];let cur_=[],len=0;
  for(const c of chunks){if(len+c.text.length>SEG&&cur_.length){segs.push(cur_);cur_=[];len=0}cur_.push(c.id);len+=c.text.length}if(cur_.length)segs.push(cur_);return segs}
let bookBusy=null,bookObj=null; // laufendes Buch
const JOBS={cards:'Lernkartei',sum:'Zusammenfassung'};
function migrate(p){const b=p&&p.book;if(!b)return p;if(!b.jobs){b.jobs={};if(b.next!==undefined)b.jobs.cards={next:b.next,state:b.state,made:b.made||0,err:b.err||''};delete b.next;delete b.state;delete b.made;delete b.err}b.sums=b.sums||[];return p}
$('#b-newbook').onclick=()=>{$('#bk-title').value='';$('#bk-text').value='';$('#bk-progress').textContent='';show('book')};
$('#bk-upload').onclick=()=>$('#bk-file').click();
$('#bk-camera').onclick=()=>$('#bk-cam').click();
/* Bilder & eingescannte Seiten: Gemini liest den Text */
const blobB64=blob=>new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]);r.onerror=()=>rej(r.error);r.readAsDataURL(blob)});
async function ocrBlob(blob,mime){let tries=0;
  for(;;){try{const t=await gemini({contents:[{role:'user',parts:[{inlineData:{mimeType:mime,data:await blobB64(blob)}},{text:'Schreib den gesamten lesbaren Text auf diesem Bild (Buchseite, Foto oder Screenshot) genau ab, in der ursprünglichen Reihenfolge. Nichts zusammenfassen, nichts erfinden, nichts übersetzen. Gib NUR den Text zurück. Wenn kein Text zu sehen ist, gib „-“ zurück.'}]}],temp:0,maxTokens:4000});
      return t.trim()==='-'?'':t}
    catch(e){if(e.status===429&&tries++<3){await sleep(window.__bookWait??60000);continue}throw e}}}
async function readPdfOcr(file,onp){const pages=await readPdf(file,onp);let pdoc=null;
  for(const pg of pages){if(pg.text.replace(/\s/g,'').length>=30)continue;if(!key())break;
    if(!pdoc)pdoc=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
    onp&&onp(pg.page,pages.length,'Seite ohne Text – die Lehrerin liest das Bild');
    const page=await pdoc.getPage(pg.page);const vp=page.getViewport({scale:1.6});const cv=document.createElement('canvas');cv.width=vp.width;cv.height=vp.height;
    await page.render({canvasContext:cv.getContext('2d'),viewport:vp}).promise;const blob=await new Promise(r=>cv.toBlob(r,'image/jpeg',.82));
    pg.text=await ocrBlob(blob,'image/jpeg');pg.ocr=true;await sleep(window.__bookDelay??4500)}
  return pages}
const isImg=f=>/^image\//i.test(f.type)||/\.(jpe?g|png|heic|heif|webp|gif)$/i.test(f.name);
const isPdf=f=>/pdf$/i.test(f.type)||/\.pdf$/i.test(f.name);
async function filesToDocs(files,prog){const docs=[];const imgs=files.filter(isImg);
  for(const f of files.filter(f=>!isImg(f))){
    if(isPdf(f))docs.push({name:f.name,label:'Seite',pages:await readPdfOcr(f,(i,n,extra)=>prog(`Lese „${f.name}“: Seite ${i} von ${n}${extra?' · '+extra:''}`))});
    else docs.push({name:f.name,label:'Abschnitt',pages:textToPages(await f.text())})}
  if(imgs.length){if(!key())throw new Error('NOKEY');const pages=[];
    for(let i=0;i<imgs.length;i++){prog(`Die Lehrerin liest Bild ${i+1} von ${imgs.length} …`);const f=imgs[i];
      const mime=f.type||(/\.png$/i.test(f.name)?'image/png':/\.hei[cf]$/i.test(f.name)?'image/heic':'image/jpeg');
      pages.push({page:i+1,text:await ocrBlob(f,mime)});if(i<imgs.length-1)await sleep(window.__bookDelay??4500)}
    docs.push({name:imgs.length===1?imgs[0].name:`${imgs.length} Bilder`,label:'Bild',pages})}
  return docs}
async function createBook(name,docs){
  const p={id:uid(),name,created:Date.now(),type:'book'};let order=0;const allChunks=[],docRecs=[];let pages=0;
  for(const d of docs){const id=uid();const ch=chunkPages(d.pages,id,d.name,p.id,d.label).map(c=>({...c,order:order++}));if(!ch.length)continue;
    allChunks.push(...ch);pages+=d.pages.length;docRecs.push({id,projectId:p.id,name:d.name,pages:d.pages.length,label:d.label,added:Date.now()})}
  if(!allChunks.length){toast('Darin wurde kein Text gefunden.',4000);return}
  p.book={segs:makeSegments(allChunks),pages,label:docs[0].label,jobs:{},sums:[]};
  await put('projects',p);for(const d of docRecs)await put('docs',d);await putMany('chunks',allChunks);
  cur=p;stack=['home','project'];show('project',false);renderProject()}
async function handleBookFiles(files){if(!files.length)return;const title=$('#bk-title').value.trim()||files[0].name.replace(/\.(pdf|txt|jpe?g|png|heic|heif|webp)$/i,'');
  try{const docs=await filesToDocs(files,t=>$('#bk-progress').textContent=t);await createBook(title,docs)}
  catch(err){console.error(err);const m=err.message==='NOKEY'||err.status?errText(err):'Konnte die Datei nicht lesen ('+err.message+').';$('#bk-progress').textContent=m;toast(m,5000);return}
  $('#bk-progress').textContent=''}
$('#bk-file').onchange=e=>{const f=[...e.target.files];e.target.value='';handleBookFiles(f)};
$('#bk-cam').onchange=e=>{const f=[...e.target.files];e.target.value='';handleBookFiles(f)};
$('#bk-addtext').onclick=async()=>{const t=$('#bk-text').value.trim();if(!t)return $('#bk-text').focus();await createBook($('#bk-title').value.trim()||'Eingefügter Text',[{name:'Eingefügter Text',label:'Abschnitt',pages:textToPages(t)}])};
async function renderBook(){const box=$('#p-book');const b=cur&&cur.book;box.classList.toggle('hidden',!b);if(!b)return;migrate(cur);
  const n=b.segs.length,running=bookBusy===cur.id;const started=Object.keys(b.jobs);
  $('#bk-choice-h').textContent=started.length?'Zusätzlich erstellen:':'Was soll die Lehrerin daraus machen?';
  $('#bk-choice').classList.toggle('hidden',started.length>=2);
  $('#bk-mk-cards').classList.toggle('hidden',!!b.jobs.cards);$('#bk-mk-sum').classList.toggle('hidden',!!b.jobs.sum);
  $('#bk-jobs').innerHTML=started.map(k=>{const j=b.jobs[k],done=Math.min(j.next,n);
    const txt=done>=n?`${JOBS[k]}: fertig ✓ (${k==='cards'?j.made+' Karten':b.sums.filter(Boolean).length+' Teile, '+j.made+' Wiederholungsfragen'})`:
      `${JOBS[k]}: ${running&&j.state==='run'?'die Lehrerin liest gerade':'pausiert bei'} Teil ${done+1} von ${n}${j.err?' · '+j.err:''}`;
    return `<p class="small" style="margin:10px 0 4px">${esc(txt)}</p><div class="bar"><i style="width:${done/n*100}%"></i></div>${done<n?`<button class="small" data-job="${k}" style="margin-top:6px">${j.state==='run'&&running?'⏸ Pause':'▶ Weiter'}</button>`:''}`}).join('');
  $('#bk-cards').classList.toggle('hidden',!b.jobs.cards);$('#bk-sum').classList.toggle('hidden',!b.jobs.sum)}
$('#bk-jobs').addEventListener('click',async e=>{const btn=e.target.closest('[data-job]');if(!btn)return;const j=cur.book.jobs[btn.dataset.job];
  if(j.state==='run'&&bookBusy===cur.id){j.state='pause'}else{j.state='run';j.err=''}await put('projects',cur);renderBook();processBook()});
async function startJob(k){migrate(cur);if(!cur.book.jobs[k])cur.book.jobs[k]={next:0,state:'run',made:0,err:''};await put('projects',cur);renderBook();processBook()}
$('#bk-mk-cards').onclick=()=>startJob('cards');$('#bk-mk-sum').onclick=()=>startJob('sum');
const CARD_RULES=`Regeln für gute Karten (nur aus dem Material, keine Recherche, kein Allgemeinwissen):
- Jede Karte hat genau eine zentrale Frage.
- Kurze, klare, einfache Sätze in leichtem Deutsch.
- Fachbegriffe werden in der Antwort oder im Fakt kurz und einfach erklärt.
- Keine Fangfragen, keine doppelten Verneinungen, keine mehrdeutigen Fragen.
- Die Bedeutung des Materials darf nicht verändert werden. Nichts dazuerfinden.
- Kartentyp passend zum Inhalt wählen und mischen: Wissen (Fakt abrufen), Verstehen (warum/wie), Unterscheiden (Unterschied zwischen zwei Begriffen), Anwenden (kurzer Fall aus dem Material), Fehler erkennen (welche Aussage ist falsch).
- Lieber weniger, aber hochwertige Karten.
- Interne Qualitätskontrolle vor der Ausgabe: Prüfe jede Karte nochmals am Material. Streiche Karten, die unklar, doppelt, zu ähnlich, unwichtig oder nicht genau durch das Material gedeckt sind. Gib nur die geprüften Karten aus.`;
const CARD_JSON='{"typ":"Wissen|Verstehen|Unterscheiden|Anwenden|Fehler erkennen","fakt":"der Punkt in 1-2 klaren Sätzen","frage":"kurze Frage","antwort":"kurze richtige Antwort","falsch":["...","..."],"erklaerung":"1 kurzer Satz","stelle":"Stellenangabe genau wie in eckigen Klammern"}';
const RULES='Regeln: Alles muss AUSSCHLIESSLICH aus diesem Text stammen, nichts erfinden, kein Allgemeinwissen. Deutsch, Schweizer Rechtschreibung („ss“ statt „ß“). Jede Frage prüft genau einen wichtigen Punkt und hat genau 2 falsche, aber plausible Antworten (ähnlich lang, eindeutig falsch).\n'+CARD_RULES;
function toCards(arr,p,chunks){return (arr||[]).filter(x=>x&&x.frage&&x.antwort).slice(0,6).map(x=>({id:uid(),projectId:p.id,q:x.frage,a:x.antwort,fact:x.fakt||x.antwort,dis:Array.isArray(x.falsch)?x.falsch.filter(Boolean).slice(0,2):undefined,expl:x.erklaerung||'',type:x.typ||'',src:x.stelle||(chunks[0]?ref(chunks[0]):p.name),level:0,due:0,seen:false,created:Date.now(),book:true}))}
const parseJ=raw=>{try{return JSON.parse(raw.replace(/^```(json)?|```$/g,''))}catch{throw new Error('Antwort war kein gültiges JSON')}};
async function segChunks(p,seg){return (await byP('chunks',p.id)).filter(c=>seg.includes(c.id)).sort((a,b)=>a.order-b.order)}
async function bookCards(p,seg){const chunks=await segChunks(p,seg);const mat=chunks.map(c=>`[${ref(c)}]\n${c.text}`).join('\n\n');
  const prompt=`Du bist eine Lehrerin. Unten ist ein Teil von „${p.name}“. Zieh NUR die allerwichtigsten Inhalte heraus (Kernaussagen, zentrale Begriffe, wichtige Zusammenhänge – keine Nebensächlichkeiten) und mach daraus höchstens 6 Karteikarten (lieber weniger, aber gute).
${RULES}${wishText(p)}${corrText(p)}
Gib JSON zurück: [${CARD_JSON}]
Wenn der Text nichts Wichtiges enthält (z. B. Inhaltsverzeichnis, Impressum), gib [] zurück.
TEXT:\n${mat}`;
  let arr=parseJ(await gemini({contents:[{role:'user',parts:[{text:prompt}]}],json:true,temp:.3,maxTokens:3000}));
  if(!Array.isArray(arr))arr=arr.karten||arr.cards||[];return {cards:toCards(arr,p,chunks)}}
async function bookSum(p,seg){const chunks=await segChunks(p,seg);const mat=chunks.map(c=>`[${ref(c)}]\n${c.text}`).join('\n\n');
  const prompt=`Du bist eine Lehrerin. Unten ist ein Teil von „${p.name}“. Fasse die allerwichtigsten Punkte dieses Teils kurz, klar und gut vorlesbar zusammen (3 bis 6 Sätze, kein Markdown, keine Aufzählungszeichen) und erstelle 2 Wiederholungsfragen dazu.
${RULES}${wishText(p)}${corrText(p)}
Gib JSON zurück: {"titel":"kurzer Titel dieses Teils (z. B. Kapitelname, wenn erkennbar)","zusammenfassung":"...","fragen":[${CARD_JSON}]}
Wenn der Text nichts Wichtiges enthält (z. B. Inhaltsverzeichnis, Impressum), gib {"titel":"","zusammenfassung":"","fragen":[]} zurück.
TEXT:\n${mat}`;
  let o=parseJ(await gemini({contents:[{role:'user',parts:[{text:prompt}]}],json:true,temp:.3,maxTokens:2500}));if(Array.isArray(o))o=o[0]||{};
  const pg=chunks.map(c=>c.page);const lab=chunks[0]?chunks[0].label||'Seite':'Seite';
  const sum=o.zusammenfassung?{titel:o.titel||'',text:o.zusammenfassung,from:Math.min(...pg),to:Math.max(...pg),label:lab,doc:chunks[0]?.docName||''}:null;
  return {cards:toCards(o.fragen,p,chunks).slice(0,3),sum}}
async function processBook(){if(bookBusy||!cur||!cur.book)return;const p=migrate(cur);bookBusy=p.id;bookObj=p;renderBook();let fails=0;
  const nextJob=()=>['sum','cards'].find(k=>p.book.jobs[k]&&p.book.jobs[k].state==='run'&&p.book.jobs[k].next<p.book.segs.length);
  try{let k;while(k=nextJob()){const j=p.book.jobs[k];
    try{const r=await (k==='sum'?bookSum:bookCards)(p,p.book.segs[j.next]);if(r.cards.length)await putMany('cards',r.cards);
      if(k==='sum')p.book.sums[j.next]=r.sum;
      j.made+=r.cards.length;j.next++;j.err='';fails=0;await put('projects',p);if(cur===p)renderProject();
      if(j.next>=p.book.segs.length&&cur===p)toast(`${JOBS[k]} fertig ✓`,3500);
      if(nextJob())await sleep(window.__bookDelay??4500)}
    catch(e){console.warn(e);
      if(e.message==='NOKEY'||e.status===400||e.status===401||e.status===403||e.status===404||++fails>3){j.state='pause';j.err=errText(e);await put('projects',p);toast(errText(e),5000);fails=0;continue}
      if(e.status===429){j.err='Kontingent erreicht – ich warte kurz und mache dann weiter …';if(cur===p)renderBook();await sleep(window.__bookWait??60000)}
      else await sleep(3000)}}}
  finally{bookBusy=null;bookObj=null;if(cur===p){renderBook();renderProject()}}}
// Zusammenfassung lesen + vorlesen (eigene Pause/Weiter, iOS-fest)
let SUM={parts:[],i:0,playing:false};
$('#bk-sum').onclick=()=>openSum();
function openSum(){const b=migrate(cur).book;const list=b.sums.map((x,i)=>x&&{...x,i}).filter(Boolean);show('sum');$('#sum-title').textContent=cur.name;
  const j=b.jobs.sum,n=b.segs.length;$('#sum-status').textContent=j&&j.next<n?`Noch in Arbeit: Teil ${Math.min(j.next,n)} von ${n} fertig. Weitere Teile erscheinen hier, sobald sie fertig sind.`:'';
  $('#sum-list').innerHTML=list.length?list.map((x,k)=>`<div class="sumpart" data-k="${k}"><h3>${esc(x.titel||'Teil '+(x.i+1))}</h3><p class="src">📖 ${esc(x.doc)}, ${x.label==='Seite'?'Seite':x.label} ${x.from}${x.to!==x.from?'–'+x.to:''}</p><p>${esc(x.text)}</p></div>`).join(''):'<p class="muted">Noch keine Zusammenfassung – die Lehrerin liest noch.</p>';
  SUM.parts=list.flatMap((x,k)=>sentences((x.titel?x.titel+'. ':'')+x.text).map(t=>({t,k})));SUM.i=Math.min(LS.get('sumpos.'+cur.id,0),Math.max(0,SUM.parts.length-1));SUM.playing=false;SUM.started=false;sumBtns()}
function sumBtns(){$('#sum-play').textContent=SUM.playing?'⏸ Pause':(SUM.i>0||SUM.started?'▶ Weiter vorlesen':'▶ Vorlesen');
  document.querySelectorAll('.sumpart').forEach(el=>el.classList.toggle('reading',SUM.playing&&SUM.parts[SUM.i]&&+el.dataset.k===SUM.parts[SUM.i].k))}
function sumNext(){if(!SUM.playing)return;if(SUM.i>=SUM.parts.length){SUM.playing=false;SUM.i=0;LS.set('sumpos.'+cur.id,0);sumBtns();return}
  sumBtns();const me=SUM.i;speak(SUM.parts[me].t,true,()=>{if(!SUM.playing||SUM.i!==me)return;SUM.i++;LS.set('sumpos.'+cur.id,SUM.i);sumNext()})}
$('#sum-play').onclick=()=>{if(!SUM.parts.length)return;if(SUM.playing){SUM.playing=false;stopSpeak();sumBtns()}else{SUM.playing=true;SUM.started=true;sumNext()}};
$('#sum-restart').onclick=()=>{SUM.i=0;LS.set('sumpos.'+cur.id,0);SUM.playing=true;stopSpeak();sumNext()};
$('#sum-repeat').onclick=()=>{SUM.playing=false;stopSpeak();stack.pop();startSession()};
// Karteikarten
let FL={cards:[],i:0,back:false};
$('#bk-cards').onclick=()=>openFlash();
async function openFlash(){const cards=(await byP('cards',cur.id)).sort((a,b)=>a.created-b.created);if(!cards.length){toast('Noch keine Karteikarten – einen Moment, die Lehrerin liest noch.');return}
  FL={cards,i:0,back:false};show('flash');flash()}
function flash(){const c=FL.cards[FL.i];$('#fl-count').textContent=`Karte ${FL.i+1} von ${FL.cards.length}`;const el=$('#fl-card');el.classList.toggle('back',FL.back);
  el.innerHTML=FL.back?`<p class="side">Antwort</p><p class="quizq" style="color:var(--ok)">${esc(c.a)}</p><p class="fact" style="text-align:left">${esc(c.fact)}</p><p class="src">📖 ${esc(c.src)}</p><p class="small muted">Tippen für die Frage</p>`:
    `<p class="side">Frage</p><p class="quizq">${esc(c.q)}</p><p class="small muted">Tippen für die Antwort</p>`;
  $('#fl-fix').onclick=()=>fixCard(c,flash);$('#fl-prev').disabled=FL.i===0;$('#fl-next').disabled=FL.i>=FL.cards.length-1;speak(FL.back?c.a+'. '+c.fact:c.q)}
$('#fl-card').onclick=()=>{FL.back=!FL.back;flash()};
$('#fl-prev').onclick=()=>{if(FL.i>0){FL.i--;FL.back=false;flash()}};
$('#fl-next').onclick=()=>{if(FL.i<FL.cards.length-1){FL.i++;FL.back=false;flash()}};
$('#fl-read').onclick=()=>{const c=FL.cards[FL.i];speak(FL.back?c.a+'. '+c.fact:c.q,true)};
$('#fl-quiz').onclick=()=>{stack.pop();startSession()};
// Fortsetzen nach Neustart: offene Bücher weiterlaufen lassen
async function resumeBooks(){const ps=(await all('projects')).map(migrate);const p=ps.find(p=>p.book&&Object.values(p.book.jobs).some(j=>j.state==='run'&&j.next<p.book.segs.length));
  if(p&&key()){const was=cur;cur=p;processBook();cur=was}}

/* ---------- Korrigieren & Projekte ---------- */
function modal(html){document.querySelectorAll('.modal').forEach(x=>x.remove());const o=document.createElement('div');o.className='modal';o.innerHTML=`<div class="card">${html}</div>`;document.body.append(o);
  o.addEventListener('click',e=>{if(e.target===o||e.target.closest('[data-mclose]')){try{stopMic()}catch{}o.remove()}});return o}
function micInto(o,ta,hint){const b=o.querySelector('[data-mic]');if(!b)return;if(!canRec()&&!SRC){b.classList.add('hidden');return}
  b.onclick=()=>{const h=o.querySelector(hint);if(mr){stopMic();return}stopSpeak();
    if(canRec()){h.textContent='Ich höre zu … (zum Beenden 🎤 antippen)';startRecorder((txt,err)=>{if(err){h.textContent=err;return}h.textContent=txt?'':'Ich habe nichts verstanden.';if(txt){const el=o.querySelector(typeof ta==='function'?ta():ta);el.value=((el.value||'')+' '+txt).trim()}})}
    else{const r=new SRC();r.lang='de-CH';r.onresult=e=>{const el=o.querySelector(typeof ta==='function'?ta():ta);el.value=((el.value||'')+' '+e.results[0][0].transcript).trim()};r.onend=()=>h.textContent='';h.textContent='Ich höre zu …';r.start()}}}
function fixChat(text){const list=(cur.corrections||[]);
  const o=modal(`<h3>✏️ Lehrerin korrigieren</h3><p class="small muted">Die Lehrerin hat gesagt:</p><p class="fact small" style="max-height:140px;overflow:auto">${esc(text)}</p>
  <label class="small muted">Was ist falsch, und was ist richtig? (tippen oder sprechen)</label><textarea id="fx-note" placeholder="z. B. Nicht die Ribosomen, sondern die Mitochondrien sind die Kraftwerke der Zelle (Seite 3)."></textarea>
  <p class="small muted" id="fx-hint"></p><div class="row" style="margin-top:8px"><button data-mic>🎤 Sprechen</button><button class="primary" id="fx-save">Speichern</button></div>
  ${list.length?`<p class="small muted" style="margin-top:14px">Bisherige Korrekturen in diesem Projekt:</p><div class="list">${list.map((x,i)=>`<div class="item small"><span class="name" style="font-weight:400">${esc(x.text)}</span><button class="ghost small" data-delfix="${i}">✕</button></div>`).join('')}</div>`:''}
  <button class="ghost small" data-mclose style="margin-top:8px">Abbrechen</button>`);
  micInto(o,'#fx-note','#fx-hint');setTimeout(()=>o.querySelector('#fx-note').focus(),50);
  o.querySelectorAll('[data-delfix]').forEach(b=>b.onclick=async()=>{cur.corrections.splice(+b.dataset.delfix,1);await put('projects',cur);fixChat(text)});
  o.querySelector('#fx-save').onclick=async()=>{const v=o.querySelector('#fx-note').value.trim();if(!v)return o.querySelector('#fx-note').focus();
    cur.corrections=[...(cur.corrections||[]),{text:v,about:text.slice(0,300),ts:Date.now()}].slice(-30);await put('projects',cur);o.remove();
    toast('Danke! Die Lehrerin beachtet deine Korrektur ab jetzt – sofern sie im Material steht. ✓',3500)}}
function fixCard(c,after){const o=modal(`<h3>✏️ Karte korrigieren</h3>
  <label class="small muted">Frage</label><textarea id="fx-q" style="min-height:70px">${esc(c.q)}</textarea>
  <label class="small muted" style="display:block;margin-top:8px">Antwort</label><textarea id="fx-a" style="min-height:60px">${esc(c.a)}</textarea>
  <label class="small muted" style="display:block;margin-top:8px">Merksatz / Erklärung</label><textarea id="fx-f" style="min-height:70px">${esc(c.expl||c.fact)}</textarea>
  <p class="small muted" id="fx-hint">Tipp: Feld antippen, dann 🎤 Sprechen – der Text wird dort angehängt.</p>
  <div class="row" style="margin-top:8px"><button data-mic>🎤 Sprechen</button><button class="primary" id="fx-save">Speichern</button></div><button class="ghost small" data-mclose style="margin-top:8px">Abbrechen</button>`);
  let last='#fx-a';o.querySelectorAll('textarea').forEach(t=>t.addEventListener('focus',()=>last='#'+t.id));
  micInto(o,()=>last,'#fx-hint');
  o.querySelector('#fx-save').onclick=async()=>{const q=o.querySelector('#fx-q').value.trim(),a=o.querySelector('#fx-a').value.trim(),f=o.querySelector('#fx-f').value.trim();if(!q||!a){toast('Frage und Antwort dürfen nicht leer sein.');return}
    const ansChanged=a!==c.a;c.q=q;c.a=a;if(c.expl)c.expl=f;else c.fact=f;if(c.expl&&!c.fact)c.fact=f;
    if(ansChanged&&c.dis)c.dis=c.dis.filter(x=>x.trim()!==a);c.edited=Date.now();
    const st={...c};for(const k of ['_factShown','_opts','_noMc','_retry'])delete st[k];await put('cards',st);o.remove();toast('Karte gespeichert ✓');after&&after()}}
async function openProjects(){const [ps,cards]=await Promise.all([all('projects'),all('cards')]);const now=Date.now();
  const o=modal(`<div class="top"><h2 class="sp" style="margin:0">🗂 Projekte</h2><button class="ghost small" data-mclose>✕</button></div>
  <div class="list">${ps.length?ps.sort((a,b)=>b.created-a.created).map(p=>{const pc=cards.filter(c=>c.projectId===p.id),d=pc.filter(c=>c.seen&&c.due<=now).length,n=pc.filter(c=>!c.seen).length;
    return `<div class="item" style="flex-wrap:wrap"><span class="name" data-pj="${p.id}" data-act="open" style="cursor:pointer">${p.type==='book'?'📖':'📁'} ${esc(p.name)}<br><span class="small muted" style="font-weight:400">${pc.length} ${pc.length===1?'Karte':'Karten'} · ${d} fällig · ${n} neu</span></span>
    <button class="primary small" data-pj="${p.id}" data-act="learn">📚 Lernen</button>${pc.length?`<button class="small" data-pj="${p.id}" data-act="cards">🃏 Karten</button>`:''}</div>`}).join(''):'<p class="muted small">Noch kein Projekt gespeichert.</p>'}</div>`);
  o.querySelectorAll('[data-pj]').forEach(el=>el.onclick=async()=>{const id=el.dataset.pj,act=el.dataset.act;o.remove();endSession();
    cur=(bookObj&&bookObj.id===id)?bookObj:migrate((await all('projects')).find(p=>p.id===id));stack=['home','project'];show('project',false);renderProject();
    if(act==='learn')startSession();else if(act==='cards')openFlash()})}
document.addEventListener('click',e=>{if(e.target.closest('[data-projekte]'))openProjects()});

/* ---------- Wünsche für die Karteikarten ---------- */
async function saveWish(){cur.wishes=$('#p-wish').value.trim();await put('projects',cur)}
$('#p-wishsave').onclick=async()=>{await saveWish();toast('Deine Wünsche sind gespeichert ✓')};
$('#p-wishgen').onclick=async()=>{await saveWish();if(!cur.wishes){toast('Schreib oder sprich zuerst deine Wünsche.');return $('#p-wish').focus()}
  const b=$('#p-wishgen'),t=b.textContent;b.disabled=true;b.textContent='Die Lehrerin erstellt Karten nach deinen Wünschen …';
  try{const k=await generateCards(5,true);if(k)toast(`${k} neue Karten nach deinen Wünschen ✓ Deine bisherigen Karten bleiben.`,3500)}catch(e){toast(errText(e),5000)}
  b.disabled=false;b.textContent=t;renderProject()};
$('#p-wishmic').onclick=()=>{const h=$('#p-wishhint');if(mr){stopMic();return}stopSpeak();
  if(canRec()){h.textContent='Ich höre zu … (zum Beenden 🎤 antippen)';startRecorder((txt,err)=>{if(err){h.textContent=err;return}h.textContent=txt?'':'Ich habe nichts verstanden.';if(txt){$('#p-wish').value=(($('#p-wish').value||'')+' '+txt).trim();saveWish()}})}
  else if(SRC){const r=new SRC();r.lang='de-CH';r.onresult=e=>{$('#p-wish').value=(($('#p-wish').value||'')+' '+e.results[0][0].transcript).trim();saveWish()};r.onend=()=>h.textContent='';h.textContent='Ich höre zu …';r.start()}
  else h.textContent='Tipp: Zum Sprechen das 🎤 auf der iPhone-Tastatur antippen.'};

/* ---------- Fehler sichtbar machen ---------- */
let lastErr=0;function showErr(m){if(Date.now()-lastErr<4000)return;lastErr=Date.now();console.error(m);
  toast('Hoppla, da ist ein Fehler passiert: '+String(m||'unbekannt').slice(0,140)+' – bitte die App schliessen und neu öffnen. Wenn es wieder passiert, schick mir ein Bildschirmfoto.',7000)}
window.addEventListener('error',e=>showErr(e.message));
window.addEventListener('unhandledrejection',e=>showErr(e.reason&&(e.reason.message||e.reason)));

/* ---------- Start ---------- */
renderHome().then(()=>syncKey()).then(resumeBooks);
if('serviceWorker' in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('sw.js');
window.__lehrerin={bm25,tokens,chunkPages,verifyPrompt,parseVerify,corrText,PERSONA,CARD_RULES};

$('#home-savekey').onclick=()=>{const v=$('#home-key').value.trim();if(!v){$('#home-key').focus();return}saveKey(v);$('#home-key').value='';$('#nokey').classList.add('hidden');try{$('#k-key').value=v}catch(e){}alert('Gespeichert ✓ Du kannst jetzt chatten.')};

async function pasteKey(inp,after){try{const t=(await navigator.clipboard.readText()||'').trim();if(!t){toast('Die Zwischenablage ist leer.');return}
  inp.value=t;await saveKey(t);$('#nokey').classList.add('hidden');toast('Schlüssel eingefügt und gespeichert ✓');after&&after()}
  catch(e){toast('Einfügen ging nicht – bitte lange ins Feld tippen und „Einsetzen“ wählen.',4000)}}
$('#home-paste').onclick=()=>pasteKey($('#home-key'),()=>{$('#home-key').value=''});
$('#k-paste').onclick=()=>pasteKey($('#k-key'));
