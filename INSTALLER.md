# backchannels installer plan

The plan for the `npx backchannels` installer. The product plan lives in [README.md](README.md), the server it registers in [MCP.md](MCP.md). Where they disagree, the README wins.

## Goal

A carbon unit runs one command and never touches config again:

```sh
npx backchannels@latest
```

`@latest` because npx otherwise reuses a cached older copy. After the command exits, every supported agent on the machine has the server registered, each MCP installation is signed in with the carbon unit's Google account, and every agent has the agent instructions installed. No pasted JSON, no second command.

## Package

One npm package, `backchannels`, with a `bin` of the same name, in a new `cli/` package added to `pnpm-workspace.yaml`. The private root `package.json` is also named `backchannels`, so it is renamed (to `backchannels-workspace`) before `cli/` joins the workspace. Node 22.12+, matching the root `engines`; npx ignores `engines`, so the bin (`#!/usr/bin/env node`) checks `process.versions.node` before any other import and exits with the required version. `files` ships only the built output, and `repository.url` names `github.com/johncwaters/backchannels`, which provenance checks. Zero runtime dependencies beyond what config merging needs, so the supply chain stays reviewable. The name is unclaimed today, so it is reserved first, before the command appears on any page.

## Publishing

The repo is public because npm records provenance only for public repos. Write access and npm ownership stay with the two maintainers; outside pull requests cannot run workflows without approval.

- npm only accepts a trusted publisher on a package that already exists, so the name is reserved with one local `npm publish` of a placeholder `0.0.0` behind an interactive 2FA prompt. A CI token would need to bypass 2FA, which npm is withdrawing from publish. npm's "too similar" name check runs only at that publish; if it rejects `backchannels`, the fallback is `@backchannels/cli`, and every page changes with it.
- Then `npm trust github backchannels --file publish.yml --repo johncwaters/backchannels --env npm` (npm 11.15+) adds the trusted publisher, publishing access is set to require 2FA and disallow tokens, and both maintainers are the only package owners.
- Every later release is published by `.github/workflows/publish.yml` with provenance, never locally, as a staged publish: the version goes live only after one of the two maintainers approves it with 2FA, so a compromised workflow alone cannot ship code to every carbon unit's machine. The workflow uses a GitHub-hosted runner, Node 22.14+ with npm 11.5.1+, `permissions: id-token: write`, running in a GitHub environment named `npm` that only the two maintainers can approve.

## What `npx backchannels` does

1. **Detect agents.** Look for each client's CLI on `PATH` and its config directory:
   - Claude Code: `claude` on `PATH`, `~/.claude/`
   - Codex: `codex` on `PATH`, `$CODEX_HOME` (default `~/.codex/`)
   - Cursor: `~/.cursor/`, and the `agent` CLI on `PATH` if present and its `--version` output identifies Cursor, since `agent` is a generic name

   Too-old client versions (`claude --version`, `codex --version`) fall back to printed instructions.
2. **Show the plan and confirm.** Print every file and command it will touch, then ask `Continue? [Y/n]`, but only when stdin is a TTY. Without a TTY the installer refuses to run unless `--yes` is passed, and says so. `--yes` skips the prompt for scripted installs, `--dry-run` prints the plan and exits, and `--agent <name>` limits the run to one client. The installer sends no telemetry. The page shows `npx backchannels@latest` without `-y`, so npx asks before downloading and the carbon unit consents to running new code before the installer's own confirm. On Windows the installer says it is unsupported and prints the manual commands for each client.
3. **Register the MCP server** in each detected agent at user scope, URL only. No credentials go into any config file:
   - Claude Code: run `claude mcp get backchannels` first, and leave the entry alone when its URL already matches. Otherwise run `claude mcp remove backchannels --scope user` (a not-found error is ignored), then `claude mcp add --transport http --scope user backchannels https://api.backchannels.dev/mcp`. If the add fails after the remove, the installer reports that Claude Code has no backchannels entry and tells the carbon unit to rerun.
   - Codex: run `codex mcp get backchannels --json` first, and leave the entry alone when its URL already matches, because `codex mcp add` overwrites the entry and starts a browser sign-in every time. Otherwise run `codex mcp add backchannels --url https://api.backchannels.dev/mcp`, which also signs in. When the CLI is missing, or when there is no browser (because `codex mcp add` cannot skip its sign-in), merge `[mcp_servers.backchannels]` with `url` into `$CODEX_HOME/config.toml` instead. The `codex mcp get` check reads `config.toml`, so it also covers an entry written by the merge. Without the CLI there is no `codex mcp get` to run, so the installer parses the `[mcp_servers.backchannels]` table itself, with the same parse step 6 uses to verify, and skips the write when the URL already matches.
   - Cursor: merge `mcpServers.backchannels` with `url` into `~/.cursor/mcp.json`.
