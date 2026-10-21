/**
 * Family detection: what kind of artifact is this path, and which REA workflow
 * studies it.
 *
 * Detection is magic-bytes first and extension last. The REA skill is explicit
 * about this ("a file is not a file type"); guessing from an extension is how an
 * agent opens a zip-packaged Electron app as if it were a native binary and
 * burns a whole run on a dead end.
 *
 * `tools` holds NAME FRAGMENTS, not tool names. They are matched against the
 * tools the `rea` MCP server actually registered in this profile, so a
 * suggestion can never name a tool that does not exist here.
 *
 * @module dsh-rea/families
 */

/** Cross-cutting tools worth naming on every target. */
export const CONVERGENCE = [
  'list_unknowns',
  'record_unknown',
  'export_evidence_bundle',
  'verify_reconstruction',
  'trace_feature',
  'find_changed_behavior',
  'compare_application_versions',
];

/**
 * Detection order matters: the first matcher that fires wins, so specific
 * containers (APK, IPA, SAZ, docx) are listed before the bare `zip` fallback.
 */
export const FAMILIES = [
  {
    id: 'apk',
    label: 'Android APK',
    guide: 'guides/android-game-reversing.md（DEX 静态 + adb 运行时）',
    test: (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && hasAscii(b, 'AndroidManifest.xml'),
    tools: ['android_package', 'android_class', 'android_method', 'android_application_graph', 'adb_package'],
  },
  {
    id: 'flutter-aot',
    label: 'Flutter AOT (libapp.so)',
    guide: 'guides/flutter.md',
    test: (b, name) => isElf(b) && /(libapp|libflutter)\.so$/i.test(name),
    tools: ['flutter_build', 'dart_aot'],
  },
  {
    id: 'il2cpp-metadata',
    label: 'Unity IL2CPP metadata',
    guide: 'guides/unity-il2cpp.md',
    test: (b) => b.length >= 4 && b.readUInt32LE(0) === 0xfab11baf,
    tools: ['artifact', 'extract_artifact'],
  },
  {
    id: 'ipa',
    label: 'iOS IPA',
    guide: 'docs/guides/apple.md',
    test: (b) => isZip(b) && (hasAscii(b, 'Payload/') || hasAscii(b, 'Info.plist')),
    tools: ['macho', 'plist', 'keyed_archive', 'apple_application_graph'],
  },
  {
    id: 'saz',
    label: 'Fiddler SAZ capture',
    guide: 'docs/guides/network.md',
    test: (b) => isZip(b) && (hasAscii(b, 'raw/') || hasAscii(b, '_index.htm')),
    tools: ['web_network_capture', 'compare_web_captures'],
  },
  {
    id: 'office-zip',
    label: 'Office OOXML package',
    guide: 'guides/malicious-documents.md（宏提取、嵌入对象）',
    test: (b) => isZip(b) && (hasAscii(b, 'word/') || hasAscii(b, 'xl/') || hasAscii(b, 'ppt/') || hasAscii(b, 'vbaProject')),
    tools: ['artifact', 'extract_artifact', 'inspect_packet_fields'],
  },
  {
    id: 'archive',
    label: 'zip / jar / crx 容器',
    guide: 'guides/apps-and-native-code.md（先解包再认家族）',
    test: isZip,
    tools: ['artifact', 'extract_artifact'],
  },
  {
    id: 'macho',
    label: 'Mach-O binary',
    guide: 'docs/guides/apple.md',
    test: (b) => {
      const m = b.subarray(0, 4).toString('hex');
      return m === 'cffaedfe' || m === 'feedfacf' || m === 'cefaedfe' || m === 'feedface' || m === 'cafebabe';
    },
    tools: ['macho', 'binary_session', 'binary_overview'],
  },
  {
    id: 'dotnet',
    label: '.NET assembly',
    guide: 'guides/dotnet.md',
    test: (b) => isPe(b) && (hasAscii(b, 'mscoree.dll') || hasAscii(b, '_CorExeMain') || hasAscii(b, 'BSJB')),
    tools: ['managed_artifact', 'managed_members', 'managed_native_boundaries'],
  },
  {
    id: 'go',
    label: 'Go binary',
    guide: 'guides/apps-and-native-code.md',
    test: (b) => isElfOrPe(b) && (hasAscii(b, 'Go build ID') || hasAscii(b, 'runtime.main') || hasAscii(b, 'go.buildinfo')),
    tools: ['go_binary', 'binary_session', 'analyze_function'],
  },
  {
    id: 'rust',
    label: 'Rust binary',
    guide: 'guides/apps-and-native-code.md',
    test: (b) => isElfOrPe(b) && (hasAscii(b, 'rustc') || hasAscii(b, 'RUST_BACKTRACE') || hasAscii(b, 'core::panicking')),
    tools: ['rust_binary', 'binary_session', 'analyze_function'],
  },
  {
    id: 'native',
    label: 'native binary (PE / ELF)',
    guide: 'guides/apps-and-native-code.md + docs/guides/decompilers.md（Ghidra / Hopper / IDA 选型）',
    test: (b) => isElf(b) || isPe(b),
    tools: ['binary_session', 'binary_overview', 'list_procedures', 'analyze_function', 'procedure_pseudo_code', 'find_xrefs', 'search_strings'],
  },
  {
    id: 'wasm',
    label: 'WebAssembly module',
    guide: 'docs/guides/reconstructing-applications.md',
    test: (b) => b.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d])),
    tools: ['wasm'],
  },
  {
    id: 'sqlite',
    label: 'SQLite database',
    guide: 'docs/guides/reconstructing-applications.md（状态存储与本地内容）',
    test: (b) => b.subarray(0, 15).toString('utf8') === 'SQLite format 3',
    tools: ['sqlite'],
  },
  {
    id: 'pcap',
    label: 'packet capture (pcap / pcapng)',
    guide: 'docs/guides/network.md',
    test: (b) => {
      const m = b.subarray(0, 4).toString('hex');
      return m === 'd4c3b2a1' || m === 'a1b2c3d4' || m === '4d3cb2a1' || m === '0a0d0d0a';
    },
    tools: ['pcap', 'packet'],
  },
  {
    id: 'web-capture',
    label: 'web network capture (HAR)',
    guide: 'docs/guides/network.md',
    test: (b) => hasAscii(b, '"log"') && hasAscii(b, '"entries"'),
    tools: ['web_network_capture', 'compare_web_captures'],
  },
  {
    id: 'gguf',
    label: 'model weights (GGUF)',
    guide: 'docs/guides/reconstructing-applications.md',
    test: (b) => b.subarray(0, 4).toString('utf8') === 'GGUF',
    tools: ['artifact'],
  },
  {
    id: 'firmware',
    label: 'firmware image',
    guide: 'guides/firmware-and-devices.md',
    test: (b) => {
      const head = b.subarray(0, 4).toString('latin1');
      return ['hsqs', 'sqsh', 'UBI#', 'UBI!', 'CramFS', 'cramfs'].includes(head) || b.subarray(0, 8).toString('latin1') === 'ANDROID!' || b.subarray(0, 4).toString('hex') === '27051956';
    },
    tools: ['firmware'],
  },
  {
    id: 'plist',
    label: 'property list',
    guide: 'docs/guides/apple.md',
    test: (b) => hasAscii(b, '<plist') || b.subarray(0, 8).toString('latin1') === 'bplist00',
    tools: ['plist'],
  },
  {
    id: 'evm',
    label: 'EVM contract bytecode',
    guide: 'docs/guides/reconstructing-applications.md',
    test: (b) => /^0x[0-9a-fA-F]{64,}\s*$/.test(b.subarray(0, 256).toString('utf8')),
    tools: ['evm'],
  },
  {
    id: 'javascript',
    label: 'JavaScript / Electron bundle',
    guide: 'guides/electron.md + docs/guides/reconstructing-applications.md',
    test: (b, name, text) =>
      /\.(js|mjs|cjs|asar|jsx|ts|tsx)$/i.test(name) ||
      (text !== undefined && /(function\s|=>|require\(|webpackJsonp|__webpack_require__)/.test(text) && printableRatio(b) > 0.9),
    tools: ['javascript_application', 'recover_javascript_sources', 'electron_fuses', 'web_module'],
  },
  {
    id: 'signal',
    label: 'logic-analyzer capture',
    guide: 'guides/firmware-and-devices.md（协议还原）',
    test: (b, name) => /\.(sr|vcd|sal|logicdata)$/i.test(name),
    tools: ['signal_recording'],
  },
  {
    id: 'crash',
    label: 'crash dump / core',
    guide: 'docs/guides/debuggers.md（调试器挂载）',
    test: (b, name) => /\.(dmp|core|crash)$/i.test(name) || b.subarray(0, 4).toString('latin1') === 'MDMP',
    tools: ['recorded_crash'],
  },
];

