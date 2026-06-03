# Shogo — AI Coding Agent for VS Code

A chat sidebar powered by **Shogo Cloud**, embedded directly in VS Code. Shogo reads, edits, searches, and runs commands in your workspace — with your approval.

![VS Code](https://img.shields.io/badge/VS%20Code-1.90+-blue?logo=visual-studio-code)
![Node](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)
![License](https://img.shields.io/badge/License-MIT-yellow)

---

## Features

| Feature | Description |
|---------|-------------|
| 💬 **Chat sidebar** | Talk to an AI agent directly in the Activity Bar |
| 📂 **Read & edit files** | Create, read, and patch files with approval |
| 🔍 **Search workspace** | Find code by text, regex, or indexed search with context lines |
| 🖥️ **Run commands** | Execute shell commands with output capture |
| 🔀 **Git integration** | View git status and diff without leaving VS Code |
| 📊 **Diagnostics** | Pull VS Code lint/type errors for the active file |
| 🗂️ **Workspace index** | Lexical code index for fast semantic-like search |
| ⚙️ **Configurable** | Agent config, rules, max steps, and approval mode |
| 🔐 **Secure** | API key stored in VS Code `SecretStorage` — never in settings |
| 🎨 **Theme-aware** | Matches your VS Code light/dark theme |
| 📝 **Chat history** | Conversations saved to `.shogo/history/` for reference |

---

## Quick Install (Pre-built)

### Option 1 — From a `.vsix` file

1. Download `shogo-vscode-0.1.0.vsix` from the [Releases](https://github.com/Paras2026/shogo-vscode/releases) page (or build it yourself — see below)
2. Open VS Code or Cursor
3. Press `Ctrl+Shift+P` → **Extensions: Install from VSIX...**
4. Select the `.vsix` file
5. Reload when prompted (`Ctrl+Shift+P` → **Developer: Reload Window**)

### Option 2 — From CLI

```bash
code --install-extension shogo-vscode-0.1.0.vsix --force
```

Or for Cursor:

```bash
cursor --install-extension shogo-vscode-0.1.0.vsix --force
```

---

## Build from Source

### Prerequisites

- **Node.js 18+** and **npm** (or **bun**)
- **VS Code 1.90+** or **Cursor**
- A **Shogo Cloud API key** (starts with `shogo_sk_`)

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/Paras2026/shogo-vscode.git
cd shogo-vscode/shogo-vscode

# 2. Install dependencies
npm install

# 3. Typecheck
npm run typecheck

# 4. Package the extension
npm run package
```

This produces `shogo-vscode-0.1.0.vsix` in the project folder.

### Install the built extension

```bash
code --install-extension shogo-vscode-0.1.0.vsix --force
```

### Develop mode (F5)

```bash
npm run watch    # starts the bundler in watch mode
```

Then open the `shogo-vscode` folder in VS Code and press **F5** to launch the Extension Development Host.

---

## First-Time Setup

1. Click the **Shogo** icon (⚡) in the Activity Bar
2. Click **Set API Key** and paste your `shogo_sk_...` key
3. Start chatting!

---

## Usage

Open the Shogo sidebar and type a message. Shogo will automatically detect when you need a tool and ask for your approval before making changes.

### Example prompts

**Read a file:**
```
Read package.json and tell me the extension version.
```

**Search code:**
```
Search for ShogoViewProvider with 3 context lines.
```

**Regex search:**
```
Find all TODO comments using regex: /TODO|FIXME/i
```

**Git status:**
```
Show git status.
```

**Git diff:**
```
Show git diff.
```

**Create a file:**
```
Create a test file with "hello world"
```

**Edit a file:**
```
Update the description in package.json to "AI coding agent for VS Code"
```

**Run a command:**
```
Run "npm audit" and tell me what's wrong
```

**List files:**
```
List all TypeScript files in src/agent/
```

**Index and search:**
```
Index this workspace, then search for agentLoop
```

**Diagnostics:**
```
Show any errors in the current file
```

---

## Built-in Tools

| Tool | What it does |
|------|-------------|
| `readFile` | Read file contents with line numbers |
| `listFiles` | List files matching a glob pattern |
| `searchWorkspace` | Search code by text or regex with context lines |
| `applyPatch` | Edit files with exact old/new text replacement |
| `writeFile` | Create new files or overwrite small files |
| `runCommand` | Execute shell commands (with approval) |
| `gitStatus` | Show `git status` output |
| `gitDiff` | Show `git diff` output |
| `getDiagnostics` | Pull VS Code lint/type errors |
| `indexWorkspace` | Build a lexical code index (FlexSearch) |
| `searchIndex` | Search the built index |

---

## Configuration

### VS Code Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `shogo.model` | `claude-sonnet-4-5` | Model ID for the Shogo Cloud LLM |
| `shogo.includeActiveFile` | `true` | Send active file/selection as context |
| `shogo.apiUrl` | `""` | Override API base URL (blank = SDK default) |

### Agent Config (`.shogo/agent.json`)

Create this file in your workspace root to customize agent behavior:

```json
{
  "approvalMode": "ask",
  "maxToolSteps": 16,
  "preferredSearch": "workspace",
  "autoIndex": false
}
```

| Field | Options | Description |
|-------|---------|-------------|
| `approvalMode` | `"ask"` / `"auto"` | Whether tool calls need approval |
| `maxToolSteps` | `1`–`20` | Max tool calls per conversation turn |
| `preferredSearch` | `"workspace"` / `"index"` | Default search strategy |
| `autoIndex` | `true` / `false` | Auto-index workspace on first message |

### Agent Rules (`.shogo/rules.md`)

Add project-specific instructions for Shogo to follow:

```markdown
# Project Rules

- Always use TypeScript strict mode
- Prefer named exports over default exports
- Run `npm run typecheck` before claiming edits are done
- Never modify files in src/generated/
```

---

## Chat History

Conversations are saved automatically to:

```
.shogo/history/
  chat-2025-01-15T10-30-00.json    ← full transcript
  chat-2025-01-15T10-30-00.md      ← readable markdown
```

These files are gitignored by default.

---

## Remote / SSH / VPS

Shogo works on **Linux, macOS, and Windows** — including remote environments:

- **VS Code Remote SSH** — install the extension on the remote side
- **Cursor Remote SSH** — same approach, choose "Install in SSH: \<hostname\>"
- **WSL** — works natively

Shell commands are auto-detected per platform:
- **Windows** → `cmd.exe /c`
- **macOS** → `/bin/zsh -c`
- **Linux** → `/bin/sh -c`

---

## Commands

| Command | Description |
|---------|-------------|
| `Shogo: Set API Key` | Store or update your Shogo Cloud key |
| `Shogo: Clear API Key` | Remove the stored key |
| `Shogo: New Chat` | Reset the conversation |

---

## Architecture

```
VS Code (extension host)                  Shogo Cloud
┌──────────────────────────────┐
│ extension.ts (activate)      │
│ ShogoViewProvider            │──── streamText ──────▶  LLM gateway
│   • owns the webview         │◀──── streamed tokens ──┘
│   • chat history             │
│   • agent loop               │──── tool calls ──────▶  local workspace
│ auth.ts (SecretStorage)      │◀──── tool results ────┘
│ context.ts (workspace)       │
├──────────────────────────────┤
│ agent/                       │
│   agentLoop.ts    (loop)     │
│   toolRegistry.ts (tools)    │
│   types.ts         (types)   │
├──────────────────────────────┤
│ tools/                       │
│   fileTools.ts     (read/    │
│                     search)  │
│   editTools.ts     (patch/   │
│                     write)   │
│   runCommand.ts    (shell)   │
│   gitTools.ts      (git)     │
│   diagnostics.ts   (lint)    │
│   indexTools.ts    (index)   │
│   workspace.ts     (utils)   │
├──────────────────────────────┤
│ safety/                      │
│   commandPolicy.ts (block    │
│                     risky)   │
└──────────┬───────────────────┘
           │ postMessage bridge
   ┌───────▼────────┐
   │ media/main.js  │  chat UI (webview)
   │ media/main.css │
   └────────────────┘
```

The API key lives only in the extension host. The webview never sees it.

---

## Roadmap

- [ ] Tree-sitter code parsing for smarter chunking
- [ ] Semantic embeddings for meaning-based search
- [ ] Native AI SDK structured tool calling
- [ ] Git branch/worktree agents
- [ ] Multi-file edit in one tool call
- [ ] Inline chat for selected code blocks
- [ ] Tool result caching
- [ ] MCP tool server integration

---

## Contributing

1. Fork the repo
2. Create a branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Typecheck: `npm run typecheck`
5. Package: `npm run package`
6. Test: `code --install-extension shogo-vscode-0.1.0.vsix --force`
7. Submit a PR

---

## License

MIT
