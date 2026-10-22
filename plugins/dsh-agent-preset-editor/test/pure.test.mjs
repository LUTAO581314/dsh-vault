// 纯函数测试：直接从 client.js / index.js 里抽出函数体求值。
//
// 为什么这么做：客户端半是 `window.__ModuleLoader__.load({ factory(require) })` 的单文件形态，
// 没法 import；但里面那些判断逻辑（范围匹配、分类、skill 解析、官方段识别）是纯函数，
// 抽出来就能在没有浏览器的情况下验证。这比"改完让用户重启看结果"可靠得多。
//
// 用法：node test/pure.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSrc = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');
const hostSrc = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8');

/** 从源码里抠出一个具名函数的完整文本（按花括号配平）。 */
function extractFunction(source, name) {
  const pattern = new RegExp(`function\\s+${name}\\s*\\(`);
  const match = pattern.exec(source);
  if (match === null) throw new Error(`function ${name} not found`);
  let depth = 0;
  let started = false;
  for (let i = match.index; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      depth += 1;
      started = true;
    } else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return source.slice(match.index, i + 1);
    }
  }
  throw new Error(`function ${name} unbalanced`);
}

/** 把若干函数 + 依赖常量拼成一个可求值的模块，返回其中的函数。 */
function load(source, names, constants = {}) {
  const constDecls = Object.entries(constants)
    .map(([key, value]) => `const ${key} = ${JSON.stringify(value)};`)
    .join('\n');
  const fnDecls = names.map((name) => extractFunction(source, name)).join('\n');
  const exportsObj = names.map((name) => `${name}: ${name}`).join(', ');
  const body = `${constDecls}\n${fnDecls}\nreturn { ${exportsObj} };`;
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

const DEFAULT_SEED_HINT = '.psx-section';

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    return;
  }
  failures.push(`${label}\n    expected: ${e}\n    actual:   ${a}`);
}

function ok(label, condition) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${label} (expected truthy)`);
}

// ---- client.js：范围匹配 ----
{
  const { appliesTo } = load(clientSrc, ['appliesTo']);
  const entry = (presets) => ({ presets });

  ok('全部 preset 命中任意 id', appliesTo(entry('*'), 'standard'));
  ok('undefined presets 视为全部', appliesTo(entry(undefined), 'cordis'));
  ok('数组包含即命中', appliesTo(entry(['standard', 'ptc']), 'ptc'));
  ok('数组不包含则不命中', appliesTo(entry(['standard']), 'cordis') === false);
  ok('感叹号排除', appliesTo(entry('!cordis'), 'standard'));
  ok('感叹号排除命中的那个', appliesTo(entry('!cordis'), 'cordis') === false);
  ok('数组里的感叹号排除', appliesTo(entry(['*', '!cordis']), 'standard'));
  ok('数组里的感叹号排除 cordis', appliesTo(entry(['*', '!cordis']), 'cordis') === false);
}

// ---- client.js：官方段识别 ----
{
  const { isOfficialSection } = load(clientSrc, ['isOfficialSection'], {
    OFFICIAL_SECTION_PATTERN: null,
  }).constructor === Object ? (() => {
    // 常量是正则，不能走 JSON，单独构造
    const src = extractFunction(clientSrc, 'isOfficialSection');
    const pattern = /const OFFICIAL_SECTION_PATTERN\s*=\s*(\/(?:[^/\\]|\\.)+\/[a-z]*);/.exec(clientSrc);
    if (pattern === null) throw new Error('OFFICIAL_SECTION_PATTERN not found');
    // eslint-disable-next-line no-new-func
    return new Function(`const OFFICIAL_SECTION_PATTERN = ${pattern[1]};\n${src}\nreturn { isOfficialSection };`)();
  })() : null;

  ok('harness:identity 是官方段', isOfficialSection('harness:identity', []));
  ok('tool:read 是官方段', isOfficialSection('tool:read', []));
  ok('deployment:persona-prefix 是官方段', isOfficialSection('deployment:persona-prefix', []));
  ok('plan:policy 是官方段', isOfficialSection('plan:policy', []));
  ok('pack:base 不是官方段', isOfficialSection('pack:base', []) === false);
  ok('基线命中即官方段', isOfficialSection('my:custom', ['my:custom']));
  ok('空串不是官方段', isOfficialSection('', []) === false);
  ok('非字符串不是官方段', isOfficialSection(null, []) === false);
}

// ---- client.js：skill 配置解析 ----
{
  const { extractSkillConfig } = load(clientSrc, ['extractSkillConfig'], {
    SKILL_PLUGIN: '@deepseek-ai/dsh-skill-filesystem',
  });

  const withPlugin = `- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'\n  config:\n    includeDefaultRoots: false\n    customSkillDirs:\n      - D:/skills`;
  const parsed = extractSkillConfig(withPlugin);
  ok('找到 skill-filesystem', parsed.found === true);
  ok('读到 includeDefaultRoots=false', parsed.includeDefaultRoots === false);
  check('读到自定义目录', parsed.customSkillDirs, ['D:/skills']);

  const without = `- id: other\n  name: '@deepseek-ai/dsh-other'`;
  ok('没挂载时 found=false', extractSkillConfig(without).found === false);
  ok('空内容不崩', extractSkillConfig('').found === false);
  ok('null 不崩', extractSkillConfig(null).found === false);
}

