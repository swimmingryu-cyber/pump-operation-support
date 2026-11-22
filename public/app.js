const ports = [
  { key: 'left-rear', label: '左後' },
  { key: 'left-front', label: '左前' },
  { key: 'right-front', label: '右前' },
  { key: 'right-rear', label: '右後' }
];
const storageKey = 'pump-v087';
const elevations = [-30, -20, -10, 0, 10, 20, 30];
const pressurePerMetre = 0.00980665;
const suctionHeights = Array.from({ length: 21 }, (_, index) => index / 2);
const equipmentTypes = {
  50: '50 mmホース', 65: '65 mmホース',
  fork: '分岐金具', coupling: '結合金具'
};
// Reference values for alerts until the installed equipment's specifications are entered.
const equipmentPressureReferences = { 50: 1.3, 65: 1.3, fork: 0.7, coupling: 1.3 };
const quadraRanges = [110, 230, 360, 470];
// Operational criteria from local fog-use verification. Independent of the flow model.
const defaultQuadraFogLimit = { range: 230, pressure: 0.5 };
const quadraFlowReferencePressure = 0.6; // Provisional square-root estimate retained from earlier versions.

function quadraFogLimit() {
  const limit = data.quadraFogLimit;
  return quadraRanges.includes(limit?.range) && Number.isFinite(limit.pressure) && limit.pressure >= 0.01
    ? limit : defaultQuadraFogLimit;
}

function quadraLimitText() {
  const { range, pressure } = quadraFogLimit();
  return range + ' L/minレンジ・' + pressure.toFixed(2) + ' MPa';
}
const emptyBranch = () => ({ active: false, stopped: false, diam: 50, count: null, nozzle: null, setting: null, elevation: 0 });
const emptyLine = () => ({ active: false, diam: 65, count: null, fork: null, branches: [emptyBranch(), emptyBranch()] });
function migrateElevations(lines, legacyElevation) {
  const value = Number(legacyElevation);
  const elevation = elevations.includes(value) ? value : 0;
  return lines.map(line => ({
    ...line,
    branches: line.branches.map(branch => ({
      ...branch,
      elevation: branch.active && branch.setting ? elevation : 0
    }))
  }));
}
function load() {
  const initial = { flipped: false, lines: ports.map(emptyLine) };
  try {
    const current = JSON.parse(localStorage.getItem(storageKey));
    if (current?.lines?.length === ports.length) return current;
    const previous = JSON.parse(localStorage.getItem('pump-v085'));
    if (previous?.lines?.length === ports.length) {
      return { flipped: Boolean(previous.flipped), lines: migrateElevations(previous.lines, previous.backpressure) };
    }
    const legacy = JSON.parse(localStorage.getItem('pump-v083') || localStorage.getItem('pump-v08'));
    if (!legacy) return initial;
    for (const [index, line] of (legacy.lines || []).slice(0, 2).entries()) {
      if (!line.active || !line.count || !line.branches?.[0]?.setting) continue;
      initial.lines[index + 2] = {
        ...emptyLine(), ...line,
        branches: line.branches.map(branch => ({ ...branch, stopped: Boolean(line.stopped || branch.stopped) }))
      };
    }
    initial.lines = migrateElevations(initial.lines, legacy.backpressure);
  } catch {}
  return initial;
}

const data = load();
let ctx = null, step = 0, partialDiameter = null, partialFlow = null;
const $ = id => document.getElementById(id);
function save() {
  if (!data.lines.some(line => line.active)) data.fixedPressure = null;
  try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch {}
  render();
}
function qNozzle(b){if(!b.nozzle||!b.setting)return null;if(b.nozzle==='ダブコン'){
 const [d,q]=b.setting.split('/').map(Number);if(!(d>0&&q>0))return null;
 const area=Math.PI*(d/1000)**2/4, v=(q/60000)/(0.95*area),p=1000*v*v/2/1e6;
 return {q,p,force:(q/60000)*1000*v};
}const [rated,press]=b.setting.split('/').map(Number);if(!(rated>0&&press>0))return null;
 const q=rated*Math.sqrt(press/quadraFlowReferencePressure);return {q,p:press,force:null};}
function hoseLoss(d,n,q){if(!(d>0&&n>=0&&q>=0))return 0;const area=Math.PI*(d/1000)**2/4,v=q/60000/area;return 0.025*(n*20)/(d/1000)*1000*v*v/2/1e6}

const nozzleDiameters = [10, 13, 15, 19, 23, 26];
const reactionReference = 200;
const pressureText = p => p.toFixed(3) + ' MPa';
const flowText = q => Math.round(q) + ' L/min';

function nozzleName(index, branchIndex, fork) {
  return ports[index].label + '・筒先' + (fork ? (branchIndex ? ' B' : ' A') : '');
}

