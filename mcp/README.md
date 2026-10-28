# MCP servers

REA is the MCP server currently configured in the selected DSH workspace. Its npm version is pinned in package.json. The installer installs its runtime into this repository's ignored mcp/node_modules directory and merges the local stdio command into the workspace .dsh/mcp.json. MultiZen uses DSH's profile-level MCP configuration and is declared in profiles/desktop/mcp-servers.json.

Other MCP server entries in that file are preserved. Do not commit a machine-specific generated mcp.json: it can contain local paths and environment credentials. Edit servers.template.json to maintain portable server definitions.
