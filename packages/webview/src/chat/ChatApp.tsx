import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  reduceEvents,
  type ChatSettings,
  type HarnessEvent,
  type HarnessSnapshot,
  type SessionSummary,
  type SessionView,
  type ToWebview,
} from "@delamain/core";
import { Pill } from "../components/badges";
import { Collapsible, cx } from "../components/controls";
import { useHostConnection, usePersistentState, useToggleSet } from "../hooks";
import { formatCost, formatTokens } from "../util/format";
import { post } from "../vscode";
import { ApprovalCard, BatchedDecisions, CommandCard, DecisionCard, ResultCard, type CommandConfirmation, type SessionResult } from "./Cards";
import { ChatGraph } from "./ChatGraph";
import { ChatHeader, ResumeBanner } from "./ChatHeader";
import { applyEventBatch, archiveOf, principalOptions, pushArchive, userMessagesOf, type ArchivedTurn } from "./chat-model";
import { Composer } from "./Composer";
import { TaskTree } from "./TaskTree";

const DEFAULT_SETTINGS: ChatSettings = { flow: "default", approval: "auto" };
const MAX_HISTORY = 50;

function Bubble({ who, children, pending }: { who: "user" | "assistant"; children: ReactNode; pending?: boolean }) {
  return (
    <div className={cx("bubble", `bubble-${who}`, pending && "bubble-pending")}>
      <div className="bubble-who">{who === "user" ? "You" : "Principal"}</div>
      <div className="bubble-text">{children}</div>
    </div>
  );
}

function ArchivedTurnView({ turn }: { turn: ArchivedTurn }) {
  return (
    <div className="turn archived">
      <Bubble who="user">{turn.message}</Bubble>
      {turn.answer ?? turn.summary ? <Bubble who="assistant">{turn.answer ?? turn.summary}</Bubble> : null}
      <div className="turn-meta muted">
        <Pill tone={turn.status === "failed" ? "error" : turn.status === "cancelled" ? "muted" : "ok"}>{turn.status}</Pill> {formatTokens(turn.tokens)} tok ·{" "}
        {formatCost(turn.costUsd)}
      </div>
    </div>
  );
}

