const ports = [
  { key: 'left-rear', label: '左後' },
  { key: 'left-front', label: '左前' },
  { key: 'right-front', label: '右前' },
  { key: 'right-rear', label: '右後' }
];
const storageKey = 'pump-v085';
const emptyBranch = () => ({ active: false, stopped: false, diam: 50, count: null, nozzle: null, setting: null });
const emptyLine = () => ({ active: false, diam: 65, count: null, fork: null, branches: [emptyBranch(), emptyBranch()] });
function load() {
  const initial = { water: '無圧', backpressure: 0, flipped: false, lines: ports.map(emptyLine) };
  try {
    const current = JSON.parse(localStorage.getItem(storageKey));
    if (current?.lines?.length === ports.length) return current;
    const legacy = JSON.parse(localStorage.getItem('pump-v083') || localStorage.getItem('pump-v08'));
    if (!legacy) return initial;
    initial.water = legacy.water || initial.water;
    initial.backpressure = Number(legacy.backpressure) || 0;
    for (const [index, line] of (legacy.lines || []).slice(0, 2).entries()) {
      if (!line.active || !line.count || !line.branches?.[0]?.setting) continue;
      initial.lines[index + 2] = {
        ...emptyLine(), ...line,
        branches: line.branches.map(branch => ({ ...branch, stopped: Boolean(line.stopped || branch.stopped) }))
      };
    }
  } catch {}
  return initial;
}

const data = load();
let ctx = null, step = 0, partialDiameter = null, partialFlow = null;
const $ = id => document.getElementById(id);
function save() {
  try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch {}
  render();
}
function qNozzle(b){if(!b.nozzle||!b.setting)return null;if(b.nozzle==='ダブコン'){
 const [d,q]=b.setting.split('/').map(Number);if(!(d>0&&q>0))return null;
 const area=Math.PI*(d/1000)**2/4, v=(q/60000)/(0.95*area),p=1000*v*v/2/1e6;
 return {q,p,force:(q/60000)*1000*v};
}const [rated,press]=b.setting.split('/').map(Number);if(!(rated>0&&press>0))return null;
 const q=rated*Math.sqrt(press/0.6);return {q,p:press,force:null};}
function hoseLoss(d,n,q){if(!(d>0&&n>=0&&q>=0))return 0;const area=Math.PI*(d/1000)**2/4,v=q/60000/area;return 0.025*(n*20)/(d/1000)*1000*v*v/2/1e6}
function calculate(){let total=0,required=[],missing=false,forces=[];for(const l of data.lines){if(!l.active)continue;
if(!l.count||l.fork===null){missing=true;continue}
const active=l.fork?l.branches.filter(b=>b.active&&!b.stopped):[l.branches[0]].filter(b=>!b.stopped);
if(!active.length)continue;
let sum=0,paths=[];for(const b of active){const nozzle=qNozzle(b);if(!nozzle||(l.fork&&!b.count)){missing=true;continue}sum+=nozzle.q;
const endLoss=l.fork?hoseLoss(b.diam,b.count,nozzle.q):0;
paths.push(nozzle.p+endLoss);if(nozzle.force!==null)forces.push(nozzle.force)}
if(paths.length){total+=sum;required.push(Math.max(...paths)+hoseLoss(l.diam,l.count,sum)+(l.fork?0.02:0))}}
if(missing)return {ok:false,total};if(!required.length)return {ok:true,stopped:true,p:0,total:0,forces:[]};const p=Math.max(...required)+data.backpressure*0.00980665;return {ok:true,p,total,forces};}
function control(label, handler, ariaLabel) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.onclick = handler;
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  return button;
}

function alignHoses() {
  const map = $('map');
  const bounds = map.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  for (const row of $('lines').querySelectorAll('[data-line]')) {
    const key = row.dataset.line;
    const port = document.querySelector('[data-port="' + key + '"]');
    const portBounds = port.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    const center = portBounds.left + portBounds.width / 2;
    const x = (data.flipped ? bounds.right - center : center - bounds.left) / bounds.width * 300;
    const y = (portBounds.top + portBounds.height / 2 - bounds.top) / bounds.height * 192;
    const end = (rowBounds.top + rowBounds.height / 2 - bounds.top) / bounds.height * 192;
    const rear = key.endsWith('rear');
    const offset = y + (y < 96 ? -1 : 1) * (rear ? 21 : 7);
    document.querySelector('[data-hose="' + key + '"]').setAttribute('d',
      `M${x} ${y}V${offset}H196C226 ${offset} 237 ${end} 267 ${end}H300`);
  }
}