function calculate() {
  const paths = [];
  const lines = [];
  let missing = false;
  data.lines.forEach((line, index) => {
    if (!line.active) return;
    const outlets = [];
    const branches = line.fork ? line.branches : line.branches.slice(0, 1);
    branches.forEach((branch, branchIndex) => {
      if (!branch.active || branch.stopped) return;
      const target = qNozzle(branch);
      if (!Number.isSafeInteger(line.count) || line.count < 1 || line.fork === null ||
          !target || (line.fork && !(branch.count > 0))) {
        missing = true;
        return;
      }
      const entry = {
        id: paths.length, index, branchIndex, branch, target,
        name: nozzleName(index, branchIndex, line.fork),
        elevation: (branch.elevation ?? 0) * pressurePerMetre,
        nozzleCoefficient: target.p / target.q ** 2,
        reactionCoefficient: target.force === null ? null : target.force / target.q ** 2,
        hoseCoefficient: line.fork ? hoseLoss(branch.diam, branch.count, 1) : 0
      };
      paths.push(entry);
      outlets.push(entry);
    });
    if (outlets.length) lines.push({
      outlets, loss: hoseLoss(line.diam, line.count, 1), fitting: line.fork ? 0.02 : 0,
      fork: line.fork, name: ports[index].label, diameter: line.diam
    });
  });
  const fixed = Number.isFinite(data.fixedPressure) && data.fixedPressure > 0;
  if (missing || !paths.length) return {
    ok: !missing, paths: [], stopped: !missing, fixed,
    baseline: fixed && !missing ? atPressure([], data.fixedPressure) : null
  };

  // Each outlet has a minimum pressure at the pump for its target to be met.
  // The highest minimum covers all active outlets with the valves fully open.
  const reference = pressureReference(lines, paths);
  const candidate = solve(lines, reference);
  return { ok: true, stopped: false, paths, lines, reference, fixed, candidate,
    baseline: fixed ? atPressure(lines, data.fixedPressure) : candidate };
}

function outletFlow(path, head) {
  return Math.sqrt(Math.max(0, head - path.elevation) / (path.nozzleCoefficient + path.hoseCoefficient));
}

function requiredPressure(lines, reference, adjustedId) {
  const line = lines.find(item => item.outlets.some(path => path.id === reference.id));
  const selected = line.outlets.find(path => path.id === reference.id);
  const head = selected.elevation + (selected.nozzleCoefficient + selected.hoseCoefficient) * selected.target.q ** 2;
  const total = line.outlets.reduce((sum, path) =>
    sum + (path.id === adjustedId ? path.target.q : outletFlow(path, head)), 0);
  return head + line.fitting + line.loss * total ** 2;
}

function pressureReference(lines, paths) {
  return paths.reduce((best, path) =>
    requiredPressure(lines, path) > requiredPressure(lines, best) ? path : best);
}

function solve(lines, reference, adjustedId = null) {
  return atPressure(lines, requiredPressure(lines, reference, adjustedId), adjustedId);
}

function atPressure(lines, p, adjustedId = null) {
  const nozzles = [];
  const equipment = [];
  for (const line of lines) {
    // At a common supply pressure, the flow through the main hose is the sum of its branches.
    let upper = p - line.fitting;
    let lower = Math.min(upper, ...line.outlets.map(path => path.elevation));
    const sumAt = head => line.outlets.reduce((sum, path) =>
      sum + (path.id === adjustedId ? path.target.q : outletFlow(path, head)), 0);
    for (let i = 0; i < 48; i++) {
      const head = (lower + upper) / 2;
      if (head + line.loss * sumAt(head) ** 2 > p - line.fitting) upper = head;
      else lower = head;
    }
    const head = (lower + upper) / 2;
    const couplingPressures = [];
    for (const path of line.outlets) {
      const available = outletFlow(path, head);
      const q = path.id === adjustedId ? path.target.q : available;
      nozzles[path.id] = {
        q, p: path.nozzleCoefficient * q ** 2, available,
        force: path.reactionCoefficient === null ? null : path.reactionCoefficient * q ** 2
      };
      if (line.fork) {
        const end = nozzles[path.id].p;
        const inlet = path.id === adjustedId
          ? end + path.hoseCoefficient * q ** 2 + path.elevation
          : head;
        const maximum = Math.max(inlet, end);
        equipment.push({ type: path.branch.diam, location: path.name + '側', pressure: maximum });
        couplingPressures.push(maximum);
      }
    }
    const mainEnd = line.fork ? head + line.fitting : nozzles[line.outlets[0].id].p;
    const directThrottled = !line.fork && line.outlets[0].id === adjustedId;
    const mainInlet = directThrottled
      ? mainEnd + line.loss * nozzles[adjustedId].q ** 2 + line.outlets[0].elevation
      : p;
    const mainMaximum = Math.max(mainInlet, mainEnd);
    equipment.push({ type: line.diameter, location: line.name + '・主線', pressure: mainMaximum });
    if (line.fork) equipment.push({ type: 'fork', location: line.name + '・分岐', pressure: mainEnd });
    equipment.push({
      type: 'coupling', location: line.name + '・ライン全体',
      pressure: Math.max(mainMaximum, ...couplingPressures)
    });
  }
  return { p, nozzles, equipment, total: nozzles.reduce((sum, nozzle) => sum + nozzle.q, 0) };
}