// ---- host：catalog 过滤 ----
{
  const { filterCatalogText } = load(hostSrc, ['filterCatalogText']);
  const catalog = [
    'A skill is a reusable set of instructions.',
    '',
    '<available_skills>',
    '- `office`: 处理 Office 文档',
    '- `office-xlsx`: 处理表格',
    '- `investment-research`: 投研',
    '</available_skills>',
  ].join('\n');

  const filtered = filterCatalogText(catalog, new Set(['office-xlsx']));
  ok('被禁用的行消失', filtered.includes('office-xlsx') === false);
  ok('其他行保留', filtered.includes('`office`') && filtered.includes('investment-research'));
  ok('没有禁用项时原样返回', filterCatalogText(catalog, new Set()) === catalog);
}

// ---- host：审计缓存的 key ----
{
  const { auditKey } = load(hostSrc, ['auditKey']);
  const a = auditKey([{ moduleName: 'a', enabled: true }, { moduleName: 'b', enabled: false }]);
  const b = auditKey([{ moduleName: 'b', enabled: false }, { moduleName: 'a', enabled: true }]);
  const c = auditKey([{ moduleName: 'a', enabled: false }, { moduleName: 'b', enabled: false }]);
  ok('顺序无关', a === b);
  ok('状态不同则 key 不同', a !== c);
  ok('空清单不崩', typeof auditKey([]) === 'string');
  ok('undefined 不崩', typeof auditKey(undefined) === 'string');
}

// ---- host：删除段 ----
{
  const { applyRemovals } = load(hostSrc, ['applyRemovals'], {});
  // applyRemovals 依赖 appliesTo，运行时注入
  const { appliesTo } = load(clientSrc, ['appliesTo']);
  const src = extractFunction(hostSrc, 'applyRemovals');
  // eslint-disable-next-line no-new-func
  const { applyRemovals: run } = new Function(
    `const appliesTo = ${appliesTo.toString()};\n${src}\nreturn { applyRemovals };`,
  )();

  const sections = [{ name: 'tool:read' }, { name: 'pack:base' }, { name: 'plan:policy' }];
  const mods = [{ id: 'm1', section: 'tool:read', mode: 'remove', enabled: true, presets: '*' }];
  const out = run(mods, 'standard', sections);
  check('删除命中的段', out.map((s) => s.name), ['pack:base', 'plan:policy']);
  ok('没命中时返回原数组', run([], 'standard', sections) === sections);

  const scoped = [{ id: 'm2', section: 'plan:policy', mode: 'remove', enabled: true, presets: ['ptc'] }];
  check('范围不匹配时不删除', run(scoped, 'standard', sections).map((s) => s.name), ['tool:read', 'pack:base', 'plan:policy']);

  const disabled = [{ id: 'm3', section: 'plan:policy', mode: 'remove', enabled: false, presets: '*' }];
  check('停用的模块不生效', run(disabled, 'standard', sections).length, 3);
}

// ---- 一致性：host 与 client 的范围判定必须一字不差 ----
{
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ').trim();
  const clientFn = strip(extractFunction(clientSrc, 'appliesTo'));
  const hostFn = strip(extractFunction(hostSrc, 'appliesTo'));
  ok('两处 appliesTo 实现一致（防止逻辑漂移）', clientFn === hostFn);
}

