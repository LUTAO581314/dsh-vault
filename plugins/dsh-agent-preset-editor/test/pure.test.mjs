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

// ---- client.js：真删除官方条目（不是读取时遮蔽） ----
{
  const { isForeignEntry, removeForeignEntry, installEntryRemoval, refreshRemovalDiag, settingsSectionRecord } = load(
    clientSrc,
    ['isForeignEntry', 'settingsSectionRecord', 'removeForeignEntry', 'refreshRemovalDiag', 'installEntryRemoval', 'forceNavRefresh', 'filterSettingsEntries'],
    { OFFICIAL_ENTRY_ID: 'agent-presets', OURS_PRIORITY: -1 },
  );

  /** 造一个够用的 slots 假件：records + markDirty + releaseEntry + onMutate。 */
  const fakeSlots = (entries, extra = {}) => {
    const record = { entries, version: 0 };
    const calls = { markDirty: 0, released: [] };
    const listeners = new Set();
    const slots = {
      records: new Map([['settings.section', record]]),
      entries: () => record.entries,
      markDirty: () => {
        calls.markDirty += 1;
        for (const fn of [...listeners]) fn('settings.section');
      },
      releaseEntry: (entry) => calls.released.push(entry),
      onMutate: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      register: () => () => {},
      ...extra,
    };
    return { slots, record, calls, listeners };
  };
  const official = { options: { id: 'agent-presets', priority: 0 } };
  const ours = { options: { id: 'agent-presets', priority: -1 } };
  const other = { options: { id: 'appearance', priority: 0 } };

  ok('识别官方那条', isForeignEntry(official));
  ok('我们那条不算外来的', isForeignEntry(ours) === false);
  ok('别的 section 不算', isForeignEntry(other) === false);
  ok('省略 priority 视为官方那条', isForeignEntry({ options: { id: 'agent-presets' } }));

  {
    const { slots, record, calls } = fakeSlots([official, ours, other]);
    check('登记表里删掉官方那条', removeForeignEntry(slots), 'removed');
    check('删完只有我们的 + 无关的', record.entries.map((e) => e.options.priority ?? 0), [-1, 0]);
    ok('删完记录里不再含官方那条', record.entries.includes(official) === false);
    check('删完通知了一次版本', calls.markDirty, 1);
    check('删完释放了那条', calls.released.length, 1);
    ok('释放的正是官方那条', calls.released[0] === official);
    check('第二次调用是空操作', removeForeignEntry(slots), 'clean');
    check('空操作不再通知', calls.markDirty, 1);
  }
  {
    const { slots } = fakeSlots([ours]);
    check('没有官方那条时报告 clean', removeForeignEntry(slots), 'clean');
  }
  {
    const slots = { entries: () => [] };
    check('拿不到登记表时报告 no-ledger', removeForeignEntry(slots), 'no-ledger');
    ok('records 是空的也不崩', settingsSectionRecord({ records: new Map() }) === null);
  }
  {
    // 官方插件比我们晚注册：挂上 onMutate，它一注册就被当场删掉
    const { slots, record, calls } = fakeSlots([ours]);
    const removal = installEntryRemoval(slots);
    check('走真删那条路', removal.via, 'ledger');
    check('初始没问题时 why=clean', removal.why, 'clean');
    // 模拟官方注册：加进登记表 + 通知
    record.entries = [...record.entries, official];
    calls.markDirty += 0;
    slots.markDirty();
    ok('官方后注册被当场删掉', record.entries.includes(official) === false);
    ok('我们那条还在', record.entries.includes(ours));
    // 重复安装拿回同一个实例（原型标记生效）
    ok('重复调用返回同一份', installEntryRemoval(slots) === removal);
    removal.dispose();
    ok('dispose 之后标记被清掉（可以重装）', Object.getPrototypeOf(slots).__presetStudioRemoval === undefined);
  }
  {
    // 官方先注册、我们后到：installEntryRemoval 立刻删
    const { slots, record } = fakeSlots([official]);
    const removal = installEntryRemoval(slots);
    check('立即删除', removal.why, 'removed');
    ok('官方那条没了', record.entries.includes(official) === false);
  }
  {
    // 登记表不可见 → 退化为读取过滤，且不该崩
    const record = { entries: [official, ours] };
    const slots = {
      entries: () => record.entries,
      register: () => () => {},
    };
    const removal = installEntryRemoval(slots);
    check('兜底走 filter', removal.via, 'filter');
    const filtered = slots.entries('settings.section');
    ok('读取时官方那条被滤掉', filtered.includes(official) === false);
    removal.dispose();
    ok('dispose 后读取恢复原状', slots.entries('settings.section').includes(official));
  }
  {
    // diag：删干净了 deleted=true，没删掉 deleted=false
    const { slots } = fakeSlots([ours]);
    const clean = refreshRemovalDiag(slots, 'ledger', 'removed');
    check('删干净时 deleted=true', clean.deleted, true);
    const { slots: dirty } = fakeSlots([official, ours]);
    const unclean = refreshRemovalDiag(dirty, 'filter', 'blocked');
    check('没删掉时 deleted=false', unclean.deleted, false);
    check('没删掉时带出通道', unclean.via, 'filter');
    check('没删掉时能看到官方还在', unclean.hasOfficial, true);
  }
}

// ---- 结果 ----
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('');
  for (const f of failures) console.log(`✗ ${f}`);
  process.exit(1);
}