function outletWarnings(path, nozzle) {
  const danger = [];
  const notes = [];
  if (nozzle.force !== null && nozzle.force >= reactionReference) {
    danger.push('反動力注意 ' + Math.round(nozzle.force) + ' N（参考値200 N）');
  }
  if (path.branch.maxPressure && nozzle.p > path.branch.maxPressure + 1e-9) {
    danger.push('設定上限 ' + pressureText(path.branch.maxPressure) + ' を超過');
  }
  if (path.branch.nozzle === 'クアドラ') {
    const limit = quadraFogLimit();
    const range = Number(path.branch.setting.split('/')[0]);
    if (range < limit.range) danger.push('噴霧の目安レンジ未満（' + limit.range + '以上）');
    if (nozzle.p < limit.pressure - 1e-9) {
      danger.push('噴霧の運用下限未満（' + limit.pressure.toFixed(2) + ' MPa）');
    }
  }
  if (nozzle.p - path.target.p >= 0.0005) notes.push('目標圧力超過');
  if (path.target.q - nozzle.q >= 0.5) danger.push('目標流量未達');
  return { danger, notes };
}

function waterSource() {
  // Preserve suction settings saved before the source selector was introduced.
  return data.waterSource ?? (suctionHeights.includes(data.suctionHeight) ? 'draft' : '');
}

function waterSupplyCheck(result) {
  const source = waterSource();
  const suppliesWater = result.total > 0;
  if (source === 'hydrant') {
    const supplied = data.hydrantFlow;
    if (!Number.isFinite(supplied) || supplied < 0) {
      return { label: '消火栓', summary: '見込給水量未入力', shortage: false };
    }
    const difference = result.total - supplied;
    const shortage = suppliesWater && difference > 1e-6;
    const deficit = difference < 1 ? '1 L/min未満' : flowText(difference);
    const summary = '見込給水 ' + flowText(supplied)
      + (shortage ? ' ／ 給水不足の見込み ' + deficit : '');
    return { label: '消火栓', summary, shortage };
  }
  const height = data.suctionHeight;
  if (source !== 'draft' || !suppliesWater) return null;
  const count = data.suctionCount;
  const pipes = count === 1 ? '吸管1系統' : count === 2 ? '吸管2系統（並列）' : '吸管本数未設定';
  const lift = height * pressurePerMetre;
  const summary = suctionHeights.includes(height)
    ? '吸水 ' + height + ' m ／ 吸上げ分 ' + pressureText(lift)
      + (result.p > 0 ? ' ／ ポンプ差圧の目安 ' + pressureText(result.p + lift) + '（吸管損失除く）' : '')
    : '吸水高さ未設定';
  return { label: '無圧水利', shortage: false, summary: summary + ' ／ ' + pipes + ' ／ 送水可否は要確認' };
}

function pumpWarnings(result) {
  if (result.p <= 0) return '計算値が0 MPa以下。実測値を確認';
  if (result.total <= 0) return '';
  const warnings = [];
  // Standard A-2 test points at 3 m suction lift. No interpolation or vehicle capacity claim.
  const withinReference = (result.p <= 0.85 && result.total <= 2000)
    || (result.p <= 1.4 && result.total <= 1400);
  if (!withinReference) warnings.push('A-2級の規格試験点から送水可否を判断できない範囲');
  if (waterSource() === 'draft' && data.suctionHeight > 3) warnings.push('吸水高さが規格試験条件（3 m）超。実車の性能を確認');
  return warnings.join(' ／ ');
}

function equipmentChecks(result) {
  return result.equipment.map(({ type, location, pressure }) => {
    const specified = data.equipmentLimits?.[type];
    const custom = Number.isFinite(specified) && specified > 0;
    const limit = custom ? specified : equipmentPressureReferences[type];
    const exceeded = Number.isFinite(limit) && pressure > limit + 1e-9;
    const label = (equipmentTypes[type] ?? type + ' mmホース') + '（' + location + '）';
    const basis = custom ? '使用圧' : '警告参考値';
    const value = pressureText(pressure)
      + (Number.isFinite(limit) ? ' ／ ' + basis + ' ' + pressureText(limit) : ' ／ 使用圧未設定')
      + (exceeded ? ' ／ ' + basis + '超過' : '');
    return { label, value, exceeded, custom };
  });
}

const estimatedDischargeText = p => p > 0 ? pressureText(p) : '要実測';

function equipmentWarning(checks) {
  if (checks.some(check => check.exceeded && check.custom)) return '機材使用圧超過';
  if (checks.some(check => check.exceeded)) return '機材の警告参考値を超過';
  return '';
}

function responseSummary(container, solution, model) {
  const rows = [['対策後の必要吐出圧（試算）', estimatedDischargeText(solution.p)], ['総送水量の目安', flowText(solution.total)]];
  const water = waterSupplyCheck(solution);
  if (water) rows.push([water.label, water.summary, water.shortage]);
  for (const path of model.paths) {
    const nozzle = solution.nozzles[path.id];
    const warnings = outletWarnings(path, nozzle);
    const note = [...warnings.danger, ...warnings.notes].join(' ／ ');
    rows.push([path.name, flowText(nozzle.q) + ' ／ ' + pressureText(nozzle.p) + (note ? ' ／ ' + note : ''),
      warnings.danger.length > 0]);
  }
  for (const check of equipmentChecks(solution).filter(item => item.exceeded)) {
    rows.push([check.label, check.value, true]);
  }
  const list = document.createElement('dl');
  for (const [key, value, danger] of rows) {
    const label = document.createElement('dt');
    const result = document.createElement('dd');
    label.textContent = key;
    result.textContent = value;
    if (danger) result.className = 'danger';
    list.append(label, result);
  }
  container.append(list);
  if (pumpWarnings(solution)) container.append(text(pumpWarnings(solution)));
}