export function ChatApp() {
  const [settings, setSettings] = usePersistentState<ChatSettings>("settings", DEFAULT_SETTINGS);
  const [history, setHistory] = usePersistentState<ArchivedTurn[]>("history", []);
  const [pending, setPending] = usePersistentState<string | undefined>("pending", undefined);
  const [mode, setMode] = usePersistentState<"tree" | "graph">("mode", "tree");
  const [draft, setDraft] = usePersistentState("draft", "");
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [snapshot, setSnapshot] = useState<HarnessSnapshot>();
  const [running, setRunning] = useState(false);
  const [resumable, setResumable] = useState<SessionSummary[]>([]);
  const [confirmations, setConfirmations] = useState<CommandConfirmation[]>([]);
  const [result, setResult] = useState<SessionResult>();
  const [resultSettled, setResultSettled] = useState(false);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [approvalSentFor, setApprovalSentFor] = useState<string>();
  const [expanded, toggle] = useToggleSet();

  const view: SessionView = useMemo(() => reduceEvents(events), [events]);
  // Several `events` messages can arrive before React re-renders, so the log is read from here.
  const log = useRef<HarnessEvent[]>([]);
  const updateEvents = (next: HarnessEvent[]) => {
    log.current = next;
    setEvents(next);
  };

  const clearConversation = () => {
    setHistory([]);
    setPending(undefined);
    updateEvents([]);
    setResult(undefined);
    setConfirmations([]);
    setAnswered(new Set());
  };

  useHostConnection("chat", (message: ToWebview) => {
    switch (message.type) {
      case "init":
        if (message.settings) setSettings(message.settings);
        break;
      case "chat.reset":
        clearConversation();
        break;
      case "command.resolved":
        setConfirmations((list) => list.filter((c) => c.id !== message.id));
        break;
      case "harness":
        setSnapshot(message.snapshot);
        break;
      case "events": {
        const previous = log.current;
        if (message.reset) {
          const before = reduceEvents(previous);
          if (before.session && before.session !== message.events[0]?.session) {
            setHistory((h) => pushArchive(h, archiveOf(before)).slice(-MAX_HISTORY));
          }
          setResult(undefined);
          setResultSettled(false);
          setAnswered(new Set());
          setApprovalSentFor(undefined);
        }
        updateEvents(applyEventBatch(previous, message.events, message.reset));
        if (message.events.some((e) => e.type === "session.started")) setPending(undefined);
        break;
      }
      case "status":
        setRunning(message.running);
        if (!message.running) {
          setPending(undefined);
          setConfirmations([]);
        }
        break;
      case "sessions":
        setResumable(message.resumable);
        break;
      case "command.confirm":
        setConfirmations((list) => [
          ...list.filter((c) => c.id !== message.id),
          { id: message.id, command: message.command, cwd: message.cwd, reason: message.reason },
        ]);
        break;
      case "result":
        setResult({
          status: message.status,
          summary: message.summary,
          ...(message.branch ? { branch: message.branch } : {}),
          files: message.files,
          canCommit: message.canCommit,
        });
        setResultSettled(false);
        break;
      default:
        break;
    }
  });

  const transcript = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = transcript.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events, history, pending, confirmations, result]);

  const changeSettings = (next: ChatSettings) => {
    setSettings(next);
    post({ type: "chat.settings", settings: next });
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    post({ type: "chat.send", text, settings });
    // During a run the message goes to the principal and comes back as a message.user event.
    if (!running) setPending(text);
    setDraft("");
    stick.current = true;
  };

  const flows = useMemo(() => {
    const names = snapshot?.flows.filter((f) => !f.invalid).map((f) => f.name) ?? [];
    return names.includes(settings.flow) ? names : [settings.flow, ...names];
  }, [snapshot, settings.flow]);
  const principals = useMemo(() => principalOptions(snapshot?.merged.models), [snapshot]);
  const activeFlow = snapshot?.flows.find((f) => f.name === (view.flow ?? settings.flow))?.flow;

  const questions = view.questions.filter((q) => !q.batched);
  const batched = view.questions.filter((q) => q.batched);
  const extraUserMessages = userMessagesOf(events).filter((text, i) => !(i === 0 && text === view.message));
  const showPending = pending !== undefined && !(view.session && view.message === pending);
  const empty = !history.length && !view.session && !showPending;

  return (
    <div className="chat-app">
      <ChatHeader settings={settings} flows={flows} principals={principals} running={running} onChange={changeSettings} />
      {resumable.length ? (
        <ResumeBanner
          sessions={resumable}
          onResume={(id) => post({ type: "session.resume", id })}
          onDiscard={(id) => post({ type: "session.discard", id })}
        />
      ) : null}

      <div
        className="transcript"
        ref={transcript}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {empty ? (
          <div className="empty muted">
            <p>Describe what you want. The principal answers directly or starts the selected orchestration.</p>
            <p>Subtasks, decisions and the result appear here as the session runs.</p>
          </div>
        ) : null}

        {history
          .filter((turn) => turn.session !== view.session)
          .map((turn) => (
            <ArchivedTurnView key={turn.session} turn={turn} />
          ))}

        {view.session ? (
          <div className="turn">
            {view.message !== undefined ? <Bubble who="user">{view.message}</Bubble> : null}
            {extraUserMessages.map((text, i) => (
              <Bubble key={i} who="user">
                {text}
              </Bubble>
            ))}

            {view.rows.length ? (
              <div className="card run-card">
                <div className="card-header">
                  <strong>{view.flow ?? "Orchestration"}</strong>
                  <Pill tone={view.status === "failed" ? "error" : view.status === "paused" ? "warning" : view.status === "running" ? undefined : "ok"}>
                    {view.status}
                  </Pill>
                  {view.specVersion ? <span className="muted">spec v{view.specVersion}</span> : null}
                  <span className="spacer" />
                  <div className="segmented" role="radiogroup" aria-label="View">
                    {(["tree", "graph"] as const).map((m) => (
                      <button key={m} type="button" role="radio" aria-checked={mode === m} className={cx("segment", mode === m && "segment-on")} onClick={() => setMode(m)}>
                        {m === "tree" ? "Tree" : "Graph"}
                      </button>
                    ))}
                  </div>
                </div>
                {mode === "graph" ? (
                  activeFlow ? (
                    <ChatGraph flow={activeFlow} rows={view.rows} />
                  ) : (
                    <p className="muted">The flow "{view.flow ?? settings.flow}" is not available to draw.</p>
                  )
                ) : (
                  <TaskTree
                    rows={view.rows}
                    text={view.text}
                    expanded={expanded}
                    onToggle={toggle}
                    running={running}
                    onAction={(task, action) => post({ type: "task.action", task, action })}
                    onOpen={(key) => post({ type: "step.open", key })}
                  />
                )}
              </div>
            ) : null}

            {questions.map((q) => (
              <DecisionCard
                key={q.id}
                question={q}
                submitted={answered.has(q.id)}
                onSubmit={(id, answer) => {
                  post({ type: "question.answer", id, answer });
                  setAnswered((s) => new Set([...s, id]));
                }}
              />
            ))}
            {batched.length ? (
              <BatchedDecisions
                questions={batched}
                submitted={answered}
                onSubmit={(answers) => {
                  for (const { id, answer } of answers) post({ type: "question.answer", id, answer });
                  setAnswered((s) => new Set([...s, ...answers.map((a) => a.id)]));
                }}
              />
            ) : null}

            {view.approval && approvalSentFor !== view.approval.key ? (
              <ApprovalCard
                onAnswer={(approved, note) => {
                  post({ type: "approval.answer", approved, ...(note ? { note } : {}) });
                  setApprovalSentFor(view.approval?.key);
                }}
              />
            ) : null}

            {view.answer !== undefined ? <Bubble who="assistant">{view.answer}</Bubble> : null}
            {view.summary && view.summary !== view.answer && !result ? <div className="summary muted">{view.summary}</div> : null}

            {view.decisions.length ? (
              <Collapsible title={`Decision log (${view.decisions.length})`}>
                <ul className="plain-list">
                  {view.decisions.map((d) => (
                    <li key={d.id}>
                      <strong>{d.id}</strong> {d.answer} <span className="muted">— {d.decidedBy}</span>
                    </li>
                  ))}
                </ul>
              </Collapsible>
            ) : null}
            {view.warnings.length ? (
              <Collapsible title={`⚠ ${view.warnings.length} warning${view.warnings.length === 1 ? "" : "s"}`}>
                <ul className="plain-list">
                  {view.warnings.map((w, i) => (
                    <li key={i} className="issue-warning">
                      {w}
                    </li>
                  ))}
                </ul>
              </Collapsible>
            ) : null}
          </div>
        ) : null}

        {showPending ? (
          <Bubble who="user" pending>
            {pending}
          </Bubble>
        ) : null}

        {confirmations.map((c) => (
          <CommandCard
            key={c.id}
            confirmation={c}
            onAnswer={(answer) => {
              post({ type: "command.answer", id: c.id, answer });
              setConfirmations((list) => list.filter((x) => x.id !== c.id));
            }}
          />
        ))}

        {result ? (
          <ResultCard
            result={result}
            settled={resultSettled}
            onCommit={() => {
              post({ type: "result.commit" });
              setResultSettled(true);
            }}
            onKeep={() => {
              post({ type: "result.keep" });
              setResultSettled(true);
            }}
            onDiff={() => post({ type: "result.diff" })}
          />
        ) : null}
      </div>

      <Composer
        draft={draft}
        running={running}
        tokens={view.tokens}
        costUsd={view.costUsd}
        onDraft={setDraft}
        onSend={send}
        onStop={() => post({ type: "chat.cancel" })}
        onNewChat={() => {
          post({ type: "chat.new" });
          clearConversation();
        }}
      />
    </div>
  );
}
