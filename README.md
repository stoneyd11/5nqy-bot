# 5nqy_devbot — AI Developer Assistant

5nqy_devbot is a Chromium browser extension plus a local Python WebSocket bridge for developer workflows, with Roblox Studio MCP as the primary automation target. The project keeps site-specific automation inside isolated provider adapters so one site changing does not take down the rest of the stack.

## What is included

- Native provider adapters: Claude, ChatGPT, DeepSeek, Gemini, Kimi, GLM / Z.ai, Qwen, Arena, Meta AI.
- Compatibility adapters: Mistral Vibe, Grok, Perplexity, Microsoft Copilot, Poe, HuggingChat, OpenRouter, MiniMax.
- MiMo model support is represented through model-routing/catalog workflows such as OpenRouter rather than a fabricated standalone MiMo website integration.
- Roblox Studio workflows: scripts, ModuleScripts, LocalScripts, Luau execution, UI/game-tree inspection, MCP tools, screenshots, debugging and persistent project context.
- Browser command shortcut: Ctrl+Shift+Y toggles the assistant panel on supported tabs.
- Settings page with provider preferences, theme, automation, notifications, compact mode and experimental-provider controls.

The provider catalogue deliberately distinguishes native adapters from generic compatibility adapters. Generic adapters use semantic DOM heuristics and fail closed when they cannot safely identify a composer or response.

## Install the extension

1. Extract this package.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `5nqy_devbot-extension` folder.
6. Open the extension's **Settings** page to select defaults.

## Run the local bridge

### Windows
Double-click `start.bat`. Keep the terminal open while using Studio.

### macOS / Linux
Run `MacOS_Start.command` from the extracted folder.

The bridge listens on a local WebSocket and launches/monitors the configured MCP servers in `config.json`. Roblox Studio remains the primary server and the bridge keeps the existing server-isolation/restart behavior.

## Roblox Studio

Open a Place in Roblox Studio and enable Studio as an MCP server. Then open one of the supported AI chat sites, start a 5nqy_devbot session and describe the work you need.

The existing one-command-at-a-time command protocol is retained. The project memory workflow now refers to the `game.ServerStorage["5nqy_devbot"].Memory` location for new sessions.

## Architecture

```text
5nqy_devbot-extension/
  core/
    config.js             shared prompt/feedback/tool metadata
    parser.js             command parsing
    provider-registry.js  provider catalogue + generic metadata
    settings-core.js      persisted settings schema
    theme.js              storage-driven theme bridge
    main.js               provider-agnostic agent loop + UI
  providers/
    <native adapters>     isolated selectors/DOM logic
    generic.js            conservative compatibility adapter
  background.js            local bridge WebSocket + browser commands
  popup.html / popup.js    compact control surface
  settings.html/js/css     full settings application

bridge.py                  resilient local MCP bridge
launch_studio_mcp.py       Studio MCP process launcher
config.json                MCP server registry
start.bat                  Windows bootstrapper
MacOS_Start.command        macOS/Linux bootstrapper
```

## Validation

Run from `5nqy_devbot-extension`:

- `node test-parser.js`
- `node test-chatgpt.js`

The repository is dependency-light: the bridge needs Python 3.9+ and the `websockets` package.

## Provider notes

Provider website structures change frequently. The current catalogue distinguishes tested native adapters from generic compatibility adapters, and generic adapters show that limitation in the UI instead of pretending a site is fully supported. OpenRouter exposes a broad catalog of models and providers through one interface, and HuggingChat is an open-source-model chat surface, so these are treated as routing/catalog layers rather than duplicated model implementations.


## Ultra AI
`5nqy_devbot` now includes an Ultra AI orchestration mode. One task can be split across multiple independent AI workers, compared by a judge, and handed to a final builder. Roblox tasks can use the connected Studio MCP during the final build stage.

The system also tracks provider availability and quota/limit failures so the next eligible provider can be selected instead of repeatedly using a blocked provider.
