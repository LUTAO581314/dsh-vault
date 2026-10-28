# DSH plugin and MCP setup

简体中文：[README.zh-CN.md](README.zh-CN.md)。

This repository keeps the desktop DSH plugin manifest, the locally authored plugin, the dsh-purge upstream checkout, and the REA MCP definition. It does not contain chat history, workspace data, credentials, runtime state, or machine-specific MCP configuration.

## Install

Clone with the dsh-purge submodule, then run the installer from PowerShell:

    git clone --recurse-submodules https://github.com/LUTAO581314/dsh-vault.git
    cd dsh-vault
    .\scripts\install.ps1

The installer merges the repository's pinned plugin dependencies and DSH bundles into the desktop profile, copies both plugin packages into the selected DSH home, installs the REA MCP runtime, and merges its server definition into the chosen workspace's .dsh/mcp.json. When the local MultiZen token file exists, it also updates the MultiZen MCP entry in the desktop profile using the installed dsh-armory MCP helper. The token stays in the local DSH profile and is never written to this repository. Existing bundles, dependencies, and MCP servers are preserved. The installer backs up the profile manifest, lockfile, Cordis patch, and workspace MCP configuration before changing them.

The defaults target %USERPROFILE%/.dsh and %USERPROFILE%/Documents/deepseek-harness/default-workspace. Override them when needed:

    .\scripts\install.ps1 -DshHome D:\Apps\dsh-home -Workspace D:\Work\my-workspace

Install Node.js, npm, and pnpm (or Corepack) first. Use -WhatIf to inspect the target paths without making changes. Restart DSH after installation.

## Contents

- profiles/desktop/package.json records the currently selected desktop dependencies and bundles with exact versions or source refs.
- plugins/dsh-multizen-launcher is the local plugin maintained in this repository.
- plugins/dsh-purge is a Git submodule pinned to upstream commit 8023a74340acead66f88913d539b605f3754c167. Keep the upstream license and attribution notices with it; upstream asks downstream projects to credit YuJunZhiXue/dsh-purge.
- mcp/package.json pins the REA runtime, and mcp/servers.template.json describes its stdio MCP launch command. The installer fills in the local checkout path and preserves other workspace MCP servers.
- profiles/desktop/mcp-servers.json records the MultiZen Streamable HTTP endpoint. The installer obtains the bearer token from the configured local token file and stores it only in the DSH profile's Cordis patch.

The MultiZen launcher finds MultiZen under the current Windows user's LocalAppData by default and checks its MCP endpoint on port 7777. Set DSH_MULTIZEN_EXE if it is installed elsewhere. The plugin starts the local MultiZen app, which provides the MCP endpoint. Install MultiZen and authorize it locally before running the installer to connect that MCP. The REA server is configured at workspace level; MultiZen is managed by the DSH profile.

dsh-purge is installed from its pinned upstream checkout. Adding the bundle does not apply its DSH patches; open dsh-purge and select Apply after restarting DSH if you want those patches.

## Update

Pull this repository and update the submodule to the commit recorded by the repository:

    git pull
    git submodule update --init --recursive
    .\scripts\install.ps1

The script is safe to rerun. To add a plugin or MCP, update only the matching manifest and its source directory, then rerun the installer.