function openResponses(model) {
  const { baseline, candidate, reference, paths, lines } = model;
  $('response-quadra-note').hidden = !paths.some(path => path.branch.nozzle === 'クアドラ');
  $('response-quadra-note').textContent = 'クアドラ噴霧の運用下限 ' + quadraLimitText() + ' ／ 流量は暫定推定';
  const original = $('response-original');
  const warnings = paths.flatMap(path => {
    const status = outletWarnings(path, baseline.nozzles[path.id]);
    return [...status.danger, ...status.notes].map(message => path.name + ' ' + message);
  });
  warnings.push(...equipmentChecks(baseline).filter(item => item.exceeded)
    .map(item => item.label + ' ' + item.value));
  if (pumpWarnings(baseline)) warnings.unshift(pumpWarnings(baseline));
  const water = waterSupplyCheck(baseline);
  original.classList.toggle('response-warning', warnings.length > 0 || Boolean(water?.shortage));
  const before = model.fixed ? '据え置き試算（変更前の計算値）' : '現在の付設での試算';
  original.textContent = before + ' ' + estimatedDischargeText(baseline.p)
    + (water ? ' ／ ' + water.label + ' ' + water.summary : '')
    + (warnings.length ? ' ／ ' + warnings.join(' ／ ') : '');
  const targets = $('response-target');
  targets.replaceChildren(...paths.map(path => new Option(path.name, path.id)));
  targets.value = (paths.find(path => outletWarnings(path, baseline.nozzles[path.id]).danger.length)
    ?? paths.find(path => outletWarnings(path, candidate.nozzles[path.id]).danger.length)
    ?? paths.find(path => outletWarnings(path, baseline.nozzles[path.id]).notes.length) ?? reference).id;

  function showOptions() {
    const selected = paths[Number(targets.value)];
    const alternatives = $('response-diameters');
    alternatives.replaceChildren();
    if (selected.branch.nozzle === 'ダブコン') {
      const diameterBefore = Number(selected.branch.setting.split('/')[0]);
      for (const diameter of nozzleDiameters.filter(value => value !== diameterBefore)) {
        const proposed = qNozzle({ nozzle:'ダブコン', setting:diameter + '/' + selected.target.q });
        const newOutlet = {
          ...selected,
          target: proposed,
          nozzleCoefficient: proposed.p / proposed.q ** 2,
          reactionCoefficient: proposed.force / proposed.q ** 2
        };
        const changedPaths = paths.map(path => path.id === selected.id ? newOutlet : path);
        const changed = lines.map(line => ({...line, outlets:line.outlets.map(path => changedPaths[path.id])}));
        const newReference = pressureReference(changed, changedPaths);
        const solution = solve(changed, newReference);
        const item = document.createElement('details');
        const heading = document.createElement('summary');
        const nozzle = solution.nozzles[selected.id];
        const delta = Math.round(nozzle.q - selected.target.q);
        heading.textContent = diameter + ' mm ／ ' + flowText(nozzle.q)
          + '（目標差 ' + (delta > 0 ? '+' : '') + delta + ' L/min）'
          + (changedPaths.some(path => outletWarnings(path, solution.nozzles[path.id]).danger.length)
            || equipmentWarning(equipmentChecks(solution)) || waterSupplyCheck(solution)?.shortage
            || pumpWarnings(solution) ? ' ／ 要確認' : '');
        item.append(heading, text('対策後の圧力基準：' + newReference.name));
        responseSummary(item, solution, { paths: changedPaths });
        alternatives.append(item);
      }
    } else alternatives.textContent = '口径変更の試算はダブコンが対象です。';

    const throttle = $('response-throttle');
    throttle.replaceChildren();
    const adjusted = selected.id !== reference.id
      ? solve(lines, reference, selected.id) : null;
    if (adjusted && adjusted.nozzles[selected.id].available > selected.target.q + 0.01) {
      const line = lines.find(item => item.outlets.includes(selected));
      throttle.append(text('調整対象：' + selected.name + (line.fork ? '側の分岐' : 'の放口')));
      const shortfalls = paths.filter(path => path.target.q - adjusted.nozzles[path.id].q >= 0.5);
      if (shortfalls.length) {
        const warning = text('目標流量を維持できない筒先：' + shortfalls.map(path => path.name).join('、'));
        warning.classList.add('danger');
        throttle.append(warning);
      }
      responseSummary(throttle, adjusted, model);
      throttle.append(text('関係する筒先員と連携し、実測値を確認。総送水量は照合の目安です。'));
    } else throttle.textContent = '基準筒先の目標を保ったまま、この筒先を絞って目標流量に合わせる案は成立しません。';
  }
  $('response-reference').textContent = '現行付設の圧力基準：' + reference.name;
  targets.onchange = showOptions;
  showOptions();
  $('response').querySelectorAll('.response-options > details').forEach(panel => panel.open = false);
  $('response').querySelectorAll('input[type=checkbox]').forEach(input => input.checked = false);
  $('response').showModal();
}

