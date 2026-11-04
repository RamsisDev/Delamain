import type * as vscode from "vscode";
import type { SecretReader } from "@delamain/adapters";

const PREFIX = "harness.secret.";

/** API keys live only in VS Code SecretStorage; config files hold the secret's name. */
export class Secrets implements SecretReader {
  constructor(private readonly storage: vscode.SecretStorage) {}

  get(name: string): Promise<string | undefined> {
    return Promise.resolve(this.storage.get(PREFIX + name));
  }

  async set(name: string, value: string): Promise<void> {
    await this.storage.store(PREFIX + name, value);
  }

  async delete(name: string): Promise<void> {
    await this.storage.delete(PREFIX + name);
  }

  async has(name: string): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return this.storage.onDidChange((e) => {
      if (e.key.startsWith(PREFIX)) listener();
    });
  }
}
