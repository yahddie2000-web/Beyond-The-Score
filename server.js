'use strict';
// Beyond the Score — same-room online multiplayer, without third-party npm dependencies.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ROOT=__dirname, PUBLIC=path.join(ROOT,'public');
const PORT=Number(process.env.PORT||3000);
const ROOM_FILE=path.join(process.env.DATA_DIR||path.join(ROOT,'data'),'rooms.json');
const CORE=fs.readFileSync(path.join(ROOT,'engine-core.js'),'utf8');
const MAX_ROOMS=40, MAX_SEATS=4, MAX_SPECTATORS=25;
const rooms=new Map();
const noSave=process.env.NO_SAVE==='1';
function newEngine(){
  const context=vm.createContext({document:{getElementById:()=>({})},window:{scrollTo:()=>{}},console:{warn:()=>{}},setTimeout,Math}, {name:'BTS research game engine'});
  vm.runInContext(CORE,context,{timeout:2000,filename:'engine-core.js'});
  return context.EngineBridge;
}
const catalog=newEngine().list();
const safe=(s,max=30)=>String(s||'').trim().replace(/[\r\n<>\x00-\x1f]/g,'').slice(0,max);
const newToken=()=>crypto.randomBytes(22).toString('base64url');
const encode=()=>{let code='';const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';for(let i=0;i<6;i++)code+=alphabet[crypto.randomInt(alphabet.length)];return code;};
const createCode=()=>{let c;do{c=encode()}while(rooms.has(c));return c;};
const validValue=(array,v,fallback)=>array.includes(v)?v:fallback;
const bgIds=catalog.backgrounds.map(b=>b.id),homeIds=catalog.homes.map(h=>h.id);
const profile=(name,index=0)=>({name:safe(name,28)||`Player ${index+1}`,background:bgIds[index%bgIds.length],home:'warm',priority:'Purpose'});
function initRoom(name){
 if(rooms.size>=MAX_ROOMS)throw fail(429,'Room limit reached. Try again later.');
 const code=createCode(),token=newToken();
 const room={code,stage:'lobby',created:Date.now(),updated:Date.now(),revision:0,seats:[{...profile(name),token,online:false}],spectators:[],engine:null,clients:new Set(),lastAction:null};
 rooms.set(code,room);saveRooms();return {room,token};
}
const fail=(status,message)=>Object.assign(new Error(message),{status});
function findRoom(code){const r=rooms.get(safe(code,6).toUpperCase());if(!r)throw fail(404,'Room not found. Check the six-character code.');return r;}
function member(room,token){const seat=room.seats.findIndex(x=>x.token===token);if(seat!==-1)return {seat,host:seat===0,player:true};const viewer=room.spectators.find(x=>x.token===token);if(viewer)return {seat:-1,host:false,player:false};throw fail(401,'Your session expired; rejoin the room.');}
function snapshot(room){
 const play=room.engine?room.engine.state():null;
 return {code:room.code,stage:room.stage,revision:room.revision,hostName:room.seats[0]?.name||'',seats:room.seats.map((s,i)=>({seat:i,name:s.name,background:s.background,home:s.home,priority:s.priority,online:!!s.online})),spectators:room.spectators.length,total:catalog.total,lastAction:room.lastAction,demo:room.demo||null,game:play,chapter:play&&play.screen!=='finish'?room.engine.chapter():null};
}
function broadcast(room,event='state',payload=snapshot(room)){
 const msg=`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
 for(const c of Array.from(room.clients)){try{c.res.write(msg);}catch(e){room.clients.delete(c);}}
}
function update(room,label,name){room.revision++;room.updated=Date.now();room.lastAction={kind:label,by:name||'',ts:Date.now(),revision:room.revision};saveRooms();broadcast(room);}
function saveRooms(){if(noSave)return;try{fs.mkdirSync(path.dirname(ROOM_FILE),{recursive:true});const list=Array.from(rooms.values()).map(r=>({code:r.code,stage:r.stage,created:r.created,updated:r.updated,revision:r.revision,seats:r.seats.map(s=>({...s,online:false})),spectators:r.spectators.map(s=>({...s,online:false})),lastAction:r.lastAction,demo:r.demo||null,game:r.engine?r.engine.state():null}));const tmp=ROOM_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify({version:1,list}));fs.renameSync(tmp,ROOM_FILE);}catch(e){console.error('Could not save room snapshot:',e.message);}}
function loadRooms(){if(noSave)return;try{const payload=JSON.parse(fs.readFileSync(ROOM_FILE,'utf8'));for(const x of payload.list||[]){if(typeof x.code!=='string'||!Array.isArray(x.seats)||x.seats.length>MAX_SEATS)continue;const room={code:x.code,stage:x.stage,created:x.created,updated:x.updated,revision:x.revision||0,seats:x.seats,spectators:x.spectators||[],lastAction:x.lastAction,demo:x.demo||null,engine:null,clients:new Set()};if(x.game){room.engine=newEngine();if(!room.engine.restore({version:6,game:x.game,prefs:x.seats.map(s=>({name:s.name,background:s.background,home:s.home,priority:s.priority}))}))continue;}rooms.set(room.code,room);}console.log('Restored rooms:',rooms.size);}catch(e){if(e.code!=='ENOENT')console.warn('Room restore:',e.message);}}
loadRooms();
function json(res,status,data){const txt=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(txt),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(txt);}
function readJson(req){return new Promise((resolve,reject)=>{let raw='';req.on('data',chunk=>{raw+=chunk;if(raw.length>100_000){reject(fail(413,'Request too large'));req.destroy();}});req.on('end',()=>{try{resolve(raw?JSON.parse(raw):{});}catch(e){reject(fail(400,'Invalid JSON'));}});req.on('error',reject);});}
const TYPES={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
function staticFile(res,url){const pathname=url.pathname==='/'?'/index.html':url.pathname;const target=path.resolve(PUBLIC,'.'+pathname);if(!target.startsWith(PUBLIC+path.sep)){json(res,403,{error:'Forbidden'});return;}fs.readFile(target,(e,bytes)=>{if(e){json(res,404,{error:'Not found'});return;}res.writeHead(200,{'Content-Type':TYPES[path.extname(target)]||'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"});res.end(bytes);});}
function establish(room,res,memberToken){
 res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
 const c={res,token:memberToken};room.clients.add(c);res.write(`retry: 2500\nevent: state\ndata: ${JSON.stringify(snapshot(room))}\n\n`);
 const m=member(room,memberToken);if(m.player)room.seats[m.seat].online=true;
 broadcast(room);res.on('close',()=>{room.clients.delete(c);const still=Array.from(room.clients).some(v=>v.token===memberToken);if(m.player&&!still){room.seats[m.seat].online=false;broadcast(room);}});
}
async function route(req,res){
 const url=new URL(req.url,'http://localhost');
 if(req.method==='GET'&&url.pathname==='/health'){return json(res,200,{ok:true,rooms:rooms.size});}
 if(req.method==='GET'&&url.pathname==='/api/catalog')return json(res,200,catalog);
 if(req.method==='GET'&&url.pathname==='/api/events'){
  const room=findRoom(url.searchParams.get('code'));const token=url.searchParams.get('token');member(room,token);return establish(room,res,token);
 }
 if(req.method==='GET'&&url.pathname==='/api/state'){
  const room=findRoom(url.searchParams.get('code'));member(room,url.searchParams.get('token'));return json(res,200,snapshot(room));
 }
 if(req.method==='POST'){
  const b=await readJson(req);
  if(url.pathname==='/api/create'){
   const {room,token}=initRoom(b.name);
   return json(res,200,{code:room.code,token,seat:0,state:snapshot(room)});
  }
  if(url.pathname==='/api/join'){
   const room=findRoom(b.code);const supplied=safe(b.token,80);
   if(supplied){try{const m=member(room,supplied);return json(res,200,{code:room.code,token:supplied,seat:m.seat,state:snapshot(room)});}catch(e){/* fresh join */}}
   const name=safe(b.name,28)||`Player ${room.seats.length+1}`;
   let seat=-1;
   if(room.stage==='lobby'&&room.seats.length<MAX_SEATS&&b.spectate!==true){seat=room.seats.length;room.seats.push({...profile(name,seat),token:newToken(),online:false});}
   else{if(room.spectators.length>=MAX_SPECTATORS)throw fail(429,'This room has too many spectators.');room.spectators.push({name,token:newToken()});}
   const token=seat>=0?room.seats[seat].token:room.spectators.at(-1).token;
   update(room,'joined',name);return json(res,200,{code:room.code,token,seat,state:snapshot(room)});
  }
  const room=findRoom(b.code);const m=member(room,b.token);
  if(url.pathname==='/api/profile'){
   if(room.stage!=='lobby'||!m.player)throw fail(409,'Profiles can only be changed in the lobby.');
   const s=room.seats[m.seat];s.name=safe(b.name,28)||s.name;s.background=validValue(bgIds,b.background,s.background);s.home=validValue(homeIds,b.home,s.home);s.priority=validValue(catalog.priorities,b.priority,s.priority);update(room,'profile',s.name);return json(res,200,{ok:true});
  }
  if(url.pathname==='/api/start'){
   if(room.stage!=='lobby'||!m.host)throw fail(403,'Only the host can start from the lobby.');
   room.engine=newEngine();room.engine.setup(room.seats.map(s=>({name:s.name,background:s.background,home:s.home,priority:s.priority})));room.stage='play';update(room,'start',room.seats[0].name);return json(res,200,{ok:true});
  }
  if(url.pathname==='/api/demo'){
   if(!m.host||room.stage!=='lobby')throw fail(403,'Only the host can prepare a demo from the lobby.');
   if(!['party','business'].includes(b.preset))throw fail(400,'Unknown demonstration.');
   const target=b.preset==='party'?34:62;
   room.engine=newEngine();room.engine.setup(room.seats.map(s=>({name:s.name,background:s.background,home:s.home,priority:s.priority})));
   let steps=0;
   while(room.engine.state().round<target){
    const state=room.engine.state();
    if(state.phase==='spin')room.engine.turn('spin');
    else if(state.phase==='decision'){
     const opts=room.engine.chapter().options.filter(o=>o.enabled);
     if(!opts.length)throw fail(500,'Demo could not find a valid choice.');
     const choice=opts[(state.current+state.round)%opts.length];
     room.engine.turn('choose',choice.index);
    }else if(state.phase==='result')room.engine.turn('next');
    else throw fail(500,'Demo encountered an unknown stage.');
    if(++steps>2500)throw fail(500,'Demo exceeded its safe length.');
   }
   room.stage='play';room.demo=b.preset;update(room,'demo','Sample prehistory created — '+b.preset);
   return json(res,200,{ok:true,chapter:target});
  }
  if(url.pathname==='/api/action'){
   if(room.stage!=='play'||!room.engine)throw fail(409,'Game has not started.');
   const s=room.engine.state();if(s.screen==='finish')throw fail(409,'Game has ended.');
   const type=b.type,active=s.current;
   if(!m.player||m.seat!==active){if(!(m.host&&type==='next'&&s.phase==='result'))throw fail(403,'It is not your turn.');}
   if(type==='choose'){
    if(s.phase!=='decision')throw fail(409,'Wait until the decision phase.');
    const opts=room.engine.chapter().options;const opt=opts.find(x=>x.index===b.index&&x.enabled);if(!opt)throw fail(400,'That option is not available.');
   }else if(type==='spin'&&s.phase!=='spin')throw fail(409,'This is not a spin phase.');
   else if(type==='next'&&s.phase!=='result')throw fail(409,'Choose an answer first.');
   else if(type==='feeling'&&(s.phase!=='result'||!['Hopeful','Anxious','Conflicted','Relieved','Proud','Regretful','Lonely','Grateful','Frustrated','Uncertain','Excited','Overwhelmed'].includes(b.value)))throw fail(400,'This feeling cannot be submitted now.');
   else if(!['choose','spin','next','feeling'].includes(type))throw fail(400,'Unknown action.');
   let name=room.seats[active].name;
   room.engine.turn(type,type==='choose'?b.index:b.value);
   if(type==='choose')name+=` · ${room.engine.state().last?.label||'decision'}`;
   if(room.engine.state().screen==='finish')room.stage='finish';
   update(room,type,name);return json(res,200,{ok:true});
  }
  if(url.pathname==='/api/spotlight'){
   if(room.stage!=='play'||!m.player||room.engine.state().current!==m.seat||room.engine.state().phase!=='decision')throw fail(403,'You are not the active player.');
   const option=room.engine.chapter().options.find(o=>o.index===b.index);if(!option||!option.enabled)throw fail(400,'Unavailable option');
   broadcast(room,'spotlight',{seat:m.seat,index:b.index,name:room.seats[m.seat].name,label:option.label,at:Date.now()});return json(res,200,{ok:true});
  }
  if(url.pathname==='/api/end'){
   if(!m.host)throw fail(403,'Only the host can close a room.');
   broadcast(room,'closed',{message:'The host closed this game.'});for(const c of room.clients){try{c.res.end();}catch(e){}}rooms.delete(room.code);saveRooms();return json(res,200,{ok:true});
  }
  return json(res,404,{error:'Unknown API endpoint'});
 }
 staticFile(res,url);
}
const server=http.createServer((req,res)=>{route(req,res).catch(e=>{console.error(req.method,req.url,e.stack||e.message);if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'Unexpected server problem.'});else res.end();});});
setInterval(()=>{for(const room of rooms.values()){for(const c of room.clients){try{c.res.write(': keepalive\n\n');}catch(e){room.clients.delete(c);}}}},20_000).unref();
setInterval(()=>{let removed=0;for(const [code,r] of rooms){if(Date.now()-r.updated>72*60*60*1000){for(const client of r.clients)try{client.res.end();}catch(e){}rooms.delete(code);removed++;}}if(removed)saveRooms();},60*60*1000).unref();
server.listen(PORT,'0.0.0.0',()=>console.log(`Beyond the Score multiplayer running on http://localhost:${PORT}`));
module.exports={server,rooms};
