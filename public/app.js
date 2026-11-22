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
const parallelSuctionNote = '吸管2本の効果試算は未実装';
const equipmentTypes = {
  50: '50 mmホース', 65: '65 mmホース',
  fork: '分岐金具', coupling: '結合金具'
};
// Developer-maintained reference working pressures, not rupture or proof-test pressures.
const hosePressureReference = 1.3;
const defaultEquipmentLimits = {
  50: hosePressureReference, 65: hosePressureReference,
  fork: hosePressureReference, coupling: 1.3
};
const preferencesKey = 'pump-operation-preferences';
const nozzleFlowUnits = {
  'L/min': { divisor: 1, digits: 0 },
  'L/s': { divisor: 60, digits: 2 },
  'm³/min': { divisor: 1000, digits: 3 }
};

function readPreferences() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(preferencesKey)); } catch {}
  const equipmentLimits = { ...defaultEquipmentLimits };
  for (const key of Object.keys(equipmentLimits)) {
    const limit = saved?.equipmentLimits?.[key];
    if (Number.isFinite(limit) && limit > 0) equipmentLimits[key] = limit;
  }
  return {
    equipmentLimits,
    nozzleFlowUnit: Object.hasOwn(nozzleFlowUnits, saved?.nozzleFlowUnit)
      ? saved.nozzleFlowUnit : 'L/min'
  };
}

