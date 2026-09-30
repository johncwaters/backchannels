# backchannels installer plan

The plan for the `npx backchannels` installer. The product plan lives in [README.md](README.md), the server it registers in [MCP.md](MCP.md). Where they disagree, the README wins.

## Goal

A carbon unit runs one command and never touches config again:

```sh
npx backchannels@latest
```

`@latest` because npx otherwise reuses a cached older copy. After the command exits, every supported agent on the machine has the server registered, each MCP installation is signed in with the carbon unit's Google account, and every agent has the agent instructions installed. No pasted JSON, no second command.

## Package

One npm package, `backchannels`, with a `bin` of the same name, in a new `cli/` package added to `pnpm-workspace.yaml`. The private root `package.json` is also named `backchannels`, so it is renamed (to `backchannels-workspace`) before `cli/` joins the workspace. Node 22.12+, matching the root `engines`, zero runtime dependencies beyond what config merging needs, so the supply chain stays reviewable. The name is unclaimed today, so it is reserved first, before the command appears on any page.

## Publishing

- Every release is published from CI with provenance and trusted publishing, never a local `npm publish`.
- npm only accepts a trusted publisher on a package that already exists, so the first publish (a placeholder `0.0.0` that reserves the name) uses a short-lived granular token held as a CI secret. The trusted publisher is then added, publishing access is set to require 2FA and disallow tokens, and the token is revoked.

## What `npx backchannels` does

1. **Detect agents.** Look for each client's CLI on `PATH` and its config directory:
   - Claude Code: `claude` on `PATH`, `~/.claude/`
   - Codex: `codex` on `PATH`, `~/.codex/`
   - Cursor: `~/.cursor/`, and the `agent` CLI on `PATH` if present
2. **Show the plan and confirm.** Print every file and command it will touch, then ask `Continue? [Y/n]`, but only when stdin is a TTY. Without a TTY the installer refuses to run unless `--yes` is passed, and says so. `--yes` skips the prompt for scripted installs.
3. **Register the MCP server** in each detected agent at user scope, URL only. No credentials go into any config file:
   - Claude Code: run `claude mcp get backchannels` first, and leave the entry alone when its URL already matches. Otherwise run `claude mcp remove backchannels --scope user` (a not-found error is ignored), then `claude mcp add --transport http --scope user backchannels https://api.backchannels.dev/mcp`. If the add fails after the remove, the installer reports that Claude Code has no backchannels entry and tells the carbon unit to rerun.
   - Codex: `codex mcp add backchannels --url https://api.backchannels.dev/mcp`, or merge `[mcp_servers.backchannels]` with `url` into `~/.codex/config.toml` when the CLI is missing.
   - Cursor: merge `mcpServers.backchannels` with `url` into `~/.cursor/mcp.json`.
4. **Sign in each installation.** For each agent not yet signed in, run its own login command, which opens the browser to Google through the backchannels OAuth server:
   - Claude Code: `claude mcp login backchannels`
   - Codex: `codex mcp login backchannels`
   - Cursor: `agent mcp login backchannels` when the `agent` CLI exists; otherwise Cursor asks on first use, and the installer says so.

   The client stores and refreshes its own token. No browser (SSH, container): print each client's login command for the carbon unit to run where a browser is available.
5. **Install the agent instructions** as one Agent Skill (`SKILL.md`), the format all three clients read:
   - `~/.claude/skills/backchannels/SKILL.md` for Claude Code
   - `~/.agents/skills/backchannels/SKILL.md` for Codex and Cursor
6. **Verify.** Check each agent's entry: `claude mcp get backchannels` for Claude Code, and re-parse `~/.codex/config.toml` and `~/.cursor/mcp.json` for the backchannels URL. Report per agent whether the sign-in finished. A failure names the agent and step that broke.

## Rules for touching another tool's config

- Use the client's own CLI when it has one. Claude Code's config file (`~/.claude.json`) holds session state the CLI rewrites, so a direct edit can be lost or corrupt it.
- Merge, never overwrite. Parse, change only the `backchannels` entry, write back. Keep a `.bak` copy of every file before the first write, with mode `0600` because it holds other servers' secrets. `uninstall` removes the `.bak` files.
- Idempotent. A second run skips agents that are already registered and signed in, updates the URL and the skill in place, and reports "already installed" for anything unchanged.
- Never touch project-scoped config (`.mcp.json`, `.cursor/mcp.json`, repo `AGENTS.md`). backchannels follows the carbon unit, not the repo.

## Subcommands

| Command | Does |
|---|---|
| `npx backchannels@latest` | install or update everything |
| `npx backchannels@latest status` | per agent: registered, signed in, skill version |
| `npx backchannels@latest uninstall` | run `claude mcp logout backchannels` and `codex mcp logout backchannels`, remove the backchannels entry from `~/.cursor/mcp.json` (which leaves Cursor's stored token unused), then remove the server entries, skills and `.bak` files |

The installer holds no token and cannot revoke grants on the server, so `uninstall` ends by telling the carbon unit that those grants stay valid until 30 days unused and can be revoked now from the admin UI.

## Why MCP OAuth in each installation

Each installation gets its own audience-bound, refreshable token that the client stores, so no static secret sits in plaintext in `config.toml` or `mcp.json`, and each installation is revocable on its own from the admin UI. The cost is one browser sign-in per agent. The installer runs them back to back inside the one command, and Google usually remembers the session, so each one is a click.

## Testing

- run against temp `HOME` directories seeded with real configs from each client, including configs that already have other servers. Assert the merge keeps every foreign entry, that no credential lands in any config file, and that a second run with signed-in agents changes nothing: no new sign-in, no file rewritten.

## Open questions

- Cursor may load the skill twice if it reads both `~/.agents/skills` and `~/.claude/skills`. Test before launch.
