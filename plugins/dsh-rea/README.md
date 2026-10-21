# dsh-rea

[REA — Reverse Engineer Anything](https://github.com/morluto/rea) for DeepSeek Harness.

REA gives an agent 207 MCP tools for shipped-artifact reverse engineering: native
decompilation, .NET, Electron/JavaScript bundles, APKs, Flutter AOT, Mach-O,
packet captures, firmware images, SQLite, WASM, and process/web runtime
observation. This bundle wires that into DSH and adds the two things the upstream
CLI cannot install for you.

## What it installs

| Entry | Plane | What it is |
|---|---|---|
| `dsh-rea` | host | This package: `${DSH_HOME}/skills` skill install, `rea_probe`, `rea_doctor` |
| `mcp-rea` | host | `@deepseek-ai/dsh-mcp-client` running `npx -y rea-agents@latest mcp` over stdio → tools named `mcp__rea__*` |
| `preset-rea-re` | preset | Agent preset **逆向工程师（REA）**: persona + shell + fs + skills + plan mode + compaction + delegation + web |

The 207 REA tools live on the host row, not in the preset — they are shared, and a
second mount per session would be waste.

## Why the two tools exist

`mcp__rea__*` is a flat set of 207 names. A cold model picks the wrong one, or
picks none and starts reading hex by hand. Two small tools fix that:

- **`rea_probe`** — reads magic bytes (never the extension) and answers three
  questions at once: what family is this artifact, which REA workflow/guide covers
  it, and which `mcp__rea__*` tools **this profile actually registered** for that
  family. Output is bounded — family, basis, guide, tool names, notes.
- **`rea_doctor`** — is the depth this analysis will promise actually available?
  Node engine, whether the `mcp-rea` row came up at all, whether the skill is
  installed, and which decompilers/devices/capture tools exist (Ghidra, Hopper,
  IDA, rizin, objdump, JADX, apktool, adb + attached devices, tshark, binwalk,
  wabt, python). `family: "apk"` narrows it to what an APK run needs.

Both are cheap, both are read-only, both return JSON plus a rendered summary.

## Skill

The bundle installs REA's upstream `reverse-engineer-anything` skill pack (the
decision trees — which artifact type, which depth, how to write findings) into
`$DSH_HOME/skills/reverse-engineer-anything/` at boot, idempotently, from the copy
shipped in `assets/skills/`. `rea setup --skill` writes the same files into
`~/.agents/skills`; DSH reads both roots, this bundle uses the `$DSH_HOME` one so
the files travel with the harness profile.

Set `installSkill: false` on the `dsh-rea` row to manage that directory yourself.

## Config (`dsh-rea` row)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Register the two tools |
| `installSkill` | `true` | Install/refresh the skill pack at boot |
| `skillsDir` | `$DSH_HOME/skills` | Where the skill pack goes |
| `mcpServerName` | `rea` | `serverName` of the MCP row; tools are counted as `mcp__<name>__*` |
| `probeHeadBytes` | `8192` | Magic-byte read budget per target |
| `probeMaxTargets` | `16` | Targets per `rea_probe` call |
| `doctorTimeoutMs` | `4000` | Per external check |

## CLI

The same checks without a session:

```bash
node bin/dsh-rea.mjs doctor            # readiness table (exit 1 when blocked)
node bin/dsh-rea.mjs doctor --json
node bin/dsh-rea.mjs probe <path...>   # family classification only
node bin/dsh-rea.mjs skill             # install/refresh the skill pack
```

Standalone `doctor` has no agent tool view, so it reports `0 rea tools` and says
so; inside a session `rea_doctor` sees the live registry.

## Requirements

- Node `^22.19 || >=24` (rea-agents' own engines; npx refuses below that).
- First `npx -y rea-agents@latest mcp` downloads the package; later runs are cached.
- Windows: `npx` is a `.cmd` shim, so the MCP row spawns `cmd.exe /d /c npx …`.
  On POSIX change `command` to `npx` and drop the first two args.
- Depth, not prerequisites: Ghidra/Hopper/IDA for pseudo-code, jadx/apktool for
  APK resources, adb for a live device, tshark for protocol detail, binwalk for
  firmware. Without them REA still works at disassembly/metadata level — and
  `rea_doctor` tells you which level you are at.

## Patch notes

`cordis.patch.yml` is a top-level YAML array; new rows use `- insert:`. The
`toolCallTimeoutMs: 600000` on `mcp-rea` is deliberate: a first Ghidra
`analyzeHeadless` run on a large binary regularly exceeds the 60 s default.

## Upstream

- REA: <https://github.com/morluto/rea> (npm `rea-agents`)
- DSH client registration notes REA ships: `docs/client-configuration.md` →
  "DeepSeek Harness" (`rea setup --client dsh`)