/** Text-ish files whose family is decided by content, not by magic. */
export const TEXTUAL = new Set(['javascript', 'web-capture', 'plist', 'evm', 'signal', 'crash']);

// ── magic helpers ───────────────────────────────────────────────────────────

export function isZip(b) {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);
}

export function isElf(b) {
  return b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
}

export function isPe(b) {
  if (b.length < 0x40 || b[0] !== 0x4d || b[1] !== 0x5a) return false;
  const lfanew = b.readUInt32LE(0x3c);
  return lfanew + 4 <= b.length && b.subarray(lfanew, lfanew + 4).toString('latin1') === 'PE\0\0';
}

function isElfOrPe(b) {
  return isElf(b) || isPe(b);
}

export function hasAscii(b, needle) {
  return b.includes(Buffer.from(needle, 'latin1'));
}

export function printableRatio(b) {
  if (b.length === 0) return 1;
  let printable = 0;
  for (const byte of b) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte < 0x7f)) printable += 1;
  }
  return printable / b.length;
}

/**
 * Decide a family from bytes + name.
 * @param {Buffer} head first bytes of the file (a few KB is plenty)
 * @param {string} name basename or full path, used for suffix and Flutter/capture hints
 * @param {string} [text] decoded head when the file looks textual
 * @returns {{ id: string, label: string, guide: string, tools: string[], basis: string } | null}
 */
export function matchFamily(head, name, text) {
  for (const family of FAMILIES) {
    let hit = false;
    try {
      hit = family.test(head, name, text);
    } catch {
      hit = false;
    }
    if (!hit) continue;
    return {
      id: family.id,
      label: family.label,
      guide: family.guide,
      tools: [...family.tools],
      basis: `magic/${family.id}`,
    };
  }
  return null;
}

/**
 * Suggest tools from a candidate-fragment list, keeping only tools this profile's
 * `rea` server actually exposes. Order follows the fragment list.
 * @param {Set<string> | string[]} available bare tool names (no `mcp__rea__` prefix)
 * @param {string[]} fragments
 * @param {number} [limit]
 */
export function pickTools(available, fragments, limit = 8) {
  const pool = available instanceof Set ? [...available] : available;
  const out = [];
  for (const fragment of fragments) {
    const needle = fragment.toLowerCase();
    const matches = pool
      .filter((tool) => tool.toLowerCase().includes(needle))
      .sort((a, b) => a.length - b.length);
    for (const tool of matches) if (!out.includes(tool)) out.push(tool);
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}
