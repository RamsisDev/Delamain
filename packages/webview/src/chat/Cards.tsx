import { useId, useState } from "react";
import type { PendingQuestion } from "@delamain/core";
import { Button, TextArea, cx } from "../components/controls";

const OTHER = "\u0000other";

function QuestionOptions({
  question,
  choice,
  other,
  onChoice,
  onOther,
  disabled,
}: {
  question: PendingQuestion;
  choice: string | undefined;
  other: string;
  onChoice: (value: string) => void;
  onOther: (text: string) => void;
  disabled: boolean;
}) {
  const name = useId();
  return (
    <div className="options">
      {question.options.map((option) => (
        <label key={option.label} className={cx("option", option.recommended && "recommended")}>
          <input type="radio" name={name} checked={choice === option.label} disabled={disabled} onChange={() => onChoice(option.label)} />
          <span>
            {option.label}
            {option.recommended ? <span className="recommended-tag"> (recommended)</span> : null}
            {option.impact ? <span className="impact"> — {option.impact}</span> : null}
          </span>
        </label>
      ))}
      <label className="option">
        <input type="radio" name={name} checked={choice === OTHER} disabled={disabled} onChange={() => onChoice(OTHER)} />
        <span>Other…</span>
      </label>
      {choice === OTHER ? <TextArea value={other} rows={2} disabled={disabled} placeholder="Your answer" onChange={onOther} /> : null}
    </div>
  );
}

function useAnswer(question: PendingQuestion) {
  const [choice, setChoice] = useState<string | undefined>(question.options.find((o) => o.recommended)?.label);
  const [other, setOther] = useState("");
  const answer = choice === OTHER ? other.trim() : choice;
  return { choice, setChoice, other, setOther, answer };
}

function blocksLine(question: PendingQuestion): string {
  return question.blocks.length ? ` · blocks ${question.blocks.join(", ")}` : "";
}

export function DecisionCard({
  question,
  submitted,
  onSubmit,
}: {
  question: PendingQuestion;
  submitted: boolean;
  onSubmit: (id: string, answer: string) => void;
}) {
  const state = useAnswer(question);
  return (
    <div className="card decision-card">
      <div className="decision-title">⚠ Decision needed{blocksLine(question)} · everything else continues</div>
      <p className="question">{question.question}</p>
      <QuestionOptions
        question={question}
        choice={state.choice}
        other={state.other}
        onChoice={state.setChoice}
        onOther={state.setOther}
        disabled={submitted}
      />
      <Button variant="primary" disabled={!state.answer || submitted} onClick={() => state.answer && onSubmit(question.id, state.answer)}>
        {submitted ? "Sent" : "Submit"}
      </Button>
    </div>
  );
}

function BatchedItem({
  question,
  submitted,
  onAnswer,
}: {
  question: PendingQuestion;
  submitted: boolean;
  onAnswer: (answer: string | undefined) => void;
}) {
  const state = useAnswer(question);
  const update = (choice: string | undefined, other: string) => {
    onAnswer(choice === OTHER ? other.trim() || undefined : choice);
  };
  return (
    <li className="batched-item">
      <div className="muted">{question.blocks.length ? `Blocks ${question.blocks.join(", ")}` : "Non-blocking"}</div>
      <p className="question">{question.question}</p>
      <QuestionOptions
        question={question}
        choice={state.choice}
        other={state.other}
        disabled={submitted}
        onChoice={(c) => {
          state.setChoice(c);
          update(c, state.other);
        }}
        onOther={(t) => {
          state.setOther(t);
          update(state.choice, t);
        }}
      />
    </li>
  );
}