function elevationLabel(value) {
  return (value > 0 ? '+' : value < 0 ? '−' : '') + Math.abs(value) + ' m';
}
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

function holdDisplayedPressure() {
  const before = calculate();
  if (!before.fixed && before.baseline?.p > 0) data.fixedPressure = before.baseline.p;
}

function toggleNozzle(branch) {
  holdDisplayedPressure();
  branch.stopped = !branch.stopped;
  save();
}

function render() {
  const result = calculate();
  const baseline = result.baseline;
  $('respond').hidden = !result.reference;
  $('respond').onclick = result.reference ? () => openResponses(result) : null;
  $('recalculate-pressure').hidden = !result.fixed;
  $('pump-heading').textContent = result.fixed ? '変更前の計算圧を据え置き（試算）' : '必要吐出圧力（推定）';
  const preview = $('pressure-preview');
  preview.hidden = !result.fixed || !result.candidate;
  $('pressure-preview-values').replaceChildren();
  if (!preview.hidden) {
    const pressure = $('pressure-preview-value');
    pressure.textContent = estimatedDischargeText(result.candidate.p);
    const warningCount = result.paths.filter(path =>
      outletWarnings(path, result.candidate.nozzles[path.id]).danger.length > 0).length;
    const gearWarning = equipmentWarning(equipmentChecks(result.candidate));
    const supplyWarning = waterSupplyCheck(result.candidate)?.shortage ? '消火栓の給水不足見込み' : '';
    pressure.classList.toggle('danger', Boolean(warningCount || gearWarning || supplyWarning));
    const warnings = [warningCount ? '目標と警戒条件が両立しない筒先 ' + warningCount + '口' : '',
      gearWarning, supplyWarning, pumpWarnings(result.candidate)].filter(Boolean);
    $('pressure-preview-warning').textContent = warnings.join(' ／ ');
    responseSummary($('pressure-preview-values'), result.candidate, result);
  }
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
        details.textContent = [line.fork && `${branch.diam} mm × ${branch.count}本`, branch.nozzle === 'クアドラ' ? 'クアドラ（噴霧）' : branch.nozzle, branch.setting].filter(Boolean).join('・');
        edit.append(details);
        if (branch.elevation) {
          const elevation = document.createElement('small');
          elevation.className = 'nozzle-elevation';
          elevation.textContent = '高低差 ' + elevationLabel(branch.elevation);
          edit.append(elevation);
        }
      }
      const path = result.paths.find(item => item.index === index && item.branchIndex === branchIndex);
      if (path) {
        const nozzle = baseline.nozzles[path.id];
        const warnings = outletWarnings(path, nozzle);
        const estimate = document.createElement('small');
        estimate.className = 'mixed-estimate';
        estimate.classList.toggle('danger', warnings.danger.length > 0);
        estimate.textContent = '推定 ' + flowText(nozzle.q) + ' ／ ' + pressureText(nozzle.p);
        edit.append(estimate);
        const note = [...warnings.danger, ...warnings.notes];
        if (note.length) {
          const warning = document.createElement('small');
          warning.className = warnings.danger.length ? 'mixed-estimate danger' : 'mixed-estimate target-note';
          warning.textContent = note.join(' ／ ');
          edit.append(warning);
        }
        if (!result.fixed && path.id === result.reference.id) {
          const basis = document.createElement('small');
          basis.className = 'pressure-basis';
          basis.textContent = '◆圧力基準';
          edit.append(basis);
        }
      }
      group.append(edit);
      if (branch.active && branch.setting) {
        const stop = control(branch.stopped ? '再開' : '停止', () => {
          toggleNozzle(branch);
          $(stop.id)?.focus();
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
  const pr = document.querySelector('.pressure');
  const pressurePaths = $('pressure-paths');
  pressurePaths.replaceChildren();
  $('pressure-details').hidden = !baseline;
  for (const path of result.paths) {
    const item = document.createElement('li');
    item.textContent = path.name + ' ／ 目標 ' + flowText(path.target.q) + ' ／ ' + pressureText(path.target.p)
      + (path.id === result.reference.id ? ' ／ 必要圧力の基準' : '')
      + (!path.branch.maxPressure ? ' ／ 圧力上限未設定' : ' ／ 圧力上限 ' + pressureText(path.branch.maxPressure))
      + (path.reactionCoefficient === null ? ' ／ 反動力未算出' : '');
    pressurePaths.append(item);
  }
  const configured = data.lines.some(line => line.active);
  pr.textContent = result.fixed ? pressureText(data.fixedPressure) : baseline ? estimatedDischargeText(baseline.p) : configured && result.stopped ? '放水停止' : '— MPa';
  pr.classList.toggle('danger', !!baseline && (baseline.p <= 0 || baseline.p > 1.4));
  $('total').textContent = baseline ? '推定総送水量：' + flowText(baseline.total) : result.ok ? '' : '設定未完了';
  const water = baseline ? waterSupplyCheck(baseline) : null;
  const supplyEstimate = $('supply-estimate');
  supplyEstimate.textContent = water ? water.label + ' ' + water.summary : '';
  supplyEstimate.classList.toggle('danger', Boolean(water?.shortage));
  const equipment = baseline ? equipmentChecks(baseline) : [];
  const gearWarning = equipmentWarning(equipment);
  $('equipment-details').hidden = !equipment.length;
  $('equipment-results').replaceChildren(...equipment.map(check => {
    const item = document.createElement('li');
    item.textContent = check.label + ' ／ ' + check.value;
    item.classList.toggle('danger', check.exceeded);
    return item;
  }));
  const alert = $('alert');
  const warningCount = baseline ? result.paths.filter(path =>
    outletWarnings(path, baseline.nozzles[path.id]).danger.length).length : 0;
  alert.classList.toggle('danger', Boolean(warningCount || gearWarning));
  const warnings = baseline ? [pumpWarnings(baseline), warningCount ? '筒先警告 ' + warningCount + '口' : '',
    gearWarning].filter(Boolean) : [];
  if (!result.fixed && warningCount) warnings.push('目標と警戒条件の両立を要確認');
  if (result.fixed && result.ok) warnings.push(result.stopped
    ? '全筒先停止中：実機の締切運転・過熱に注意'
    : '放水が安定した後の推定・水撃は計算対象外');
  alert.textContent = baseline ? warnings.join(' ／ ') || '概算値：筒先と連携して調整'
    : !result.ok ? '未入力の筒先・ホースがあります'
    : configured ? '全線停止中：必要圧力は算出しません' : '';
}
function updateLayout() {
  const height = Math.max(176, $('lines').offsetHeight);
  $('map').style.setProperty('--lines-height', height + 'px');
  $('map').style.setProperty('--truck-scale', String(176 / height));
  alignHoses();
}
function closeOverlay() { $('overlay').close(); }
function showPreviousLayout(line, index) {
  const panel = $('previous-layout');
  panel.hidden = !line.active;
  const nozzles = $('previous-nozzles');
  nozzles.replaceChildren();
  if (panel.hidden) return;

  const hose = (part) => part.diam + ' mm × ' + (part.count ?? '—') + '本';
  $('previous-main').textContent = ports[index].label + ' ／ ' + (line.fork ? '分岐前 ' : '')
    + hose(line) + ' ／ ' + (line.fork ? '分岐あり' : '直結');
  const branches = line.fork ? line.branches : line.branches.slice(0, 1);
  branches.forEach((branch, branchIndex) => {
    const item = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = line.fork ? (branchIndex === 0 ? '筒先 A' : '筒先 B') : '筒先';
    item.append(name);
    if (!branch.active) {
      item.append(' ／ 未設定');
      nozzles.append(item);
      return;
    }

    const details = [];
    if (line.fork) details.push(hose(branch));
    if (branch.setting) {
      const [range, value] = branch.setting.split('/');
      details.push(branch.nozzle === 'ダブコン'
        ? 'ダブコン ' + range + ' mm・目標 ' + value + ' L/min'
        : 'クアドラ（噴霧） ' + range + ' L/minレンジ・目標 ' + value + ' MPa');
    } else details.push('筒先設定なし');
    details.push('高低差 ' + elevationLabel(branch.elevation ?? 0));
    if (branch.maxPressure) details.push('圧力上限 ' + pressureText(branch.maxPressure));
    if (branch.stopped) details.push('停止中');
    item.append(' ／ ' + details.join(' ／ '));
    nozzles.append(item);
  });
}

function startEdit(index, branchIndex = null) {
  const line = data.lines[index];
  showPreviousLayout(line, index);
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
  const ceiling = $('nozzle-ceiling');
  if (ceiling && !ceiling.reportValidity()) return;
  if (ceiling) ctx.draft.branches[ctx.j ?? 0].maxPressure = ceiling.valueAsNumber || null;
  ctx.draft.active = true;
  ctx.draft.branches[ctx.j ?? 0].active = true;
  holdDisplayedPressure();
  data.lines[ctx.i] = ctx.draft;
  save();
  closeOverlay();
}
function choice(label,cb,sel=false,cls=''){const b=document.createElement('button');b.textContent=label;b.className=(sel?'selected ':'')+cls;b.onclick=cb;return b}
function grid(n){const d=document.createElement('div');d.className='choices '+({2:'two',3:'three',4:'four',5:'five',6:'six'}[n]);return d}
function text(s){const d=document.createElement('div');d.className='hint';d.textContent=s;return d}
function elevationControl(branch, canSave) {
  const group = document.createElement('div');
  group.className = 'elevation';
  const label = text('筒先との高低差');
  label.id = 'nozzle-elevation-label';
  const choices = document.createElement('div');
  choices.className = 'elevation-choices';
  choices.setAttribute('role', 'group');
  choices.setAttribute('aria-labelledby', label.id);
  for (const value of elevations) {
    const selected = value === (branch.elevation ?? 0);
    const button = choice(elevationLabel(value), () => {
      branch.elevation = value;
      if (canSave) finish();
      else draw();
    }, selected);
    button.setAttribute('aria-pressed', String(selected));
    choices.append(button);
  }
  group.append(label, choices, text('ポンプより高い場合は＋、低い場合は−'));
  return group;
}
function hoseControls(target, nextStep, allowLong) {
  const group = document.createElement('div');
  group.className = 'hose-controls';
  const diameters = grid(2);
  for (const diameter of [65, 50]) {
    diameters.append(choice(diameter + ' mm', () => {
      target.diam = diameter;
      draw();
    }, target.diam === diameter));
  }
  const counts = grid(5);
  for (let count = 1; count <= 10; count++) {
    counts.append(choice(count + ' 本', () => {
      target.count = count;
      advance(nextStep);
    }, target.count === count));
  }
  if (allowLong) {
    const entry = document.createElement('form');
    entry.className = 'long-hose-entry';
    entry.hidden = true;
    const label = document.createElement('label');
    label.textContent = '主線の本数（11本以上）';
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = '11';
    input.step = '1';
    input.required = true;
    if (target.count >= 11) input.value = target.count;
    const apply = document.createElement('button');
    apply.type = 'submit';
    apply.textContent = '決定';
    label.append(input);
    entry.append(label, apply);
    entry.onsubmit = event => {
      event.preventDefault();
      if (!Number.isSafeInteger(input.valueAsNumber)) {
        input.setCustomValidity('本数を整数で入力してください。');
        input.reportValidity();
        return;
      }
      target.count = input.valueAsNumber;
      advance(nextStep);
    };
    input.oninput = () => input.setCustomValidity('');
    const longer = choice(target.count >= 11 ? '11本以上（' + target.count + '本）' : '11本以上', () => {
      entry.hidden = false;
      input.focus();
    }, target.count >= 11);
    longer.type = 'button';
    counts.append(longer);
    group.append(entry);
  }
  for (const [label, choices] of [['ホース口径', diameters], ['本数（1本20m）', counts]]) {
    const field = document.createElement('div');
    field.className = 'hose-field';
    field.append(text(label), choices);
    group.append(field);
  }
  if (allowLong) group.append(group.querySelector(".long-hose-entry"));
  return group;
}
function draw(){const l=ctx.draft,b=l.branches[ctx.j??0],o=$('options');o.replaceChildren();o.scrollTop=0;$('overlay').classList.toggle('branch-hose-step', step === 2);$('title').textContent=`${ports[ctx.i].label}の放口 ${ctx.j===null?'主線':ctx.j?'筒先B':'筒先A'}｜${['① ホース口径・本数','② 分岐金具','③ 筒先側ホース口径・本数','④ 筒先種類','⑤ 筒先設定'][step]}`;$('back').hidden=step===(ctx.j===null?0:l.fork?2:3);
if ((l.fork && step === 2) || (!l.fork && step === 3)) {
  o.append(elevationControl(b, ctx.j !== null && b.active && Boolean(b.setting)));
}
if (step === 0 || step === 2) {
  o.append(hoseControls(step === 0 ? l : b, step === 0 ? 1 : 3, step === 0));
}
else if(step===1){const g=grid(2);g.append(choice('分岐金具 あり',()=>{l.fork=true;l.branches[0].active=true;advance(2)}),choice('分岐金具 なし',()=>{l.fork=false;l.branches[0].active=true;l.branches[1]=emptyBranch();advance(3)}));o.append(g)}
else if(step===3){const g=grid(2);for(const name of ['ダブコン','クアドラ'])g.append(choice(name,()=>{if(b.nozzle!==name){b.setting=null;b.maxPressure=null;}b.nozzle=name;partialDiameter=b.setting&&name==='ダブコン'?Number(b.setting.split('/')[0]):null;partialFlow=b.setting&&name==='クアドラ'?Number(b.setting.split('/')[0]):null;advance(4)}));o.append(g)}
else if(step===4){
const ceilingLabel = document.createElement('label');
ceilingLabel.className = 'nozzle-ceiling';
ceilingLabel.textContent = '機材・運用上の圧力上限（MPa・任意）';
const ceiling = document.createElement('input');
ceiling.id = 'nozzle-ceiling';
ceiling.type = 'number';
ceiling.inputMode = 'decimal';
ceiling.min = '0.001';
ceiling.step = 'any';
ceiling.value = b.maxPressure ?? '';
ceiling.oninput = () => { b.maxPressure = ceiling.valueAsNumber || null; };
ceilingLabel.append(ceiling);
o.append(ceilingLabel);
if(b.nozzle==='ダブコン'){o.append(text('口径（mm）'));const g=grid(6);for(const d of nozzleDiameters)g.append(choice(d+'',()=>{partialDiameter=d;draw()},partialDiameter===d));o.append(g,text('流量（L/min）／400を超えると注意。保持限界は流量だけでは決められません。'));const f=grid(5);for(const q of [300,400,500,600,700,800,900,1000,1100,1200])f.append(choice(q+'',()=>{if(partialDiameter===null)return;b.setting=partialDiameter+'/'+q;finish()},false,q>400?'caution':''));o.append(f,text(partialDiameter===null?'先に口径を選択してください':'流量を選ぶと設定を保存します。反動力は概算で別途警告します。'))}
else {
  const limit = quadraFogLimit();
  const ranges = grid(4);
  for (const range of quadraRanges) {
    ranges.append(choice(String(range), () => { partialFlow = range; draw(); },
      partialFlow === range, range < limit.range ? 'caution' : ''));
  }
  const pressures = [...new Set([0.5, 0.6, 0.7, limit.pressure])].sort((a, b) => a - b);
  const targets = grid(pressures.length);
  for (const pressure of pressures) {
    const button = choice(pressure.toFixed(2), () => {
      if (partialFlow === null) return;
      b.setting = partialFlow + '/' + pressure;
      finish();
    }, false, pressure < limit.pressure ? 'caution' : '');
    button.disabled = partialFlow === null;
    targets.append(button);
  }
  o.append(text('噴霧の流量レンジ（L/min）'), ranges, text('目標ノズル圧力（MPa）'), targets,
    text('運用下限 ' + quadraLimitText() + ' ／ 流量は暫定推定'));
}}
}
$('recalculate-pressure').onclick = () => {
  data.fixedPressure = null;
  save();
};
$('response-close').onclick = () => $('response').close();
const quadraDialog = $('quadra-settings');
const quadraRangeInput = $('quadra-range');
const quadraPressureInput = $('quadra-min-pressure');
quadraRangeInput.replaceChildren(...quadraRanges.map(range => new Option(String(range), String(range))));
$('edit-quadra-settings').onclick = () => {
  const limit = quadraFogLimit();
  quadraRangeInput.value = limit.range;
  quadraPressureInput.value = limit.pressure;
  quadraDialog.showModal();
};
$('quadra-settings-close').onclick = () => quadraDialog.close();
$('quadra-settings-defaults').onclick = () => {
  quadraRangeInput.value = defaultQuadraFogLimit.range;
  quadraPressureInput.value = defaultQuadraFogLimit.pressure;
};
$('quadra-settings-form').onsubmit = event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  data.quadraFogLimit = { range: Number(quadraRangeInput.value), pressure: quadraPressureInput.valueAsNumber };
  save();
  quadraDialog.close();
};
const waterDialog = $('water-settings');
const waterSourceInput = $('water-source');
const suctionInput = $('suction-height');
const suctionCountInput = $('suction-count');
const hydrantInput = $('hydrant-flow');
suctionInput.append(...suctionHeights.map(height => new Option(height + ' m', String(height))));
const equipmentInputs = [...document.querySelectorAll('[data-equipment]')];
for (const input of equipmentInputs) {
  input.placeholder = equipmentPressureReferences[input.dataset.equipment].toFixed(2);
}
function updateWaterSourceFields() {
  const source = waterSourceInput.value;
  $('draft-fields').hidden = suctionInput.disabled = suctionCountInput.disabled = source !== 'draft';
  $('hydrant-fields').hidden = hydrantInput.disabled = source !== 'hydrant';
}
waterSourceInput.onchange = updateWaterSourceFields;
$('edit-water-settings').onclick = () => {
  waterSourceInput.value = waterSource();
  suctionInput.value = data.suctionHeight ?? '';
  suctionCountInput.value = data.suctionCount ?? '';
  hydrantInput.value = data.hydrantFlow ?? '';
  for (const input of equipmentInputs) input.value = data.equipmentLimits?.[input.dataset.equipment] ?? '';
  updateWaterSourceFields();
  waterDialog.showModal();
};
$('water-settings-close').onclick = () => waterDialog.close();
$('water-settings-form').onsubmit = event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  data.waterSource = waterSourceInput.value;
  if (data.waterSource === 'draft') {
    data.suctionHeight = suctionInput.value === '' ? null : Number(suctionInput.value);
    data.suctionCount = suctionCountInput.value === '' ? null : Number(suctionCountInput.value);
  }
  if (data.waterSource === 'hydrant') data.hydrantFlow = hydrantInput.value === '' ? null : hydrantInput.valueAsNumber;
  data.equipmentLimits = Object.fromEntries(equipmentInputs.filter(input => input.value)
    .map(input => [input.dataset.equipment, input.valueAsNumber]));
  save();
  waterDialog.close();
};
save();

document.querySelectorAll('[data-port]').forEach(button => {
  button.onclick = () => startEdit(ports.findIndex(port => port.key === button.dataset.port));
});
$('flip').onclick = () => { data.flipped = !data.flipped; save(); };
$('close').onclick = closeOverlay;
$('back').onclick = back;
$('delete').onclick = () => {
  const { i } = ctx;
  if (!confirm(ports[i].label + 'のホースライン設定を削除しますか？')) return;
  holdDisplayedPressure();
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
  delete data.quadraFogLimit;
  delete data.waterSource;
  delete data.suctionHeight;
  delete data.suctionCount;
  delete data.hydrantFlow;
  delete data.equipmentLimits;
  Object.assign(data, { flipped: false, fixedPressure: null, lines: ports.map(emptyLine) });
  save();
};
new ResizeObserver(updateLayout).observe($('lines'));
window.addEventListener('resize', updateLayout);
