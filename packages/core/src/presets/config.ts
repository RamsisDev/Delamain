/** Preset layer shipped with the extension. Every other layer only overrides what it changes. */
export const PRESET_CONFIG_YAML = `schema_version: 1

# Project commands. Flows and findings routing reference them as {{commands.<name>}}.
commands:
  test: make test
  typecheck: make typecheck
  lint: make lint
  fmt: make fmt

router:
  thresholds:
    short:  { max_tokens: 4000,  max_files: 2 }
    medium: { max_tokens: 30000, max_files: 8 }
  context_margin_tokens: 2000
  rules:
    - name: Short tasks to short-task models
      when: { size: short, kind: [rename, docstring, format, small-edit] }
      use: role:short-tasks
      fallback: [role:worker]
    - name: Tests and refactors
      when: { kind: [tests, refactor], size: [short, medium] }
      use: role:worker
      fallback: [role:orchestrator-fallback]
  default:
    use: role:orchestrator
    fallback: [role:orchestrator-fallback]

findings_routing:
  - name: Minor with no impact
    when: { severity: low, affects_ac: none, behavior_change: false }
    route: report_only
  - default:
      route: worker_then_qa

limits:
  max_loop_iterations: 5
  max_nested_loops: 4
  worst_case_warning: 20
  max_escalations_per_task: 3
  max_human_questions_per_session: 5
  command_timeout_default: 300s
  max_agent_turns: 40
  output_tail_lines: 80
  session:
    max_minutes: 60
    on_time_exhausted: fallback
    per_profile:
      max_tokens: 500000
      max_cost_usd: 5

discovery:
  enabled: true
  timeout_ms: 300
  refresh_seconds: 60
  servers:
    - { id: jan,       label: Jan,              base_url: "http://localhost:1337/v1" }
    - { id: ollama,    label: Ollama,           base_url: "http://localhost:11434/v1" }
    - { id: lmstudio,  label: LM Studio,        base_url: "http://localhost:1234/v1" }
    - { id: llamacpp,  label: llama.cpp server, base_url: "http://localhost:8080/v1" }
    - { id: vllm,      label: vLLM,             base_url: "http://localhost:8000/v1" }

security:
  destructive_patterns:
    - '\\brm\\s+-[a-zA-Z]*[rf]'
    - '\\bgit\\s+push\\b'
    - '\\bgit\\s+reset\\s+--hard\\b'
    - '\\bgit\\s+clean\\s+-[a-zA-Z]*f'
    - '\\bgit\\s+checkout\\s+--\\s'
    - '\\bgit\\s+branch\\s+-D\\b'
    - '\\bdd\\s+if='
    - '\\bmkfs\\b'
    - '\\bchmod\\s+-R\\b'
    - '\\bsudo\\b'
    - '\\bcurl\\b[^|]*\\|\\s*(sh|bash)'
    - '\\bdrop\\s+(table|database)\\b'
    - '\\bnpm\\s+publish\\b'

safeguard:
  line_margin: 3

defaults:
  flow: default
  approval: auto
`;
