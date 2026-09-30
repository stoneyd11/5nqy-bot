# 5nqy_devbot Ultra AI

Ultra AI is the multi-agent orchestration layer inside 5nqy_devbot.

## Flow

1. User submits one task.
2. 5nqy_devbot selects independent worker providers by role and health.
3. The task is split into planner/coder/Roblox/3D/QA/reviewer roles as appropriate.
4. Each worker produces an independent technical report.
5. A judge provider compares the reports and creates one implementation blueprint.
6. A final builder provider receives the blueprint and original task.
7. For Roblox tasks, the builder can use the connected Studio MCP tools to inspect, edit and verify the real project.
8. Provider quota/login failures are recorded and the next eligible provider is selected.

## Roblox DataService preset

The popup includes a `Fix DataService -> 0 verified errors` action. It targets:

`game.ServerScriptService.Services.DataService`

The final builder is explicitly told to inspect the real script and dependencies, fix verified issues, re-read the final state and verify instead of claiming that a clean result exists without evidence.

## Provider routing

Provider adapters remain isolated. Ultra AI only depends on the provider registry and the worker bridge contract, so adding a provider does not require rewriting the orchestration engine.

## Safety of automation

Research workers do not execute Roblox tools. Only the final builder stage is given tool execution permission, and it still goes through the existing 5nqy_devbot MCP bridge and agent loop.