// ---- client.js：设置页导航去重（两条「Agent 预设」的根因） ----
{
  const { filterSettingsEntries } = load(clientSrc, ['filterSettingsEntries']);
  const official = { options: { id: 'agent-presets', priority: 0, label: 'Agent 预设' } };
  const ours = { options: { id: 'agent-presets', priority: -1, label: 'Agent 预设' } };
  const other = { options: { id: 'appearance', priority: 0 } };
  const noPriority = { options: { id: 'agent-presets' } };

  check('滤掉官方那条（priority 0）', filterSettingsEntries([official, ours, other]).map((e) => e.options.priority), [-1, 0]);
  check('只留我们那条', filterSettingsEntries([official, ours]).length, 1);
  check('省略 priority 视为 0，同样滤掉', filterSettingsEntries([noPriority, ours]).length, 1);
  check('无关条目原样保留', filterSettingsEntries([other]).map((e) => e.options.id), ['appearance']);
  ok('只剩官方一条时原样返回（自己还没注册上，入口不能消失）', (() => {
    const list = [official];
    return filterSettingsEntries(list) === list;
  })());
  ok('空数组原样返回', (() => {
    const list = [];
    return filterSettingsEntries(list) === list;
  })());
}

// ---- client.js：接管官方那条（换它的渲染体，条目还在） ----
{
  const { officialEntryOf, takeOverOfficialEntry, restoreOfficialEntry, settingsSectionRecord, installSectionControl } = load(
    clientSrc,
    ['officialEntryOf', 'takeOverOfficialEntry', 'restoreOfficialEntry', 'settingsSectionRecord', 'installSectionControl', 'installReadFilter', 'forceNavRefresh', 'filterSettingsEntries'],
    { OFFICIAL_ENTRY_ID: 'agent-presets', OURS_PRIORITY: -1, COPY: { nav: 'Agent 预设' } },
  );

  /** 造一个够用的 slots 假件：条目形状与 SlotCore 一致（{ component, options }）。 */
  const fakeSlots = (entries, extra = {}) => {
    const record = { entries, version: 0 };
    const calls = { markDirty: 0, registered: [] };
    const listeners = new Set();
    const bump = () => {
      calls.markDirty += 1;
      for (const fn of [...listeners]) fn('settings.section', record);
    };
    const slots = {
      records: new Map([['settings.section', record]]),
      entries: () => record.entries,
      register: (options, component) => {
        const entry = { component, options: { ...options } };
        record.entries = [...record.entries, entry];
        calls.registered.push(entry);
        bump();
        return () => {
          record.entries = record.entries.filter((item) => item !== entry);
          bump();
        };
      },
      markDirty: () => bump(),
      releaseEntry: () => {},
      onMutate: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      ...extra,
    };
    return { slots, record, calls };
  };
  const makeOfficial = () => ({ component: () => null, options: { id: 'agent-presets', order: 20, label: () => 'Agent 预设' } });
  const ours = { component: () => null, options: { id: 'agent-presets', priority: -1 } };
  const other = { component: () => null, options: { id: 'appearance', priority: 0 } };
  const ourComponent = () => null;

  {
    const official = makeOfficial();
    const { slots } = fakeSlots([official, ours, other]);
    ok('认得出官方那条', officialEntryOf(slots) === official);
    ok('不把我们那条当官方', officialEntryOf(fakeSlots([ours]).slots) === null);
    ok('没登记表时返回 null', officialEntryOf({ entries: () => [] }) === null);
    ok('records 是空的也不崩', settingsSectionRecord({ records: new Map() }) === null);
  }

  {
    const official = makeOfficial();
    const { slots, calls } = fakeSlots([official, other]);
    check('接管返回 taken', takeOverOfficialEntry(slots, ourComponent, () => 'Agent 预设'), 'taken');
    ok('渲染体换成了我们的', official.component === ourComponent);
    ok('原件被记下来了', official.__psxOriginal.component !== ourComponent);
    ok('文案也换成了我们的', official.options.label() === 'Agent 预设');
    const before = calls.markDirty;
    check('再接管一次仍是 taken', takeOverOfficialEntry(slots, ourComponent, () => 'Agent 预设'), 'taken');
    check('内容没变就不再通知（避免 onMutate 自激）', calls.markDirty, before);
    check('还原成功', restoreOfficialEntry(slots), true);
    ok('渲染体还原成官方的', official.component !== ourComponent);
    ok('原件记录被清掉', official.__psxOriginal === undefined);
    check('没接管过就别乱还原', restoreOfficialEntry(slots), false);
  }
  {
    check('官方那条不在时报告 absent', takeOverOfficialEntry(fakeSlots([ours]).slots, ourComponent, () => 'x'), 'absent');
    check('登记表读不到时报告 no-ledger', takeOverOfficialEntry({ entries: () => [] }, ourComponent, () => 'x'), 'no-ledger');
  }

  {
    // 官方先注册、我们后到：直接接管，不再注册自己那条 → 侧栏天然一条
    const official = makeOfficial();
    const { slots, record, calls } = fakeSlots([official, other]);
    const control = installSectionControl(slots, () => ourComponent);
    check('走接管那条路', control.mode, 'takeover');
    check('通道是登记表', control.via, 'ledger');
    check('没有额外注册自己那条', calls.registered.length, 0);
    check('登记表里仍只有一条 Agent 预设', record.entries.filter((e) => e.options.id === 'agent-presets').length, 1);
    ok('渲染体是我们的', official.component === ourComponent);
    ok('重复安装拿回同一个实例（原型标记生效）', installSectionControl(slots, () => ourComponent) === control);
    control.dispose();
    ok('dispose 后原件还原', official.component !== ourComponent);
    ok('dispose 后标记被清掉（可以重装）', Object.getPrototypeOf(slots).__presetStudioSection === undefined);
  }
  {
    // 官方还没注册：先自己注册一条顶上，官方一出现就被接管并释放自己那条
    const { slots, record, calls } = fakeSlots([]);
    const control = installSectionControl(slots, () => ourComponent);
    check('没有官方那条时自己顶上', control.mode, 'own');
    check('注册了一条', calls.registered.length, 1);
    check('我们那条 priority 是 -1', calls.registered[0].options.priority, -1);
    // 模拟官方插件此刻注册并通知
    const official = makeOfficial();
    record.entries = [...record.entries, official];
    slots.markDirty();
    check('官方一注册就切换成接管', control.mode, 'takeover');
    ok('官方那条被换成了我们的渲染体', official.component === ourComponent);
    ok('自己顶上那条被释放了', record.entries.includes(calls.registered[0]) === false);
    check('登记表里只剩一条 Agent 预设', record.entries.filter((e) => e.options.id === 'agent-presets').length, 1);
    control.dispose();
  }
  {
    // 登记表不可见（代理挡了 records）→ 退化成「自己注册 + 读取过滤」
    const record = { entries: [makeOfficial(), other] };
    const slots = {
      entries: () => record.entries,
      register: (options, component) => {
        const entry = { component, options: { ...options } };
        record.entries = [...record.entries, entry];
        return () => {
          record.entries = record.entries.filter((item) => item !== entry);
        };
      },
    };
    const official = record.entries[0];
    const control = installSectionControl(slots, () => ourComponent);
    check('兜底走 filter', control.via, 'filter');
    check('兜底时自己注册了一条', control.mode, 'own');
    ok('读取时官方那条被滤掉', slots.entries('settings.section').includes(official) === false);
    control.dispose();
    ok('dispose 后读取恢复原状', slots.entries('settings.section').includes(official));
  }
}

