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

// ---- client.js：直接改官方那条（不删条目、也不另建一条） ----
// 假件照**真机**的形状造：插件拿到的 ctx.slots 是渲染器的 Service 外壳，
// 只有 entries / subscribe（微任务通知）/ register / getVersion，没有 records、markDirty、onMutate。
// 0.63.0 的假件给了 records，测试全绿、真机却 no-ledger——这里不再犯。
{
  const { officialEntryOf, takeOverOfficialEntry, restoreOfficialEntry, settingsSectionEntries, bumpSectionVersion, installSectionControl } = load(
    clientSrc,
    ['officialEntryOf', 'takeOverOfficialEntry', 'restoreOfficialEntry', 'settingsSectionEntries', 'bumpSectionVersion', 'installSectionControl'],
    { OFFICIAL_ENTRY_ID: 'agent-presets', COPY: { nav: 'Agent 预设' } },
  );
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** 照 Service 外壳造的假件。 */
  const serviceSlots = (entries) => {
    const record = { entries, version: 0 };
    const calls = { registered: [] };
    const listeners = new Set();
    const changed = () => {
      record.version += 1;
      queueMicrotask(() => {
        for (const fn of [...listeners]) fn();
      });
    };
    const slots = {
      entries: (key) => (key === 'settings.section' ? record.entries : []),
      getVersion: () => record.version,
      subscribe: (key, fn) => {
        if (key !== 'settings.section') return () => {};
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      register: (options, component) => {
        const entry = { component, options: { ...options } };
        record.entries = [...record.entries, entry];
        calls.registered.push(entry);
        changed();
        return () => {
          record.entries = record.entries.filter((item) => item !== entry);
          changed();
        };
      },
    };
    return { slots, record, calls, changed };
  };
  const makeOfficial = () => ({ component: () => null, options: { id: 'agent-presets', order: 20, label: () => 'Agent 预设' } });
  const other = { component: () => null, options: { id: 'appearance' } };
  const ourComponent = () => null;
  const agentRows = (record) => record.entries.filter((e) => e.options.id === 'agent-presets').length;

  {
    const official = makeOfficial();
    const { slots } = serviceSlots([official, other]);
    ok('不靠 records 也认得出官方那条', officialEntryOf(slots) === official);
    ok('没有官方那条时返回 null', officialEntryOf(serviceSlots([other]).slots) === null);
    ok('entries 不可用时返回 null', settingsSectionEntries({}) === null);
  }

  {
    const official = makeOfficial();
    const original = official.component;
    const { slots, record } = serviceSlots([official, other]);
    const v0 = record.version;
    check('接管返回 taken', takeOverOfficialEntry(slots, ourComponent, () => 'Agent 预设'), 'taken');
    ok('渲染体换成了我们的', official.component === ourComponent);
    ok('原件被记下来了', official.__psxOriginal.component === original);
    check('文案也换成了我们的', official.options.label(), 'Agent 预设');
    ok('版本号自增了（导航会重读）', record.version > v0);
    check('临时条目当场释放，登记表里没留下', record.entries.length, 2);
    const v1 = record.version;
    check('再接管一次仍是 taken', takeOverOfficialEntry(slots, ourComponent, () => 'Agent 预设'), 'taken');
    check('内容没变就不再动版本号（避免订阅自激）', record.version, v1);
    check('还原成功', restoreOfficialEntry(slots), true);
    ok('渲染体还原成官方的', official.component === original);
    ok('原件记录被清掉', official.__psxOriginal === undefined);
    check('没接管过就别乱还原', restoreOfficialEntry(slots), false);
  }
  {
    check('官方那条不在时报告 absent', takeOverOfficialEntry(serviceSlots([other]).slots, ourComponent, () => 'x'), 'absent');
    check('条目读不到时报告 no-ledger', takeOverOfficialEntry({}, ourComponent, () => 'x'), 'no-ledger');
    check('SlotCore 形状（有 records/markDirty）也能自增版本', (() => {
      const rec = { entries: [], version: 0 };
      let dirty = 0;
      bumpSectionVersion({ records: new Map([['settings.section', rec]]), markDirty: () => (dirty += 1) });
      return dirty;
    })(), 1);
  }

  {
    // 官方先注册、我们后到：当场改。
    const official = makeOfficial();
    const { slots, record } = serviceSlots([official, other]);
    let built = 0;
    const control = installSectionControl(slots, () => {
      built += 1;
      return ourComponent;
    });
    check('模式是接管', control.mode, 'takeover');
    check('原因记为已接管', control.why, 'taken-over');
    check('登记表里只有官方那一条 Agent 预设（不造第二个）', agentRows(record), 1);
    check('登记表里没留下我们注册的任何条目', record.entries.length, 2);
    ok('官方那条的渲染体是我们的', official.component === ourComponent);
    await tick();
    check('订阅回调回来后组件仍只造了一次', built, 1);
    ok('重复安装拿回同一个实例（原型标记生效）', installSectionControl(slots, () => ourComponent) === control);
    control.dispose();
    ok('dispose 后渲染体还原', official.component !== ourComponent);
    ok('dispose 后标记被清掉（可以重装）', Object.getPrototypeOf(slots).__presetStudioSection === undefined);
  }
  {
    // 真机时序：我们先装，官方晚一步注册——subscribe 的微任务通知回来时当场改。
    const { slots, record, changed } = serviceSlots([other]);
    const control = installSectionControl(slots, () => ourComponent);
    check('官方不在时不接管', control.mode, 'none');
    check('原因写明是还没注册', control.why, 'official-not-registered-yet');
    const official = makeOfficial();
    record.entries = [...record.entries, official];
    changed();
    await tick();
    check('官方一注册就改成接管', control.mode, 'takeover');
    ok('渲染体换成了我们的', official.component === ourComponent);
    check('登记表里只剩一条 Agent 预设', agentRows(record), 1);
    check('没留下我们注册的条目', record.entries.length, 2);
    await tick();
    check('自增版本触发的回调没有让它反复折腾', control.mode, 'takeover');
    control.dispose();
    ok('dispose 后官方那条恢复原样', official.component !== ourComponent);
  }
  {
    // 连 entries 都没有：什么都不做，绝不注册
    let registered = 0;
    const slots = { register: () => (registered += 1) };
    const control = installSectionControl(slots, () => ourComponent);
    check('读不到条目时模式是 none', control.mode, 'none');
    check('原因写明是 no-ledger', control.why, 'no-ledger');
    check('读不到条目时绝不注册', registered, 0);
    control.dispose();
  }
  {
    const control = installSectionControl(null, () => ourComponent);
    check('没有 slots 时安全退化', control.mode, 'none');
    control.dispose();
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