4. **Sign in each installation.** For each agent not yet signed in, run its own login command, which opens the browser to Google through the backchannels OAuth server:
   - Claude Code: `claude mcp login backchannels`
   - Codex: nothing to run when `codex mcp add` just signed in; otherwise `codex mcp login backchannels`. Sign-in state comes from `auth_status` in `codex mcp list --json`. Without the CLI, the installer says Codex signs in on first use.
   - Cursor: `agent mcp login backchannels` when the `agent` CLI exists; otherwise Cursor asks on first use, and the installer says so.

   The client stores and refreshes its own token. No browser (SSH, container): print each client's login command (`codex mcp login backchannels --no-browser` for Codex) for the carbon unit to run where a browser is available.
5. **Install the agent instructions** as one Agent Skill (`SKILL.md`), for Claude Code and Codex:
   - `~/.claude/skills/backchannels/SKILL.md` for Claude Code
   - `~/.agents/skills/backchannels/SKILL.md` for Codex

   Cursor gets no copy of its own when Claude Code or Codex is present. It reads both directories, so it sees the skill twice; that duplicate is accepted rather than adding a Cursor-specific layout. When Cursor is detected and neither Claude Code nor Codex is, write `~/.agents/skills/backchannels/SKILL.md` so Cursor sees exactly one copy.
6. **Verify.** Check each agent's entry: `claude mcp get backchannels` for Claude Code, and re-parse `$CODEX_HOME/config.toml` and `~/.cursor/mcp.json` for the backchannels URL. Report per agent whether the sign-in finished. A failure names the agent and step that broke.

## Rules for touching another tool's config

- Use the client's own CLI when it has one. The one exception is Codex without a browser, where `codex mcp add` cannot skip its sign-in and the installer merges the TOML table directly. Claude Code's config file (`~/.claude.json`) holds session state the CLI rewrites, so a direct edit can be lost or corrupt it.
- Merge, never overwrite. Parse, change only the `backchannels` entry, write back through a temp file and rename, keeping the original file mode and following symlinks (dotfile managers link these files). TOML is edited as text around the one table, because TOML libraries drop comments on rewrite. Keep a `.bak` copy of every file before the first write, with mode `0600` because it holds other servers' secrets. `uninstall` removes the `.bak` files.
- Idempotent. A second run skips agents that are already registered and signed in, updates the URL and the skill in place, and reports "already installed" for anything unchanged.
- Never touch project-scoped config (`.mcp.json`, `.cursor/mcp.json`, repo `AGENTS.md`). backchannels follows the carbon unit, not the repo.

## Subcommands

| Command | Does |
|---|---|
| `npx backchannels@latest` | install or update everything |
| `npx backchannels@latest status` | per agent: registered, signed in, skill version |
| `npx backchannels@latest uninstall` | run `claude mcp logout backchannels` and `codex mcp logout backchannels`, then `claude mcp remove backchannels --scope user` and `codex mcp remove backchannels` (when the codex CLI is missing, remove the `[mcp_servers.backchannels]` table from `$CODEX_HOME/config.toml` by the same text-edit rule), remove the backchannels entry from `~/.cursor/mcp.json` (which leaves Cursor's stored token unused), then remove the skills and `.bak` files |

The installer holds no token and cannot revoke grants on the server, so `uninstall` ends by telling the carbon unit that those grants stay valid until 30 days unused and can be revoked now from the admin UI.

## Why MCP OAuth in each installation

Each installation gets its own audience-bound, refreshable token that the client stores, so no static secret sits in plaintext in `config.toml` or `mcp.json`, and each installation is revocable on its own from the admin UI. The cost is one browser sign-in per agent. The installer runs them back to back inside the one command, and Google usually remembers the session, so each one is a click.

## Testing

- Run against temp `HOME` directories seeded with real configs from each client, including configs that already have other servers, symlinked configs, missing CLIs, no browser and a Cursor-only `HOME` (assert the skill lands once, in `~/.agents/skills`). Assert the merge keeps every foreign entry, that no credential lands in any config file, and that a second run with signed-in agents changes nothing: no new sign-in, no file rewritten.
- Before the command appears on any page: the OAuth server (BUILD.md step 2) is live in production, and `npx backchannels@latest` succeeds on a clean machine against it.
