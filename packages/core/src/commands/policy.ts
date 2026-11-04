export type CommandSource = "flow" | "spec" | "agent" | "finding" | "setup" | "on_finish";

export interface CommandRequest {
  command: string;
  cwd: string;
  source: CommandSource;
  /** Comes from a file in the project's .harness/ folder or the spec, not the extension. */
  fromProject: boolean;
}

export type CommandApproval = "allow" | "allow_always" | "deny";

export interface AllowlistStore {
  has(command: string): Promise<boolean>;
  add(command: string): Promise<void>;
}

export interface CommandApprover {
  confirm(request: CommandRequest & { reason: "new" | "destructive" }): Promise<CommandApproval>;
}

export type GateDecision = { allowed: true } | { allowed: false; reason: string };

export class CommandGate {
  private readonly patterns: RegExp[];

  constructor(
    private readonly options: {
      trusted: boolean;
      destructivePatterns: readonly string[];
      allowlist: AllowlistStore;
      approver: CommandApprover;
    },
  ) {
    this.patterns = options.destructivePatterns.flatMap((pattern) => {
      try {
        return [new RegExp(pattern, "i")];
      } catch {
        return [];
      }
    });
  }

  isDestructive(command: string): boolean {
    return this.patterns.some((pattern) => pattern.test(command));
  }

  /**
   * Untrusted workspaces never run project commands. New commands are approved once and
   * remembered; destructive ones ask every time, inside loops too.
   */
  async authorize(request: CommandRequest): Promise<GateDecision> {
    if (!this.options.trusted) {
      return { allowed: false, reason: "The workspace is not trusted; commands do not run." };
    }
    const command = request.command.trim();
    if (this.isDestructive(command)) {
      const answer = await this.options.approver.confirm({ ...request, reason: "destructive" });
      return answer === "deny" ? { allowed: false, reason: "Destructive command denied" } : { allowed: true };
    }
    if (await this.options.allowlist.has(command)) return { allowed: true };
    const answer = await this.options.approver.confirm({ ...request, reason: "new" });
    if (answer === "deny") return { allowed: false, reason: "Command not approved" };
    if (answer === "allow_always") await this.options.allowlist.add(command);
    return { allowed: true };
  }
}
