import { stringify } from "yaml";
import type { Decision, Escalation } from "../schema/escalation.ts";
import type { Spec, TaskSpec } from "../schema/spec.ts";
import type { AgentMode } from "../flow/ports.ts";

export function renderYaml(value: unknown): string {
  return stringify(value, { lineWidth: 100 }).trimEnd();
}

export function section(title: string, body: string | undefined): string {
  if (!body?.trim()) return "";
  return `## ${title}\n\n${body.trim()}\n`;
}

export function renderTask(task: TaskSpec): string {
  return "```yaml\n" + renderYaml(task) + "\n```";
}

export function renderSpec(spec: Spec | undefined): string | undefined {
  if (!spec) return undefined;
  return "```yaml\n" + renderYaml(spec) + "\n```";
}

export function renderDecisions(decisions: readonly Decision[]): string | undefined {
  if (!decisions.length) return undefined;
  return decisions
    .map((d) => `- ${d.id} (${d.decided_by}): ${d.question} → ${d.answer}${d.affects.length ? ` [affects ${d.affects.join(", ")}]` : ""}`)
    .join("\n");
}

export function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  return "```yaml\n" + renderYaml(value) + "\n```";
}

export function renderNamed(items: readonly { name: string; value: unknown }[]): string | undefined {
  const present = items.filter(({ value }) => !isEmpty(value));
  if (!present.length) return undefined;
  return present.map(({ name, value }) => `### ${name}\n\n${renderValue(value)}`).join("\n\n");
}

export function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

export function modeInstructions(mode: AgentMode, details: { message?: string; task?: TaskSpec; iteration?: number }): string {
  switch (mode) {
    case "spec":
      return [
        `User request:\n\n${details.message ?? ""}`,
        "",
        details.iteration && details.iteration > 1
          ? "The previous delivery was rejected (see the feedback). Submit the updated spec with submit_spec: keep finished tasks that are fine unchanged, change or add only what is needed, and list in `reopen` the finished tasks that must start over."
          : "Investigate with the read-only tools, then either call `answer` (questions, trivial requests) or `submit_spec` with the tasks.",
      ].join("\n");
    case "verify":
      return [
        `User request:\n\n${details.message ?? ""}`,
        "",
        "Every task passed its own checks. Verify the combined result against the spec: read the diff, the final checks and the reported findings. Call submit_verdict with approved=true, or approved=false and the tasks to reopen with a note for each.",
      ].join("\n");
    case "triage":
      return "An agent raised an escalation. Decide with submit_triage: resolve it yourself only when the answer is already in the spec, the code or the documents (cite where); reject it when the agent missed something (reply with where it is); otherwise ask the human with 2 to 4 options, a recommendation and the impact of each.";
    case "steer":
      return `The user sent a message while the session is running:\n\n${details.message ?? ""}\n\nDecide with submit_steer whether to stop the whole session or keep it running. If it keeps running and the message changes requirements, list the affected tasks and what changes; unaffected tasks continue as they are.`;
    case "work":
      return `Execute task ${details.task?.id ?? ""}. Edit only the files in \`edit\`, write the tests in the test plan, run the acceptance commands, then call finish.`;
    case "fix":
      return `Fix the review findings below for task ${details.task?.id ?? ""}. Change only what each finding needs, stay inside the files in \`edit\`, then call finish.`;
    case "qa":
      return `Check task ${details.task?.id ?? ""} against each acceptance criterion. You may add tests, only in the task's test files. Then call submit_qa.`;
    case "review":
      return "Review the diff below and call submit_findings with the classified findings (an empty list when it is fine).";
  }
}

export function renderEscalation(escalation: Escalation): string {
  return "```yaml\n" + renderYaml(escalation) + "\n```";
}

export const DIFF_MODE_INSTRUCTIONS = `You cannot call tools. Reply with your changes as one unified diff in a \`\`\`diff block
(--- a/<path> and +++ b/<path> headers, @@ hunks with 3 lines of context). Only change the files you
were allowed to edit. If the step asks you to submit a result, add it after the diff as a
\`\`\`json block with the fields of that submission.`;
