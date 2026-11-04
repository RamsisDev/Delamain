/** Copied to .harness/decisions/_REFERENCE.md so any agent can write, fix or convert decisions. */
export const DECISIONS_REFERENCE = `# Harness decision files — reference for AI agents

Decisions are business answers given during a harness session (by a human, or by the principal
when the answer was already written down). Every agent sees them in its context from then on.
They are saved under \`.harness/decisions/\`, one YAML file per session, and loaded by later
sessions. Files whose name starts with \`_\` are ignored.

## File format

\`\`\`yaml
schema_version: 1          # required, always 1 for this format
decisions:
  - id: D4                 # required, unique within the file: D followed by a number
    question: Should 409 from the partner API be retried?   # required
    answer: Retry 409 as transient, max 3 attempts          # required
    decided_by: human      # required: human | principal
    spec_version: 2        # optional: spec version the decision produced
    affects: [AC2]         # optional: acceptance criteria ids it changes
    task: t2               # optional: task that raised it
    date: 2026-11-02T14:17:00.000Z   # optional: ISO 8601
\`\`\`

## Rules

- Unknown keys are rejected. Keep the keys above, spelled exactly.
- \`decided_by: principal\` only when the answer is already in the spec, the code or a document;
  put the source in the answer, e.g. "Retry 409 (docs/partner-api.md line 88)".
- An answer is a decision, not a discussion: one or two sentences, phrased as the rule to follow.
- To change a decision, add a new one that supersedes it and say so in the answer
  ("Supersedes D4: ..."); do not rewrite history.
- To convert notes from elsewhere (tickets, meeting notes), create one entry per decision with
  \`decided_by: human\` and leave \`spec_version\` out.

## Validation

The JSON Schema is shipped with the extension (\`schemas/decisions.schema.json\`); VS Code shows
errors while editing when the YAML extension is installed, and the harness reports them in the
Problems panel either way.
`;