let preferences = readPreferences();
function persistPreferences() {
  try {
    localStorage.setItem(preferencesKey, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

function nozzleFlowValue(flow) {
  const { divisor, digits } = nozzleFlowUnits[preferences.nozzleFlowUnit];
  return String(Number((flow / divisor).toFixed(digits)));
}
const nozzleFlowText = flow => nozzleFlowValue(flow) + ' ' + preferences.nozzleFlowUnit;

const quadraRanges = [110, 230, 360, 470];
// NH-50QF nominal dial flow is specified at 0.70 MPa. Other pressures remain estimates.
const quadraFlowReferencePressure = 0.7;
const quadraFlowNote = 'NH-50QF：0.70 MPaでレンジ表示流量。その他の圧力では流量は概算';

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
    if (current?.lines?.length === ports.length) {
      delete current.fixedPressure;
      delete current.fixedPressureModel;
      return current;
    }
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
let adjustedPressure = 0;
let ctx = null, step = 0, partialDiameter = null, partialFlow = null;
const $ = id => document.getElementById(id);
function save() {
  try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch {}
  render();
}
function smoothNozzle(diameter, value, mode = 'flow') {
  if (!(diameter > 0 && value > 0)) return null;
  const area = Math.PI * (diameter / 1000) ** 2 / 4;
  const effectiveArea = 0.95 * area;
  const velocity = mode === 'pressure' ? Math.sqrt(2 * value * 1000) : value / (60000 * effectiveArea);
  const flow = mode === 'pressure' ? velocity * effectiveArea * 60000 : value;
  const pressure = mode === 'pressure' ? value : velocity ** 2 / 2000;
  return { q: flow, p: pressure, force: flow / 60000 * 1000 * velocity };
}

function qNozzle(branch) {
  if (!branch.nozzle || !branch.setting) return null;
  const [size, value] = branch.setting.split('/').map(Number);
  if (branch.nozzle === 'ダブコン') return smoothNozzle(size, value, branch.smoothMode);
  if (!(size > 0 && value > 0)) return null;
  return { q: size * Math.sqrt(value / quadraFlowReferencePressure), p: value, force: null };
}
function hoseLoss(d,n,q){if(!(d>0&&n>=0&&q>=0))return 0;const area=Math.PI*(d/1000)**2/4,v=q/60000/area;return 0.025*(n*20)/(d/1000)*1000*v*v/2/1e6}

const nozzleDiameters = [10, 13, 15, 19, 23, 26];
const reactionReference = 200;
const smoothTwoPersonReactionReference = 300;
const smoothPressures = Array.from({ length: 11 }, (_, index) => (20 + 5 * index) / 100);
const smoothFlowCandidates = Array.from({ length: 21 }, (_, index) => 100 + 50 * index);
const lowFlowFraction = 0.8;
const pressureText = p => p.toFixed(3) + ' MPa';
const flowText = q => Math.round(q) + ' L/min';
const estimatedPressureText = p => p.toFixed(1) + ' MPa';
const roundEstimatedFlow = q => Math.round(q / 10) * 10;
const estimatedFlowText = q => roundEstimatedFlow(q) + ' L/min';

function nozzleName(index, branchIndex, fork) {
  return ports[index].label + '・筒先' + (fork ? (branchIndex ? ' B' : ' A') : '');
}

function calculate(configuredLines = data.lines) {
  const paths = [];
  const lines = [];
  let missing = false;
  configuredLines.forEach((line, index) => {
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
      fork: line.fork, index, name: ports[index].label, diameter: line.diam
    });
  });
  if (missing || !paths.length) return { ok: !missing, paths: [] };

  const reference = pressureReference(lines, paths);
  return { ok: true, paths, lines, reference };
}

function isSmoothFlowCandidate(draft, lineIndex, branchIndex, diameter, flow) {
  const nozzle = smoothNozzle(diameter, flow);
  if (!nozzle || nozzle.p > smoothPressures.at(-1)) return false;

  const lines = ports.map(emptyLine);
  lines[lineIndex] = {
    ...draft,
    active: true,
    branches: draft.branches.map((branch, index) => index === branchIndex
      ? { ...branch, active: true, stopped: false, nozzle: 'ダブコン', smoothMode: 'flow', setting: diameter + '/' + flow }
      : branch)
  };
  const setup = calculate(lines);
  if (!setup.ok) return false;
  const outlet = setup.paths.find(path => path.branchIndex === branchIndex);
  const pressure = Math.max(0, requiredPressure(setup.lines, outlet));
  return !equipmentChecks(solve(setup.lines, pressure)).some(check => check.exceeded);
}

function outletFlow(path, head) {
  return Math.sqrt(Math.max(0, head - path.elevation) / (path.nozzleCoefficient + path.hoseCoefficient));
}

function requiredPressure(lines, reference) {
  const line = lines.find(item => item.outlets.some(path => path.id === reference.id));
  const selected = line.outlets.find(path => path.id === reference.id);
  const head = selected.elevation + (selected.nozzleCoefficient + selected.hoseCoefficient) * selected.target.q ** 2;
  const total = line.outlets.reduce((sum, path) =>
    sum + outletFlow(path, head), 0);
  return head + line.fitting + line.loss * total ** 2;
}

function pressureReference(lines, paths) {
  const quadra = paths.filter(path => path.branch.nozzle === 'クアドラ');
  const candidates = quadra.length ? quadra : paths;
  // Compare pump-side requirements, including the loss on each line.
  return candidates.reduce((best, path) =>
    requiredPressure(lines, path) > requiredPressure(lines, best) ? path : best);
}

function solve(lines, p) {
  const nozzles = [];
  const equipment = [];
  if (p === 0) {
    for (const line of lines) {
      for (const path of line.outlets) {
        nozzles[path.id] = { q: 0, p: 0, force: path.reactionCoefficient === null ? null : 0 };
      }
    }
    return { p, nozzles, equipment, total: 0 };
  }
  for (const line of lines) {
    // At a common supply pressure, the flow through the main hose is the sum of its branches.
    let upper = p - line.fitting;
    let lower = Math.min(upper, ...line.outlets.map(path => path.elevation));
    const sumAt = head => line.outlets.reduce((sum, path) =>
      sum + outletFlow(path, head), 0);
    for (let i = 0; i < 48; i++) {
      const head = (lower + upper) / 2;
      if (head + line.loss * sumAt(head) ** 2 > p - line.fitting) upper = head;
      else lower = head;
    }
    const head = (lower + upper) / 2;
    const couplingPressures = [];
    for (const path of line.outlets) {
      const q = outletFlow(path, head);
      nozzles[path.id] = {
        q, p: path.nozzleCoefficient * q ** 2,
        force: path.reactionCoefficient === null ? null : path.reactionCoefficient * q ** 2
      };
      if (line.fork) {
        const end = nozzles[path.id].p;
        const maximum = Math.max(head, end);
        equipment.push({ type: path.branch.diam, index: line.index, branchIndex: path.branchIndex,
          location: path.name + '側', pressure: maximum });
        couplingPressures.push(maximum);
      }
    }
    const mainEnd = line.fork ? head + line.fitting : nozzles[line.outlets[0].id].p;
    const mainMaximum = Math.max(p, mainEnd);
    equipment.push({ type: line.diameter, index: line.index, branchIndex: null,
      location: line.name + '・主線', pressure: mainMaximum });
    if (line.fork) equipment.push({ type: 'fork', index: line.index, branchIndex: null, location: line.name + '・分岐', pressure: mainEnd });
    equipment.push({
      type: 'coupling', index: line.index, branchIndex: null, location: line.name + '・ライン全体',
      pressure: Math.max(mainMaximum, ...couplingPressures)
    });
  }
  return { p, nozzles, equipment, total: nozzles.reduce((sum, nozzle) => sum + nozzle.q, 0) };
}

function outletWarnings(nozzle, target) {
  const danger = [];
  const low = [];
  if (nozzle.force !== null && nozzle.force >= reactionReference) {
    danger.push('反動力注意 ' + Math.round(nozzle.force) + ' N（参考値200 N）');
  }
  if (nozzle.q === 0) low.push('放水見込みなし');
  else if (nozzle.q < target.q * lowFlowFraction) low.push('設定流量の80％未満');
  return { danger, low };
}

function appendOutletWarnings(container, warnings) {
  const groups = [
    ['danger', '↑ ', warnings.danger],
    ['low-output', '↓ ', warnings.low]
  ];
  for (const [color, direction, messages] of groups) {
    if (!messages.length) continue;
    const status = document.createElement('span');
    status.className = 'outlet-warning ' + color;
    status.textContent = direction + messages.join(' ／ ');
    container.append(status);
  }
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
      + (result.p > 0 ? ' ／ ポンプ差圧の目安 ' + estimatedPressureText(result.p + lift) + '（吸管損失除く）' : '')
    : '吸水高さ未設定';
  return { label: '無圧水利', shortage: false,
    summary: [summary, pipes, count === 2 ? parallelSuctionNote : '', '送水可否は要確認']
      .filter(Boolean).join(' ／ ') };
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
  return result.equipment.map(({ type, index, branchIndex, location, pressure }) => {
    const limit = preferences.equipmentLimits[type];
    const exceeded = Number.isFinite(limit) && pressure > limit + 1e-9;
    const label = (equipmentTypes[type] ?? type + ' mmホース') + '（' + location + '）';
    const value = estimatedPressureText(pressure)
      + (Number.isFinite(limit) ? ' ／ 警告参考値 ' + pressureText(limit) : ' ／ 使用圧未設定')
      + (exceeded ? ' ／ 警告参考値超過' : '');
    return { label, value, exceeded, index, branchIndex };
  });
}

function showHoseWarning(button, checks, index, branchIndex) {
  const exceeded = checks.filter(check =>
    check.exceeded && check.index === index && check.branchIndex === branchIndex);
  if (!exceeded.length) return;
  button.classList.add('hose-pressure-warning', 'flash-over');
  const label = document.createElement('small');
  label.textContent = exceeded.map(check => check.label + 'の警告参考値超過').join(' ／ ');
  button.append(label);
}

function equipmentWarning(checks) {
  if (checks.some(check => check.exceeded)) return '機材の警告参考値を超過';
  return '';
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

function toggleNozzle(branch) {
  branch.stopped = !branch.stopped;
  save();
}

function render() {
  const result = calculate();
  const solution = result.paths.length ? solve(result.lines, adjustedPressure) : null;
  let hasLowOutput = false;
  let hasHighReaction = false;
  $('deck').classList.toggle('flipped', Boolean(data.flipped));
  $('flip').setAttribute('aria-pressed', String(Boolean(data.flipped)));
  const equipment = solution ? equipmentChecks(solution) : [];
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
    showHoseWarning(main, equipment, index, null);
    const branches = document.createElement('div');
    branches.className = 'branches';

    allowed.forEach((branch, branchIndex) => {
      const name = line.fork ? (branchIndex === 0 ? '筒先 A' : '筒先 B') : '筒先';
      const group = document.createElement('div');
      group.className = line.fork ? 'branch with-hose' : 'branch';
      if (line.fork) {
        const branchLabel = branchIndex === 0 ? 'A' : 'B';
        const hoseEdit = control('枝線 ' + branchLabel, () => startEdit(index, branchIndex, 'hose'),
          label + 'の枝線 ' + branchLabel + 'を編集');
        const hoseDetails = document.createElement('small');
        hoseDetails.textContent = branch.count ? branch.diam + ' mm × ' + branch.count + '本' : '本数未設定';
        hoseEdit.append(hoseDetails);
        showHoseWarning(hoseEdit, equipment, index, branchIndex);
        group.append(hoseEdit);
      }
      const edit = control(branch.active ? name : '＋ ' + name + 'を追加',
        () => startEdit(index, branchIndex), label + 'の' + name + (branch.active ? 'を編集' : 'を追加'));
      if (branch.active) {
        const details = document.createElement('small');
        const [size, target] = (branch.setting ?? '').split('/');
        details.textContent = !branch.setting ? '筒先設定なし' : branch.nozzle === 'クアドラ'
          ? 'クアドラ ' + nozzleFlowText(Number(size)) + 'レンジ・' + Number(target).toFixed(2) + ' MPa'
          : 'ダブコン ' + size + ' mm・' + (branch.smoothMode === 'pressure'
            ? Number(target).toFixed(2) + ' MPa' : nozzleFlowText(Number(target)));
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
        const nozzle = solution.nozzles[path.id];
        const warnings = outletWarnings(nozzle, path.target);
        if (warnings.danger.length) {
          hasHighReaction = true;
          edit.classList.add('flash-over');
        }
        if (warnings.low.length) {
          hasLowOutput = true;
          edit.classList.add('flash-under');
        }
        const estimate = document.createElement('small');
        estimate.className = 'mixed-estimate';
        if (warnings.danger.length && !warnings.low.length) estimate.classList.add('danger');
        if (warnings.low.length && !warnings.danger.length) estimate.classList.add('low-output');
        estimate.textContent = '推定 ' + nozzleFlowText(roundEstimatedFlow(nozzle.q)) + ' ／ ' + nozzle.p.toFixed(2) + ' MPa';
        edit.append(estimate);
        const warning = document.createElement('small');
        warning.className = 'mixed-estimate';
        appendOutletWarnings(warning, warnings);
        if (warning.childElementCount) edit.append(warning);
        if (path.id === result.reference.id && adjustedPressure > 0 &&
            adjustedPressure === requiredPressure(result.lines, result.reference)) {
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
  const configured = data.lines.some(line => line.active);
  pr.textContent = estimatedPressureText(adjustedPressure);
  pr.classList.toggle('danger', adjustedPressure > 1.4);
  $('throttle').disabled = !result.ok;
  $('total').hidden = !solution;
  $('total-value').textContent = solution ? estimatedFlowText(solution.total) : '';
  $('total-status').hidden = result.ok;
  const water = solution ? waterSupplyCheck(solution) : null;
  const supplyEstimate = $('supply-estimate');
  supplyEstimate.textContent = water ? water.label + ' ' + water.summary : '';
  supplyEstimate.classList.toggle('danger', Boolean(water?.shortage));
  const gearWarning = equipmentWarning(equipment);
  const alert = $('alert');
  alert.classList.toggle('danger', Boolean(gearWarning));
  const warnings = solution ? [adjustedPressure > 0 ? pumpWarnings(solution) : '', gearWarning].filter(Boolean) : [];
  const hasOver = Boolean(gearWarning) || hasHighReaction || adjustedPressure > 1.4;
  $('throttle').classList.toggle('flash-over', hasOver);
  $('throttle').classList.toggle('flash-under', hasLowOutput);
  $('throttle').setAttribute('aria-label', ['スロットル調整',
    hasOver ? '超過警告あり' : '', hasLowOutput ? '圧力不足あり' : ''].filter(Boolean).join('、'));
  alert.textContent = solution ? warnings.join(' ／ ')
    : !result.ok ? '未入力の筒先・ホースがあります'
    : configured ? '全線停止中' : '';
}
function updateLayout() {
  const map = $('map');
  map.style.setProperty('--lines-height', $('lines').offsetHeight + 'px');
  map.style.setProperty('--truck-scale', String(176 / map.offsetHeight));
  alignHoses();
}
function closeOverlay() { $('overlay').close(); }
function startEdit(index, branchIndex = null, mode = 'nozzle') {
  const line = data.lines[index];
  step = branchIndex === null ? 0 : mode === 'hose' ? 2 : 3;
  ctx = { i: index, j: branchIndex, mode, firstStep: step, draft: structuredClone(line) };
  $('delete').hidden = !line.active || branchIndex !== null;
  draw();
  $('overlay').showModal();
  $('close').focus();
}
function back() {
  const { draft, firstStep } = ctx;
  if (step === firstStep) { closeOverlay(); return; }
  if (step === 3 && !draft.fork) step = 1;
  else step--;
  draw();
}
function advance(next) { step = next; draw(); }
function finish() {
  ctx.draft.active = true;
  if (ctx.mode !== 'hose') ctx.draft.branches[ctx.j ?? 0].active = true;
  data.lines[ctx.i] = ctx.draft;
  save();
  closeOverlay();
}
function choice(label, handler, selected = null, className = '') {
  const button = control(label, handler);
  if (className) button.classList.add(className);
  if (selected !== null) button.setAttribute('aria-pressed', String(selected));
  return button;
}

function updateSelectedField(field) {
  if (field.matches('select, input[type=number]')) {
    field.classList.toggle('selected', field.value !== '' && field.validity.valid);
  }
}

for (const id of ['overlay', 'water-settings']) {
  $(id).addEventListener('input', event => updateSelectedField(event.target));
  $(id).addEventListener('change', event => updateSelectedField(event.target));
}
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
    choices.append(button);
  }
  group.append(label, choices, text('ポンプより高い場合は＋、低い場合は−'));
  return group;
}
function hoseControls(target, onCount, allowLong) {
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
      onCount();
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
    updateSelectedField(input);
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
      onCount();
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
function draw() {
  const { draft: line, j, i, mode, firstStep } = ctx;
  const b = line.branches[j ?? 0];
  const o = $('options');
  o.replaceChildren();
  o.scrollTop = 0;
  $('overlay').classList.toggle('branch-hose-step', step === 2);
  const name = j === null ? '主線' : line.fork ? (j === 0 ? 'A' : 'B') : '直結';
  const titles = ['ホース口径・本数', '分岐金具', '枝線の口径・本数', '筒先種類', '筒先設定'];
  $('title').textContent = ports[i].label + 'の放口 ' + name + '｜' + titles[step];
  $('back').hidden = step === firstStep;

  if (step === 0 || step === 2) {
    const onCount = mode === 'hose' ? finish : () => advance(step === 0 ? 1 : 3);
    o.append(hoseControls(step === 0 ? line : b, onCount, step === 0));
    return;
  }
  if (step === 1) {
    const branches = grid(2);
    branches.append(
      choice('分岐金具 あり', () => {
        line.fork = true;
        line.branches[0].active = true;
        advance(2);
      }, line.fork === true),
      choice('分岐金具 なし', () => {
        line.fork = false;
        line.branches[0].active = true;
        line.branches[1] = emptyBranch();
        advance(3);
      }, line.fork === false)
    );
    o.append(branches);
    return;
  }
  if (step === 3) {
    o.append(elevationControl(b, j !== null && b.active && Boolean(b.setting)));
    const nozzles = grid(2);
    for (const nozzle of ['ダブコン', 'クアドラ']) {
      nozzles.append(choice(nozzle, () => {
        if (b.nozzle !== nozzle) {
          b.setting = null;
          delete b.smoothMode;
        }
        ctx.smoothMode = b.smoothMode ?? 'flow';
        b.nozzle = nozzle;
        const [size] = (b.setting ?? '').split('/');
        partialDiameter = size && nozzle === 'ダブコン' ? Number(size) : null;
        partialFlow = size && nozzle === 'クアドラ' ? Number(size) : null;
        advance(4);
      }, b.nozzle === nozzle));
    }
    o.append(nozzles);
    return;
  }

const [, savedValue] = (b.setting ?? '').split('/').map(Number);
if (b.nozzle === 'ダブコン') {
  const diameters = grid(6);
  for (const diameter of nozzleDiameters) {
    diameters.append(choice(String(diameter), () => { partialDiameter = diameter; draw(); },
      partialDiameter === diameter));
  }
  const pressureMode = ctx.smoothMode === 'pressure';
  const modeButton = control(pressureMode ? 'ノズル圧力（MPa）' : '流量（' + preferences.nozzleFlowUnit + '）', () => {
    ctx.smoothMode = pressureMode ? 'flow' : 'pressure';
    draw();
    $('smooth-mode').focus();
  }, pressureMode ? 'ノズル圧力から流量に切り替え' : '流量からノズル圧力に切り替え');
  modeButton.id = 'smooth-mode';
  const values = grid(5);
  const candidates = pressureMode ? smoothPressures : smoothFlowCandidates.filter(flow =>
    isSmoothFlowCandidate(ctx.draft, ctx.i, ctx.j ?? 0, partialDiameter, flow));
  for (const value of candidates) {
    const nozzle = smoothNozzle(partialDiameter, value, ctx.smoothMode);
    const selected = partialDiameter === Number(b.setting?.split('/')[0])
      && ctx.smoothMode === (b.smoothMode ?? 'flow') && savedValue === value;
    const button = choice(pressureMode ? value.toFixed(2) : nozzleFlowValue(value), () => {
      b.setting = partialDiameter + '/' + value;
      b.smoothMode = ctx.smoothMode;
      finish();
    }, selected, !pressureMode && nozzle?.force > smoothTwoPersonReactionReference
      ? 'high-reaction' : nozzle?.force >= reactionReference ? 'caution' : '');
    if (button.classList.contains('high-reaction')) {
      button.setAttribute('aria-label', nozzleFlowText(value) + '、反動力注意');
    }
    button.disabled = partialDiameter === null;
    values.append(button);
  }
  o.append(text('口径（mm）'), diameters, modeButton, values);
  if (partialDiameter === null) o.append(text('先に口径を選択してください'));
  else if (!pressureMode && !candidates.length) {
    o.append(text('この口径・付設条件で表示できる流量候補がありません。'));
  } else if (!pressureMode) {
    o.append(text('赤：推定反動力が2人保持の参考値（300 N）を超過'));
  }
}
else {
  const ranges = grid(4);
  for (const range of quadraRanges) {
    ranges.append(choice(nozzleFlowValue(range), () => { partialFlow = range; draw(); },
      partialFlow === range));
  }
  const pressures = [...new Set([0.5, 0.6, 0.7, savedValue].filter(Number.isFinite))].sort((a, b) => a - b);
  const targets = grid(pressures.length);
  for (const pressure of pressures) {
    const button = choice(pressure.toFixed(2), () => {
      if (partialFlow === null) return;
      b.setting = partialFlow + '/' + pressure;
      finish();
    }, pressure === savedValue);
    button.disabled = partialFlow === null;
    targets.append(button);
  }
  o.append(text('噴霧の流量レンジ（' + preferences.nozzleFlowUnit + '）'), ranges, text('目標ノズル圧力（MPa）'), targets,
    text(quadraFlowNote));
}
}
const preferencesDialog = $('preferences');
const preferencesForm = $('preferences-form');
const preferencesStatus = $('preferences-status');
const limitInputs = Object.keys(defaultEquipmentLimits).map(key => [key, $('limit-' + key)]);

function fillPreferencesForm(settings) {
  $('nozzle-flow-unit').value = settings.nozzleFlowUnit;
  for (const [key, input] of limitInputs) input.value = settings.equipmentLimits[key];
}

$('edit-preferences').onclick = () => {
  fillPreferencesForm(preferences);
  preferencesStatus.textContent = '';
  preferencesDialog.showModal();
};
$('close-preferences').onclick = () => preferencesDialog.close();
$('reset-preferences').onclick = () => {
  if (!confirm('流量単位と器具の圧力警告値を初期値に戻しますか？')) return;
  preferences = { equipmentLimits: { ...defaultEquipmentLimits }, nozzleFlowUnit: 'L/min' };
  fillPreferencesForm(preferences);
  preferencesStatus.textContent = persistPreferences()
    ? '設定を初期化しました' : 'この画面では初期化しました。端末への保存ができませんでした。';
  render();
};
preferencesForm.onsubmit = event => {
  event.preventDefault();
  if (!preferencesForm.reportValidity()) return;
  const unit = $('nozzle-flow-unit').value;
  const equipmentLimits = Object.fromEntries(limitInputs.map(([key, input]) => [key, input.valueAsNumber]));
  if (!Object.hasOwn(nozzleFlowUnits, unit) ||
      Object.values(equipmentLimits).some(limit => !Number.isFinite(limit) || limit <= 0)) {
    preferencesStatus.textContent = '圧力警告値には0より大きい数値を入力してください。';
    return;
  }
  preferences = { equipmentLimits, nozzleFlowUnit: unit };
  const persisted = persistPreferences();
  render();
  if (persisted) preferencesDialog.close();
  else preferencesStatus.textContent = 'この画面に反映しました。端末への保存ができませんでした。';
};

const waterDialog = $('water-settings');
const waterSourceInput = $('water-source');
const suctionInput = $('suction-height');
const suctionCountInput = $('suction-count');
const suctionCountNote = $('suction-count-note');
suctionCountNote.textContent = parallelSuctionNote;
suctionCountInput.onchange = () => {
  suctionCountNote.hidden = suctionCountInput.value !== '2';
};
const hydrantInput = $('hydrant-flow');
suctionInput.append(...suctionHeights.map(height => new Option(height + ' m', String(height))));
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
  suctionCountInput.onchange();
  hydrantInput.value = data.hydrantFlow ?? '';
  updateWaterSourceFields();
  [waterSourceInput, suctionInput, suctionCountInput, hydrantInput].forEach(updateSelectedField);
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
  save();
  waterDialog.close();
};
save();

document.querySelectorAll('[data-port]').forEach(button => {
  button.onclick = () => startEdit(ports.findIndex(port => port.key === button.dataset.port));
});
$('throttle').onclick = () => {
  const result = calculate();
  if (!result.ok) return;
  adjustedPressure = result.reference ? Math.max(0, requiredPressure(result.lines, result.reference)) : 0;
  render();
};
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
  adjustedPressure = 0;
  delete data.quadraFogLimit;
  delete data.waterSource;
  delete data.suctionHeight;
  delete data.suctionCount;
  delete data.hydrantFlow;
  delete data.equipmentLimits;
  Object.assign(data, { flipped: false, lines: ports.map(emptyLine) });
  save();
};
new ResizeObserver(updateLayout).observe($('lines'));
window.addEventListener('resize', updateLayout);
