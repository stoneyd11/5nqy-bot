# 5nqy_devbot — Browser AI Developer Assistant

Load the `5nqy_devbot-extension` directory as an unpacked Chromium extension. The extension injects a shared agent loop and one isolated provider adapter into supported AI sites.

## Native adapters
Claude, ChatGPT, DeepSeek, Gemini, Kimi, GLM / Z.ai, Qwen, Arena and Meta AI retain the project's existing site-specific logic.

## Compatibility adapters
Mistral Vibe, Grok, Perplexity, Microsoft Copilot, Poe, HuggingChat, OpenRouter and MiniMax use `providers/generic.js`. It uses semantic DOM detection only and fails closed when the site's current DOM cannot be automated safely.

## Roblox
Roblox Studio stays the primary MCP server. Existing tool execution, project memory, screenshots, command parsing, response handling, stop/retry logic and bridge messaging are preserved.

## Testing
`node test-parser.js` and `node test-chatgpt.js`.