function render() {
  $('water').textContent = data.water;
  $('backpressure').textContent = '背圧 ' + data.backpressure + 'm';
  $('deck').classList.toggle('flipped', Boolean(data.flipped));
  $('flip').setAttribute('aria-pressed', String(Boolean(data.flipped)));
  const list = $('lines');
  list.replaceChildren();
  data.lines.forEach((line, index) => {
    const { key, label } = ports[index];
    const allowed = line.fork ? line.branches : line.branches.slice(0, 1);
    const active = allowed.filter(branch => branch.active);
    const paused = active.length > 0 && active.every(branch => branch.stopped);
    document.querySelector('[data-port="' + key + '"]').classList.toggle('configured', line.active);
    const hose = document.querySelector('[data-hose="' + key + '"]');
    hose.classList.toggle('attached', line.active);
    hose.classList.toggle('paused', paused);
    if (!line.active) return;

    const row = document.createElement('div');
    row.className = paused ? 'line paused' : 'line';
    row.dataset.line = key;
    row.style.setProperty('--slot', index + 1);
    const main = control(label, () => startEdit(index), label + 'の主線を編集');
    const mainDetails = document.createElement('small');
    mainDetails.textContent = `${line.diam} mm × ${line.count}本${line.fork ? '・分岐' : '・直結'}`;
    main.append(mainDetails);
    const branches = document.createElement('div');
    branches.className = 'branches';

    allowed.forEach((branch, branchIndex) => {
      const name = line.fork ? (branchIndex === 0 ? '筒先 A' : '筒先 B') : '筒先';
      const group = document.createElement('div');
      group.className = 'branch';
      const edit = control(branch.active ? name : '＋ ' + name + 'を追加',
        () => startEdit(index, branchIndex), label + 'の' + name + (branch.active ? 'を編集' : 'を追加'));
      if (branch.active) {
        const details = document.createElement('small');
        details.textContent = [line.fork && `${branch.diam} mm × ${branch.count}本`, branch.nozzle, branch.setting].filter(Boolean).join('・');
        edit.append(details);
      }
      group.append(edit);
      if (branch.active && branch.setting) {
        const stop = control(branch.stopped ? '再開' : '停止', () => {
          branch.stopped = !branch.stopped;
          save();
          document.getElementById(stop.id)?.focus();
        }, label + 'の' + name + (branch.stopped ? 'を再開' : 'を停止'));
        stop.id = `stop-${key}-${branchIndex}`;
        stop.className = branch.stopped ? 'stop paused' : 'stop';
        group.append(stop);
      }
      branches.append(group);
    });
    row.append(main, branches);
    list.append(row);
  });
  if (!data.lines.some(line => line.active)) {
    const hint = document.createElement('p');
    hint.textContent = '車両の放口をタップしてホースラインを設定';
    list.append(hint);
  }
  updateLayout();
 const pr=document.querySelector('.pressure');
 if (!data.lines.some(line => line.active)) {
   pr.textContent = '— MPa';
   pr.classList.remove('danger');
   $('total').textContent = '';
   $('alert').textContent = '';
   return;
 }
 const r=calculate();pr.classList.toggle('danger',r.ok&&!r.stopped&&r.p>1.4);
 pr.textContent=r.ok?(r.stopped?'放水停止':`${(Math.ceil(r.p/0.05)*0.05).toFixed(2)} MPa`):'— MPa';
 $('total').textContent=r.ok?`推定総流量：約${Math.round(r.total/10)*10} L/min`:'設定未完了';
 const alert=$('alert');if(!r.ok)alert.textContent='未入力の筒先・ホースがあります';
 else if(r.stopped)alert.textContent='全線停止中：必要圧力は算出しません';
 else if(r.p>1.4||r.total>2000)alert.textContent='⚠ A-2級参考性能を超える可能性：再確認';
 else if(r.p>1.2||r.total>1600)alert.textContent='⚠ 高負荷：ポンプ性能・吸水条件を確認';
 else if(r.forces.some(f=>f>200))alert.textContent='⚠ 筒先反動力が大きい可能性';
 else alert.textContent='概算値：筒先と連携して調整';
}
function updateLayout() {
  const height = Math.max(176, $('lines').offsetHeight);
  $('map').style.setProperty('--lines-height', height + 'px');
  $('map').style.setProperty('--truck-scale', String(176 / height));
  alignHoses();
}
function closeOverlay() { $('overlay').close(); }
function startEdit(index, branchIndex = null) {
  const line = data.lines[index];
  ctx = { i: index, j: branchIndex, draft: structuredClone(line) };
  step = branchIndex === null ? 0 : line.fork ? 2 : 3;
  $('delete').hidden = !line.active || branchIndex !== null;
  draw();
  $('overlay').showModal();
  $('close').focus();
}
function back() {
  const { j, draft } = ctx;
  const firstStep = j === null ? 0 : draft.fork ? 2 : 3;
  if (step === firstStep) { closeOverlay(); return; }
  if (step === 3 && !draft.fork) step = 1;
  else step--;
  draw();
}
function advance(next) { step = next; draw(); }
function finish() {
  ctx.draft.active = true;
  ctx.draft.branches[ctx.j ?? 0].active = true;
  data.lines[ctx.i] = ctx.draft;
  save();
  closeOverlay();
}
function choice(label,cb,sel=false,cls=''){const b=document.createElement('button');b.textContent=label;b.className=(sel?'selected ':'')+cls;b.onclick=cb;return b}
function grid(n){const d=document.createElement('div');d.className='choices '+({2:'two',3:'three',4:'four',5:'five',6:'six'}[n]);return d}
function text(s){const d=document.createElement('div');d.className='hint';d.textContent=s;return d}
function draw(){const l=ctx.draft,b=l.branches[ctx.j??0],o=$('options');o.replaceChildren();o.scrollTop=0;$('title').textContent=`${ports[ctx.i].label}の放口 ${ctx.j===null?'主線':ctx.j?'筒先B':'筒先A'}｜${['① ホース口径・本数','② 分岐金具','③ 筒先側ホース口径・本数','④ 筒先種類','⑤ 筒先設定'][step]}`;$('back').hidden=step===(ctx.j===null?0:l.fork?2:3);
if(step===0||step===2){const target=step===0?l:b,g=grid(2);for(const d of [65,50])g.append(choice(d+' mm',()=>{target.diam=d;draw()},target.diam===d));o.appendChild(text('ホース口径'));o.appendChild(g);o.appendChild(text('本数（1本20m）'));const counts=grid(5);for(let n=1;n<=10;n++)counts.append(choice(n+' 本',()=>{target.count=n;advance(step===0?1:3)}));o.appendChild(counts)}
else if(step===1){const g=grid(2);g.append(choice('分岐金具 あり',()=>{l.fork=true;l.branches[0].active=true;advance(2)}),choice('分岐金具 なし',()=>{l.fork=false;l.branches[0].active=true;l.branches[1]=emptyBranch();advance(3)}));o.append(g)}
else if(step===3){const g=grid(2);for(const name of ['ダブコン','クアドラ'])g.append(choice(name,()=>{if(b.nozzle!==name)b.setting=null;b.nozzle=name;partialDiameter=b.setting&&name==='ダブコン'?Number(b.setting.split('/')[0]):null;partialFlow=b.setting&&name==='クアドラ'?Number(b.setting.split('/')[0]):null;advance(4)}));o.append(g)}
else if(step===4){if(b.nozzle==='ダブコン'){o.append(text('口径（mm）'));const g=grid(6);for(const d of [10,13,15,19,23,26])g.append(choice(d+'',()=>{partialDiameter=d;draw()},partialDiameter===d));o.append(g,text('流量（L/min）／400を超えると注意。保持限界は流量だけでは決められません。'));const f=grid(5);for(const q of [300,400,500,600,700,800,900,1000,1100,1200])f.append(choice(q+'',()=>{if(partialDiameter===null)return;b.setting=partialDiameter+'/'+q;finish()},false,q>400?'caution':''));o.append(f,text(partialDiameter===null?'先に口径を選択してください':'流量を選ぶと設定を保存します。反動力は概算で別途警告します。'))}
else{const g=grid(4);o.append(text('公称流量レンジ（L/min）'));for(const q of [110,230,360,470])g.append(choice(q+'',()=>{partialFlow=q;draw()},partialFlow===q));o.append(g,text('ノズル圧力（MPa）'));const h=grid(3);for(const p of [0.5,0.6,0.7])h.append(choice(p.toFixed(1),()=>{if(partialFlow===null)return;b.setting=partialFlow+'/'+p;finish()}));o.append(h,text(partialFlow===null?'先に流量レンジを選択してください':'流量は0.6MPaを基準とした平方根則で概算します。'))}}
}
$('water').onclick=()=>{data.water=data.water==='無圧'?'有圧':'無圧';save()};$('backpressure').onclick=()=>{const values=[0,10,20,30];data.backpressure=values[(values.indexOf(data.backpressure)+1)%values.length];save()};render();

document.querySelectorAll('[data-port]').forEach(button => {
  button.onclick = () => startEdit(ports.findIndex(port => port.key === button.dataset.port));
});
$('flip').onclick = () => { data.flipped = !data.flipped; save(); };
$('close').onclick = closeOverlay;
$('back').onclick = back;
$('delete').onclick = () => {
  const { i } = ctx;
  if (!confirm(ports[i].label + 'のホースライン設定を削除しますか？')) return;
  data.lines[i] = emptyLine();
  save();
  closeOverlay();
};
$('overlay').addEventListener('close', () => {
  if (!ctx) return;
  const { key } = ports[ctx.i];
  ctx = null;
  document.querySelector('[data-port="' + key + '"]').focus({ preventScroll: true });
});
$('reset').onclick = () => {
  if (!confirm('すべての設定を初期化しますか？')) return;
  Object.assign(data, { water: '無圧', backpressure: 0, flipped: false, lines: ports.map(emptyLine) });
  save();
};
new ResizeObserver(updateLayout).observe($('lines'));
window.addEventListener('resize', updateLayout);
