export const DEFAULT_FLOW = `schema_version: 1
name: default
description: Principal writes the spec; workers code each task through tests, QA and the bugbot.
policy:
  escalation:
    triage: principal
    auto_triggers: [chain_exhausted, no_progress, qa_ping_pong, reviewer_conflict]
    max_per_task: 3
    pause: affected_only
    persist_decisions: project

steps:
  - id: delivery-loop
    type: loop
    max_iterations: 2
    until: final.approved
    on_exhausted: ask_user
    body:
      - id: spec
        type: agent
        agent: principal
        output: spec              # full spec on the first iteration, a delta after a rejection

      - id: build
        type: foreach
        over: spec.pending_tasks
        after: [spec]
        body:
          - id: bugbot-loop
            type: loop
            max_iterations: 2
            reset: per_parent_iteration
            until: bugbot.passed
            on_exhausted: escalate_model
            body:
              - id: qa-loop
                type: loop
                when: "loop.first or bugbot.needs_qa"
                max_iterations: 3
                reset: per_parent_iteration
                until: qa.passed
                on_exhausted: escalate_model
                body:
                  - id: test-loop
                    type: loop
                    max_iterations: 3
                    reset: per_parent_iteration
                    stop_if_no_progress: true
                    until: tests.passed
                    on_exhausted: escalate_model
                    body:
                      - id: code
                        type: agent
                        agent: worker
                        feedback: [tests.failures, qa.missing, bugbot.routed_findings]
                      - id: tests
                        type: command
                        run: "{{commands.test}}"
                        also_run: task.acceptance   # both must pass
                        parse: junit:reports/junit.xml
                  - id: qa
                    type: agent
                    agent: qa
                    input: task.acceptance_criteria
              - id: bugbot
                type: review
                agent: bugbot
                scope: task.diff
                routing: findings_routing

      - id: final-checks
        type: command
        after: [build]
        run: "{{commands.test}} && {{commands.typecheck}}"

      - id: final
        type: agent
        agent: principal
        after: [final-checks]
        input: [spec, build.diff, final-checks, bugbot.report_only]

  - id: approve
    type: approval
    mode: auto                    # auto | review
    after: [delivery-loop]
    on_reject: feedback_to_workers
`;

export const SINGLE_AGENT_FLOW = `schema_version: 1
name: single-agent
description: One agent does the whole request on the session branch, verified by the test command.
steps:
  - id: work-loop
    type: loop
    max_iterations: 3
    stop_if_no_progress: true
    until: tests.passed
    on_exhausted: ask_user
    body:
      - id: code
        type: agent
        agent: solo
        feedback: [tests.failures]
      - id: tests
        type: command
        run: "{{commands.test}}"
  - id: approve
    type: approval
    mode: review
    on_reject: feedback_to_workers
`;

export const LOCAL_ONLY_FLOW = `schema_version: 1
name: local-only
description: Same shape as the default flow, but every agent runs on local models.
policy:
  escalation:
    triage: principal
    max_per_task: 2
    pause: affected_only
    persist_decisions: project
steps:
  - id: spec
    type: agent
    agent: principal
    model: role:short-tasks
    fallback: [role:worker]
    stay_local: true
    output: spec
  - id: build
    type: foreach
    over: spec.pending_tasks
    body:
      - id: test-loop
        type: loop
        max_iterations: 3
        stop_if_no_progress: true
        until: tests.passed
        on_exhausted: escalate_to_principal
        body:
          - id: code
            type: agent
            agent: worker
            model: role:short-tasks
            fallback: [role:worker]
            stay_local: true
            feedback: [tests.failures]
          - id: tests
            type: command
            run: "{{commands.test}}"
            also_run: task.acceptance
  - id: final-checks
    type: command
    run: "{{commands.test}}"
  - id: approve
    type: approval
    mode: review
`;

export const REVIEW_ONLY_FLOW = `schema_version: 1
name: review-only
description: The bugbot reviews the uncommitted changes and reports its findings; nothing is edited.
steps:
  - id: review
    type: review
    agent: bugbot
    scope: working_tree
    routing: report_only
`;

export const VERIFY_SUBFLOW = `schema_version: 1
name: verify
description: Reusable verification - tests and types.
steps:
  - id: tests
    type: command
    run: "{{commands.test}}"
  - id: types
    type: command
    run: "{{commands.typecheck}}"
`;

export const PRESET_FLOWS: Record<string, string> = {
  default: DEFAULT_FLOW,
  "single-agent": SINGLE_AGENT_FLOW,
  "local-only": LOCAL_ONLY_FLOW,
  "review-only": REVIEW_ONLY_FLOW,
};

export const PRESET_SUBFLOWS: Record<string, string> = {
  verify: VERIFY_SUBFLOW,
};