/** Questions collected once the per-session cap is reached: answered together, in one card. */
export function BatchedDecisions({
  questions,
  submitted,
  onSubmit,
}: {
  questions: PendingQuestion[];
  submitted: ReadonlySet<string>;
  onSubmit: (answers: { id: string; answer: string }[]) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string | undefined>>({});
  const answerOf = (q: PendingQuestion) => (q.id in answers ? answers[q.id] : q.options.find((o) => o.recommended)?.label);
  const ready = questions.filter((q) => !submitted.has(q.id) && answerOf(q));
  return (
    <div className="card decision-card batched">
      <div className="decision-title">
        ⚠ {questions.length} decision{questions.length === 1 ? "" : "s"} collected · the tasks they block stay paused · everything else continues
      </div>
      <ol className="batched-list">
        {questions.map((q) => (
          <BatchedItem key={q.id} question={q} submitted={submitted.has(q.id)} onAnswer={(a) => setAnswers((s) => ({ ...s, [q.id]: a }))} />
        ))}
      </ol>
      <Button variant="primary" disabled={!ready.length} onClick={() => onSubmit(ready.map((q) => ({ id: q.id, answer: answerOf(q)! })))}>
        Submit {ready.length ? `${ready.length} answer${ready.length === 1 ? "" : "s"}` : ""}
      </Button>
    </div>
  );
}

export interface CommandConfirmation {
  id: string;
  command: string;
  cwd: string;
  reason: "new" | "destructive";
}

export function CommandCard({
  confirmation,
  onAnswer,
}: {
  confirmation: CommandConfirmation;
  onAnswer: (answer: "allow" | "allow_always" | "deny") => void;
}) {
  const destructive = confirmation.reason === "destructive";
  return (
    <div className={cx("card", "command-card", destructive && "destructive")}>
      <div className="decision-title">{destructive ? "⚠ Destructive command — confirm every time" : "New command — approve once to allowlist it"}</div>
      <pre className="command">{confirmation.command}</pre>
      <div className="muted">in {confirmation.cwd}</div>
      <div className="inline">
        <Button variant={destructive ? "danger" : "primary"} onClick={() => onAnswer("allow")}>
          Allow once
        </Button>
        {destructive ? null : <Button onClick={() => onAnswer("allow_always")}>Always allow</Button>}
        <Button onClick={() => onAnswer("deny")}>Deny</Button>
      </div>
    </div>
  );
}

export function ApprovalCard({ onAnswer }: { onAnswer: (approved: boolean, note?: string) => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  return (
    <div className="card approval-card">
      <div className="decision-title">Review the result</div>
      <p>The session finished its work. Approve it, or reject it with a note: the note goes to the workers of the affected tasks.</p>
      {rejecting ? <TextArea value={note} rows={3} placeholder="What is wrong? (required)" onChange={setNote} /> : null}
      <div className="inline">
        <Button variant="primary" onClick={() => onAnswer(true)}>
          Approve
        </Button>
        {rejecting ? (
          <>
            <Button variant="danger" disabled={!note.trim()} onClick={() => onAnswer(false, note.trim())}>
              Reject with note
            </Button>
            <Button variant="link" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button onClick={() => setRejecting(true)}>Reject…</Button>
        )}
      </div>
    </div>
  );
}

export interface SessionResult {
  status: string;
  summary: string;
  branch?: string;
  files: string[];
  canCommit: boolean;
}

export function ResultCard({
  result,
  settled,
  onCommit,
  onKeep,
  onDiff,
}: {
  result: SessionResult;
  settled: boolean;
  onCommit: () => void;
  onKeep: () => void;
  onDiff: () => void;
}) {
  return (
    <div className={cx("card", "result-card", `result-${result.status}`)}>
      <div className="decision-title">Result · {result.status}</div>
      {result.summary ? <p className="summary">{result.summary}</p> : null}
      {result.branch ? (
        <div className="muted">
          Session branch <code>{result.branch}</code>
        </div>
      ) : null}
      {result.files.length ? (
        <details className="files" open={result.files.length <= 8}>
          <summary>{result.files.length} file(s) changed</summary>
          <ul className="plain-list">
            {result.files.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <div className="muted">No files changed.</div>
      )}
      <div className="inline">
        <Button variant="primary" disabled={!result.canCommit || settled} onClick={onCommit}>
          Commit to my branch
        </Button>
        <Button disabled={settled} onClick={onKeep}>
          Keep on session branch
        </Button>
        <Button onClick={onDiff}>Show diff</Button>
      </div>
    </div>
  );
}