// ---- 样式文件版本标记（0.61.0：播种文件必须能随插件升级） ----
{
  const patternLine = hostSrc.split(String.fromCharCode(10)).find((line) => line.startsWith('const STYLE_VERSION_PATTERN'));
  const helpers = new Function(
    [
      patternLine,
      'const DEFAULT_CSS = ".x{color:red}";',
      extractFunction(hostSrc, 'styleDocument'),
      extractFunction(hostSrc, 'styleVersionOf'),
      'return { styleDocument, styleVersionOf };',
    ].join(String.fromCharCode(10)),
  )();
  check('读得出播种版本', helpers.styleVersionOf(helpers.styleDocument('1.2.3')), '1.2.3');
  check('没有标记返回 null', helpers.styleVersionOf('body{color:red}'), null);
  check('标记不在开头不算', helpers.styleVersionOf(String.fromCharCode(10) + '/* @psx-version: 9.9.9 */'), null);
  ok('播种文件带上默认样式', helpers.styleDocument('1.0.0').includes('.x{color:red}'));
  check('反复播种结果稳定', helpers.styleVersionOf(helpers.styleDocument('0.61.0')), '0.61.0');
}


// ---- 结果 ----
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('');
  for (const f of failures) console.log(`✗ ${f}`);
  process.exit(1);
}
