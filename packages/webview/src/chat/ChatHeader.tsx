import type { ChatSettings, SessionSummary } from "@delamain/core";
import { Button, Select, toOptions } from "../components/controls";
import { formatTime } from "../util/format";
import type { PrincipalOption } from "./chat-model";

export function ChatHeader({
  settings,
  flows,
  principals,
  running,
  onChange,
}: {
  settings: ChatSettings;
  flows: string[];
  principals: PrincipalOption[];
  running: boolean;
  onChange: (settings: ChatSettings) => void;
}) {
  return (
    <header className="chat-header">
      <label className="header-control">
        <span>Orchestration</span>
        <Select value={settings.flow} options={toOptions(flows)} onChange={(flow) => flow && onChange({ ...settings, flow })} />
      </label>
      <label className="header-control">
        <span>Principal</span>
        <Select
          value={settings.principal}
          empty="Router default"
          options={principals}
          onChange={(principal) => {
            const { principal: _old, ...rest } = settings;
            onChange(principal ? { ...rest, principal } : rest);
          }}
        />
      </label>
      <label className="header-control">
        <span>Approval</span>
        <Select<"auto" | "review">
          value={settings.approval}
          options={[
            { value: "auto", label: "automatic" },
            { value: "review", label: "review" },
          ]}
          onChange={(approval) => approval && onChange({ ...settings, approval })}
        />
      </label>
      {running ? <div className="muted header-note">Changes apply from the next message.</div> : null}
    </header>
  );
}

export function ResumeBanner({
  sessions,
  onResume,
  onDiscard,
}: {
  sessions: SessionSummary[];
  onResume: (id: string) => void;
  onDiscard: (id: string) => void;
}) {
  return (
    <div className="banner banner-warning resume-banner">
      <strong>Unfinished session{sessions.length === 1 ? "" : "s"}</strong>
      <ul className="plain-list">
        {sessions.map((s) => (
          <li key={s.id}>
            <div className="resume-message" title={s.message}>
              {s.message}
            </div>
            <div className="muted">
              {s.flow} · started {formatTime(s.startedAt)} · {s.status}
            </div>
            <div className="inline">
              <Button small variant="primary" onClick={() => onResume(s.id)}>
                Resume
              </Button>
              <Button small onClick={() => onDiscard(s.id)}>
                Discard
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
