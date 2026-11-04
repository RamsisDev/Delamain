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
npx playwright install chromium # once, for browser QA
npm run test:ui     # interaction and layout checks against the built webview
npm run package    # rebuild everything and create packages/extension/delamain-harness-0.1.0.vsix
```

Press F5 in VS Code ("Run Harness extension") to open a window with the extension loaded. Then:

1. `Harness: Open Configuration` to add providers (API keys go to SecretStorage), favorites and routing rules, or `Harness: Find Local Servers` for Jan, Ollama, LM Studio, llama.cpp and vLLM.
2. `Harness: Customize` copies the preset to `.harness/` so the project can override it.
3. Open the Harness view in the activity bar, pick an orchestration and send a message.

Configuration layers, lowest first: the preset shipped with the extension, `~/.harness/` (global)
and `<repo>/.harness/` (project). Sessions run on a `harness/<session-id>` branch; your branch is
only touched when you choose "Commit to my branch".

## Codex CLI and Claude CLI

With both official CLIs installed and signed in, run:

```bash
npm run setup:cli
npm run cli:codex   # interactive Codex terminal
npm run cli:claude  # interactive Claude terminal
```

The setup detects the executables (including Claude's native installation outside PATH), checks
authentication without printing credentials, and adds missing providers and favorites to
`.harness/config.yml`. Existing settings are preserved. Native executable paths may be specific to
your machine; inspect the generated configuration before sharing it. Authentication stays with
each CLI. See the official [Codex authentication documentation](https://learn.chatgpt.com/docs/auth)
and [Claude CLI reference](https://code.claude.com/docs/en/cli-reference).

New setups use `single-agent` with review approval, Codex as the principal/worker and Claude as
the fallback/QA/reviewer. Both providers receive prompts through stdin, which avoids Windows
command-line length and multiline quoting problems. Windows CLI providers configured with
`prompt_input: argument` must switch to `stdin` for multiline prompts.

VS Code also has `harness: Codex CLI` and `harness: Claude CLI` tasks, with dedicated terminals.
F5 opens the extension with this repository loaded. In **Harness: Open Configuration**, select
**Project** to inspect the providers, test their connections and run a dry run.

Each CLI enforces its own permissions, independently of Harness's command approval. Claude's
`acceptEdits` mode can edit files but may deny test commands in a non-interactive run. Approve the
specific commands needed by your project through Claude's permission settings or its
`--allowedTools` option. The isolated QA fixture used `--allowedTools "Bash(node --test)"
"PowerShell(node --test)"`; setup does not change existing permissions. See
[Claude's non-interactive permissions](https://code.claude.com/docs/en/headless#auto-approve-tools).
CLI token usage and cost are currently unknown; the displayed zero is not a billing estimate.

See [QA.md](QA.md) for the tested features, results and remaining runtime requirements.

## License

[PolyForm Small Business License 1.0.0](LICENSE). Free for individuals, non-commercial use and
small businesses (fewer than 100 people and under USD 1,000,000 in yearly revenue, adjusted for
inflation). Larger organizations need a commercial license from the author.
