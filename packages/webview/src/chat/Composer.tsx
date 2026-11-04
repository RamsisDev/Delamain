import { Button } from "../components/controls";
import { formatCost, formatTokens } from "../util/format";

export function Composer({
  draft,
  running,
  tokens,
  costUsd,
  onDraft,
  onSend,
  onStop,
  onNewChat,
}: {
  draft: string;
  running: boolean;
  tokens: number;
  costUsd: number;
  onDraft: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  onNewChat: () => void;
}) {
  return (
    <footer className="composer">
      <div className="composer-meta">
        <span title="Tokens and cost of this session">
          {formatTokens(tokens)} tok · {formatCost(costUsd)}
        </span>
        <span className="spacer" />
        {running ? (
          <Button small variant="danger" onClick={onStop}>
            Stop
          </Button>
        ) : null}
        <Button small disabled={running} title={running ? "Stop the running session first" : "Start a new conversation"} onClick={onNewChat}>
          New chat
        </Button>
      </div>
      <div className="composer-input">
        <textarea
          className="input textarea"
          rows={3}
          value={draft}
          placeholder={
            running
              ? "Message the principal: it decides whether to stop the session or adjust the affected tasks"
              : "Ask or describe the change (Enter sends, Shift+Enter for a new line)"
          }
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <Button variant="primary" disabled={!draft.trim()} onClick={onSend}>
          Send
        </Button>
      </div>
    </footer>
  );
}
