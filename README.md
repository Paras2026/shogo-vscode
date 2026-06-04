# Shogo — AI Coding Agent for VS Code

A chat sidebar powered by **Shogo Cloud**, embedded directly in VS Code. Shogo reads, edits, searches, runs commands, and analyzes your codebase — with your approval.

![VS Code](https://img.shields.io/badge/VS%20Code-1.90+-blue?logo=visual-studio-code)
![Node](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)
![License](https://img.shields.io/badge/License-MIT-yellow)

---

## Features

| Feature | Description |
|---------|-------------|
| 💬 **Chat sidebar** | Talk to an AI agent directly in the Activity Bar |
| 🤖 **Multiple models** | Switch between Hoshi 1.0, Sonnet 4.6, Claude Sonnet 4.5 |
| 📂 **Read & edit files** | Create, read, and patch files with line-number support |
| 🔍 **Search workspace** | Find code by text, regex, or indexed search |
| 🖥️ **Run commands** | Execute shell commands with safety classification |
| 🔀 **Git integration** | View git status, diff, and log |
| 📊 **Diagnostics** | Pull VS Code lint/type errors |
| 🗂️ **Project map** | Scan entire codebase structure with exported symbols |
| 🧠 **Call graph** | Build who-calls-who relationships across files |
| 💥 **Impact analysis** | Find what breaks before changing a function |
| 💀 **Dead code detection** | Find unused functions to clean up |
| 📏 **Smart readFile** | Read file sections with line numbers (for 20K+ line files) |
| 📜 **Chat history** | Sessions persist across reloads with load/delete |
| ⏱️ **Stream timeout** | 120s timeout prevents hangs on unsupported models |
| 🔐 **Secure** | API key stored in VS Code `SecretStorage` — never in settings |

---

## Install

### Option 1 — From a `.vsix` file (easiest)

1. Download `shogo-vscode-0.1.0.vsix` from the [Releases](https://github.com/Paras2026/shogo-vscode/releases) page
2. Open VS Code or Cursor
3. Press `Ctrl+Shift+P` → **Extensions: Install from VSIX...**
4. Select the `.vsix` file
5. Reload when prompted: `Ctrl+Shift+P` → **Developer: Reload Window**

Or from terminal:

```powershell
code --install-extension shogo-vscode-0.1.0.vsix --force
```

For Cursor:

```powershell
cursor --install-extension shogo-vscode-0.1.0.vsix --force
```

### Option 2 — Build from source

**Prerequisites:** Node.js 18+, npm

```bash
# 1. Clone the repo
git clone https://github.com/Paras2026/shogo-vscode.git
cd shogo-vscode

# 2. Install dependencies
npm install

# 3. Build the extension bundle
node esbuild.js

# 4. Package into .vsix
npx vsce package --no-dependencies

# 5. Install it
code --install-extension shogo-vscode-0.1.0.vsix --force
```

Then `Ctrl+Shift+P` → **Developer: Reload Window**

---

## Upgrade

### If you installed from a `.vsix`:

```powershell
# 1. Pull latest code
git fetch origin
git reset --hard origin/master

# 2. Install dependencies (only if package.json changed)
npm install

# 3. Rebuild
node esbuild.js

# 4. Repackage
npx vsce package --no-dependencies

# 5. Reinstall (force overwrites the old version)
code --install-extension shogo-vscode-0.1.0.vsix --force
```

Then `Ctrl+Shift+P` → **Developer: Reload Window**

### If you installed from VSIX download:

Just download the new `.vsix` from [Releases](https://github.com/Paras2026/shogo-vscode/releases) and run the install command again — the `--force` flag replaces the old version.

---

## First-Time Setup

1. Click the **⚡ Shogo** icon in the Activity Bar
2. Click **Set API Key** and paste your Shogo Cloud API key
3. Select a model from the dropdown (Hoshi 1.0 is default)
4. Start chatting!

---

## Usage

Open the Shogo sidebar and type a message. Shogo uses tools automatically and asks for approval before making changes.

### Examples

**Read a file:**
```
Read package.json and tell me the extension version
```

**Search code:**
```
Find all TODO comments in the project
```

**Create a file:**
```
Create a portfolio website in a folder called portfolio with index.html, style.css, and app.js
```

**Edit a file:**
```
Update the description in package.json to "AI coding agent for VS Code"
```

**Run a command:**
```
Run "npm audit" and tell me what's wrong
```

**Git status:**
```
What's the git status of the workspace?
```

**Scan the codebase:**
```
Show me the project map
```

**Impact analysis:**
```
What would break if I change the streamChat function?
```

**Dead code:**
```
Find any functions that are never called
```

---

## Built-in Tools (22)

### File & Search
| Tool | Description |
|------|-------------|
| `readFile` | Read file contents with line numbers and range support |
| `writeFile` | Create new files |
| `applyPatch` | Edit files with exact text replacement |
| `listFiles` | List files matching a glob pattern |
| `searchWorkspace` | Search code by text or regex |

### Git
| Tool | Description |
|------|-------------|
| `gitStatus` | Show `git status` output |
| `gitDiff` | Show `git diff` output |
| `gitLog` | Show recent commits |

### Execution
| Tool | Description |
|------|-------------|
| `runCommand` | Execute shell commands (with approval) |
| `getDiagnostics` | Pull VS Code lint/type errors |

### Code Intelligence
| Tool | Description |
|------|-------------|
| `codeIndex` | Find where a symbol is defined |
| `dependencyGraph` | Show what imports what |
| `projectMap` | Scan codebase structure with symbols |

### Code Graph
| Tool | Description |
|------|-------------|
| `buildCallGraph` | Build who-calls-who relationships |
| `impactAnalysis` | Find what breaks if you change a function |
| `deadCode` | Find never-called functions |
| `callChain` | Trace execution path between two functions |

### Large Codebase
| Tool | Description |
|------|-------------|
| `readFile` | Line-range support (`startLine`/`endLine`) for 20K+ line files |
| `projectMap` | Lightweight file overview before deep reading |
| `buildCallGraph` | Graph-based architecture understanding |

---

## Models

| Model | ID | Notes |
|-------|----|-------|
| **Hoshi 1.0** | `mimo-v2.5` | Default — Shogo's own model |
| **Sonnet 4.6** | `claude-sonnet-4-6` | Best for complex tasks |
| **Claude Sonnet 4.5** | `claude-sonnet-4-5` | Fallback — most reliable |

Switch models using the dropdown above the input field.

---

## Configuration

### VS Code Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `shogo.model` | `mimo-v2.5` | Model ID for the LLM |
| `shogo.includeActiveFile` | `true` | Send active file/selection as context |
| `shogo.apiUrl` | `""` | Override API base URL (blank = SDK default) |

---

## Architecture

```
VS Code (extension host)                Shogo Cloud
┌──────────────────────────────┐
│ extension.ts (activate)      │
│ ShogoViewProvider            │──── streamText ──────▶  LLM gateway
│   • owns the webview         │◀──── streamed tokens ──┘
│   • session persistence      │
│   • approval flow            │
│ auth.ts (SecretStorage)      │──── tool calls ──────▶  local workspace
│ context.ts (system prompt)   │◀──── tool results ────┘
├──────────────────────────────┤
│ agent/                       │
│   agentLoop.ts    (loop)     │
│   toolRegistry.ts (tools)    │
│   toolDefinitions.ts (schemas)│
├──────────────────────────────┤
│ tools/ (22 tools)            │
│   fileTools, editTools,      │
│   gitTools, runCommand,      │
│   diagnostics, projectMap,   │
│   codeGraphTools, codeIndex, │
│   workspace                  │
├──────────────────────────────┤
│ intelligence/                │
│   codeGraph.ts  (call graph) │
│   astIndex.ts   (AST index)  │
├──────────────────────────────┤
│ safety/                      │
│   commandPolicy.ts           │
└──────────┬───────────────────┘
           │ postMessage bridge
   ┌───────▼────────┐
   │ media/main.js  │  chat UI (webview)
   │ media/main.css │
   └────────────────┘
```

---

## Troubleshooting

### "No output generated" error
Your model may not be supported. Switch to **Claude Sonnet 4.5** in the dropdown and try again.

### Extension doesn't appear
`Ctrl+Shift+P` → **Developer: Reload Window**

### Tool calls failing
Open the Output panel: `Ctrl+Shift+P` → **Output** → dropdown → **Shogo Agent**. Check for errors.

### Model hangs with no response
The extension has a 120-second timeout. If it hangs, check your API key and model selection.

---

## License

MIT
