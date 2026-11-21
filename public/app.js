const init=()=>({water:'無圧',backpressure:0,lines:[0,1].map((_,i)=>({active:i===0,stopped:false,diam:65,count:null,fork:null,branches:[{active:i===0,stopped:false,diam:50,count:null,nozzle:null,setting:null},{active:false,stopped:false,diam:50,count:null,nozzle:null,setting:null}]}))});
let data;try{data=JSON.parse(localStorage.getItem('pump-v083')||localStorage.getItem('pump-v08'))||init()}catch{data=init()}
data.backpressure=Number(data.backpressure)||0;data.lines.forEach(l=>{l.stopped=!!l.stopped;l.branches.forEach(b=>b.stopped=!!b.stopped)});
let ctx=null,step=0,partialDiameter=null,partialFlow=null;
const save=()=>{try{localStorage.setItem('pump-v083',JSON.stringify(data))}catch{}render()};
const $=id=>document.getElementById(id);
function qNozzle(b){if(!b.nozzle||!b.setting)return null;if(b.nozzle==='ダブコン'){
 const [d,q]=b.setting.split('/').map(Number);if(!(d>0&&q>0))return null;
 const area=Math.PI*(d/1000)**2/4, v=(q/60000)/(0.95*area),p=1000*v*v/2/1e6;
 return {q,p,force:(q/60000)*1000*v};
}const [rated,press]=b.setting.split('/').map(Number);if(!(rated>0&&press>0))return null;
 const q=rated*Math.sqrt(press/0.6);return {q,p:press,force:null};}
