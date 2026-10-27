// Logs agent sessions and autocomplete feedback as JSONL so they can be used
// to fine-tune your own model later. Nothing is ever sent anywhere.

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ChatMessage } from './llm';

export class TrainingLogger {
  constructor(private readonly context: vscode.ExtensionContext) {}

  get dir(): string {
    const configured = vscode.workspace.getConfiguration('perdev').get<string>('dataDir');
    return configured && configured.trim() ? configured : this.context.globalStorageUri.fsPath;
  }

  private get enabled(): boolean {
    return vscode.workspace.getConfiguration('perdev').get<boolean>('logTrainingData', true);
  }

  private async append(file: string, record: object) {
    if (!this.enabled) return;
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.appendFile(path.join(this.dir, file), JSON.stringify(record) + '\n', 'utf8');
    } catch (e) {
      console.error('PerDev: failed to write training log', e);
    }
  }

  // One line per finished agent turn, in OpenAI chat fine-tuning format.
  logSession(model: string, messages: ChatMessage[], outcome: 'done' | 'stopped' | 'error' | 'max_steps') {
    return this.append('sessions.jsonl', { ts: new Date().toISOString(), model, outcome, messages });
  }

  // One line per shown completion; accepted=true when the user pressed Tab.
  logCompletion(record: {
    id: string;
    model: string;
    languageId: string;
    prefix: string;
    suffix: string;
    completion: string;
    accepted: boolean;
  }) {
    return this.append('completions.jsonl', { ts: new Date().toISOString(), ...record });
  }
}
