# Delamain

A VS Code extension that orchestrates several AI providers as a team: a **principal** writes the
spec, **workers** code each task in its own git worktree, **QA** checks the acceptance criteria,
a **bugbot** reviews the diff, and **commands** (`make test`, lint, types) deliver the verdict.
Loops are bounded, business decisions go to a human, and everything is configured in YAML or in
the visual configuration screen. The design is in [harness-orchestrator-plan.md](harness-orchestrator-plan.md).

## Packages

| Package | Contents |
|---|---|
| `packages/core` | Pure TypeScript, no VS Code or Node APIs: schema (zod → JSON Schema), layered config, router, flow engine, findings routing, escalations, agent tool loop, event tree, metrics, presets. |
| `packages/adapters` | Node adapters: Anthropic, OpenAI Responses, OpenRouter/DeepSeek/OpenAI-compatible and CLI providers, local server discovery, git worktrees, command runner, file tools, session store. |
| `packages/webview` | React UI: chat with the live subtask tree, configuration screen, block editor (React Flow). |
| `packages/extension` | The VS Code extension host: commands, SecretStorage, diagnostics, status bar, sessions. |

## Development

Requires Node 22+ and git.

```bash
npm install
npm test            # unit and integration tests (Vitest)
npm run typecheck   # tsc for every package
npm run build       # webview bundle, JSON Schemas and the extension bundle
```

Press F5 in VS Code ("Run Harness extension") to open a window with the extension loaded. Then:

1. `Harness: Open Configuration` to add providers (API keys go to SecretStorage), favorites and routing rules, or `Harness: Find Local Servers` for Jan, Ollama, LM Studio, llama.cpp and vLLM.
2. `Harness: Customize` copies the preset to `.harness/` so the project can override it.
3. Open the Harness view in the activity bar, pick an orchestration and send a message.

Configuration layers, lowest first: the preset shipped with the extension, `~/.harness/` (global)
and `<repo>/.harness/` (project). Sessions run on a `harness/<session-id>` branch; your branch is
only touched when you choose "Commit to my branch".