function hoseLoss(d,n,q){if(!(d>0&&n>=0&&q>=0))return 0;const area=Math.PI*(d/1000)**2/4,v=q/60000/area;return 0.025*(n*20)/(d/1000)*1000*v*v/2/1e6}
function calculate(){let total=0,required=[],missing=false,forces=[];for(const l of data.lines){if(!l.active||l.stopped)continue;
if(!l.count||l.fork===null){missing=true;continue}
const active=l.fork?l.branches.filter(b=>b.active&&!b.stopped):[l.branches[0]].filter(b=>!b.stopped);
if(!active.length)continue;
let sum=0,paths=[];for(const b of active){const nozzle=qNozzle(b);if(!nozzle||(l.fork&&!b.count)){missing=true;continue}sum+=nozzle.q;
const endLoss=l.fork?hoseLoss(b.diam,b.count,nozzle.q):0;
paths.push(nozzle.p+endLoss);if(nozzle.force!==null)forces.push(nozzle.force)}
if(paths.length){total+=sum;required.push(Math.max(...paths)+hoseLoss(l.diam,l.count,sum)+(l.fork?0.02:0))}}
if(missing)return {ok:false,total};if(!required.length)return {ok:true,stopped:true,p:0,total:0,forces:[]};const p=Math.max(...required)+data.backpressure*0.00980665;return {ok:true,p,total,forces};}
function toggleStop(i){const l=data.lines[i];if(!l.active)return;l.stopped=!l.stopped;save()}
function toggleBranchStop(i,j){const l=data.lines[i],b=l.branches[j];if(!l.active||(j===1&&!l.fork)||!b.active)return;b.stopped=!b.stopped;save()}
function render(){
 $('water').textContent=data.water;
 $('backpressure').textContent='背圧 '+data.backpressure+'m';
 data.lines.forEach((l,i)=>{
  const line=$('line'+i);line.classList.toggle('off',!l.active);line.classList.toggle('paused',l.active&&l.stopped);
  $('main'+i).textContent=l.active?`第${i+1}線 ${l.diam}mm × ${l.count??'—'}本 ${l.fork===null?'':l.fork?'／分岐あり':'／分岐なし'}`:`＋ 第${i+1}線を追加`;
  const stop=$('stop'+i);stop.disabled=!l.active;stop.textContent=l.stopped?'再開':'停止';stop.classList.toggle('paused',l.stopped);stop.title=l.stopped?'第'+(i+1)+'線の放水を再開':'第'+(i+1)+'線を放水停止';
  l.branches.forEach((b,j)=>{
   const el=$(`branch${i}${j}`),wrapper=el.parentElement,bs=$(`stop${i}${j}`);
   wrapper.style.display=l.fork===false&&j===1?'none':'';
   el.textContent=b.active?`${j?'B':'A'} ${b.diam}mm×${b.count??'—'}本 / ${b.nozzle??'筒先未設定'} ${b.setting??''}`:j?'＋ 筒先Bを追加':'筒先A 設定する';
   el.disabled=!l.active||(j===1&&l.fork!==true);
   bs.style.display=b.active&&(l.fork===true||j===0&&l.fork===false)?'':'none';bs.disabled=!l.active;
   bs.textContent=b.stopped?'再開':'停止';bs.classList.toggle('paused',b.stopped);el.classList.toggle('paused',b.stopped||l.stopped);
  });
 });
 const r=calculate(),pr=document.querySelector('.pressure');pr.classList.toggle('danger',r.ok&&!r.stopped&&r.p>1.4);
 pr.textContent=r.ok?(r.stopped?'放水停止':`${(Math.ceil(r.p/0.05)*0.05).toFixed(2)} MPa`):'— MPa';
 $('total').textContent=r.ok?`推定総流量：約${Math.round(r.total/10)*10} L/min`:'設定未完了';
 const alert=$('alert');if(!r.ok)alert.textContent='未入力の筒先・ホースがあります';
 else if(r.stopped)alert.textContent='全線停止中：必要圧力は算出しません';
 else if(r.p>1.4||r.total>2000)alert.textContent='⚠ A-2級参考性能を超える可能性：再確認';
 else if(r.p>1.2||r.total>1600)alert.textContent='⚠ 高負荷：ポンプ性能・吸水条件を確認';
 else if(r.forces.some(f=>f>200))alert.textContent='⚠ 筒先反動力が大きい可能性';
 else alert.textContent='概算値：筒先と連携して調整';
}
function closeOverlay(){ $('overlay').classList.remove('show');ctx=null;save()}
function open(){ $('overlay').classList.add('show');try{draw()}catch(e){$('options').textContent='入力画面の表示エラー: '+e.message;console.error(e)}}
function startMain(i){data.lines[i].active=true;ctx={i,j:null};step=0;save();open()}
function startBranch(i,j){const l=data.lines[i];if(!l.active||(j===1&&l.fork!==true))return;l.branches[j].active=true;ctx={i,j};step=2;save();open()}
function back(){if(step===0||(ctx.j!==null&&step===2)){closeOverlay();return}if(step===3)step=ctx.j===null&&data.lines[ctx.i].fork===false?1:2;else if(step===4)step=3;else if(step===2)step=1;else step=0;draw()}
function advance(n){step=n;save();draw()}
function finish(){save();closeOverlay()}
function choice(label,cb,sel=false,cls=''){const b=document.createElement('button');b.textContent=label;b.className=(sel?'selected ':'')+cls;b.onclick=cb;return b}
function grid(n){const d=document.createElement('div');d.className='choices '+({2:'two',3:'three',4:'four',5:'five',6:'six'}[n]);return d}
function text(s){const d=document.createElement('div');d.className='hint';d.textContent=s;return d}
function draw(){const l=data.lines[ctx.i],b=l.branches[ctx.j??0],o=$('options');o.replaceChildren();$('title').textContent=`第${ctx.i+1}線 ${ctx.j===null?'主線':ctx.j?'筒先B':'筒先A'}｜${['① ホース口径・本数','② 分岐金具','③ 筒先側ホース口径・本数','④ 筒先種類','⑤ 筒先設定'][step]}`;$('back').style.visibility=step===0?'hidden':'visible';
if(step===0||step===2){const target=step===0?l:b,g=grid(2);for(const d of [65,50])g.append(choice(d+' mm',()=>{target.diam=d;save();draw()},target.diam===d));o.appendChild(text('ホース口径'));o.appendChild(g);o.appendChild(text('本数（1本20m）'));const counts=grid(5);for(let n=1;n<=10;n++)counts.append(choice(n+' 本',()=>{target.count=n;advance(step===0?1:3)}));o.appendChild(counts)}
else if(step===1){const g=grid(2);g.append(choice('分岐金具 あり',()=>{l.fork=true;l.branches[0].active=true;advance(2)}),choice('分岐金具 なし',()=>{l.fork=false;l.branches[0].active=true;l.branches[1].active=false;advance(3)}));o.append(g)}
else if(step===3){const g=grid(2);for(const name of ['ダブコン','クアドラ'])g.append(choice(name,()=>{if(b.nozzle!==name)b.setting=null;b.nozzle=name;partialDiameter=b.setting&&name==='ダブコン'?Number(b.setting.split('/')[0]):null;partialFlow=b.setting&&name==='クアドラ'?Number(b.setting.split('/')[0]):null;advance(4)}));o.append(g)}
else if(step===4){if(b.nozzle==='ダブコン'){o.append(text('口径（mm）'));const g=grid(6);for(const d of [10,13,15,19,23,26])g.append(choice(d+'',()=>{partialDiameter=d;draw()},partialDiameter===d));o.append(g,text('流量（L/min）／400を超えると注意。保持限界は流量だけでは決められません。'));const f=grid(5);for(const q of [300,400,500,600,700,800,900,1000,1100,1200])f.append(choice(q+'',()=>{if(partialDiameter===null)return;b.setting=partialDiameter+'/'+q;finish()},false,q>400?'caution':''));o.append(f,text(partialDiameter===null?'先に口径を選択してください':'流量を選ぶと設定を保存します。反動力は概算で別途警告します。'))}
else{const g=grid(4);o.append(text('公称流量レンジ（L/min）'));for(const q of [110,230,360,470])g.append(choice(q+'',()=>{partialFlow=q;draw()},partialFlow===q));o.append(g,text('ノズル圧力（MPa）'));const h=grid(3);for(const p of [0.5,0.6,0.7])h.append(choice(p.toFixed(1),()=>{if(partialFlow===null)return;b.setting=partialFlow+'/'+p;finish()}));o.append(h,text(partialFlow===null?'先に流量レンジを選択してください':'流量は0.6MPaを基準とした平方根則で概算します。'))}}
}
$('water').onclick=()=>{data.water=data.water==='無圧'?'有圧':'無圧';save()};$('backpressure').onclick=()=>{const values=[0,10,20,30];data.backpressure=values[(values.indexOf(data.backpressure)+1)%values.length];save()};render();

const fullscreenButton = $('fullscreen');
const screenHint = $('screen-hint');
const installed = window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches
  || navigator.standalone === true;

function syncFullscreen() {
  fullscreenButton.textContent = document.fullscreenElement ? '全画面を終了' : '横向き全画面';
  screenHint.hidden = true;
}

fullscreenButton.hidden = installed || !document.fullscreenEnabled;
if (!installed && !document.fullscreenEnabled) {
  screenHint.textContent = 'ブラウザのメニューからホーム画面に追加すると、タブ欄を省いて起動できます。';
  screenHint.hidden = false;
}

document.addEventListener('fullscreenchange', syncFullscreen);
fullscreenButton.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen();
  } catch {
    screenHint.textContent = '全画面にできませんでした。ブラウザのメニューからホーム画面に追加できます。';
    screenHint.hidden = false;
    return;
  }

  try {
    await screen.orientation.lock('landscape');
  } catch {
    if (window.matchMedia('(orientation: portrait)').matches) {
      screenHint.textContent = '端末を横向きにしてください。';
      screenHint.hidden = false;
    }
  }
});
