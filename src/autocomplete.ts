// Inline (ghost text) autocomplete using fill-in-the-middle on a small base model.

import * as vscode from 'vscode';
import { TrainingLogger } from './logger';
import { cleanCompletion, fimFormatFor } from './fim';

const MAX_PREFIX_CHARS = 6000;
const MAX_SUFFIX_CHARS = 2000;

interface Shown {
  id: string;
  model: string;
  languageId: string;
  prefix: string;
  suffix: string;
  completion: string;
  accepted: boolean;
}

export class AutocompleteProvider implements vscode.InlineCompletionItemProvider {
  private lastShown?: Shown;

  constructor(private readonly logger: TrainingLogger) {}

  // Called by the inline item's command when the user accepts with Tab.
  markAccepted(id: string) {
    if (this.lastShown?.id === id && !this.lastShown.accepted) {
      this.lastShown.accepted = true;
      this.logger.logCompletion(this.lastShown);
      this.lastShown = undefined;
    }
  }

  private flushRejected() {
    if (this.lastShown && !this.lastShown.accepted) this.logger.logCompletion(this.lastShown);
    this.lastShown = undefined;
  }

  async provideInlineCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    _ctx: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const c = vscode.workspace.getConfiguration('perdev');
    if (!c.get<boolean>('autocomplete.enabled', true)) return;
    if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') return;

    await sleep(c.get<number>('autocomplete.debounceMs', 250));
    if (token.isCancellationRequested) return;

    const full = doc.getText();
    const offset = doc.offsetAt(pos);
    const prefix = full.slice(Math.max(0, offset - MAX_PREFIX_CHARS), offset);
    const suffix = full.slice(offset, offset + MAX_SUFFIX_CHARS);

    // Don't complete in the middle of a word on the current line.
    const lineAfter = doc.lineAt(pos.line).text.slice(pos.character);
    if (/^\w/.test(lineAfter)) return;

    const model = c.get<string>('autocomplete.model', 'qwen2.5-coder');
    const backend = c.get<string>('autocomplete.backend', 'llamacpp');
    const url = c.get<string>('autocomplete.url', 'http://127.0.0.1:8081').replace(/\/$/, '');
    const fmt = fimFormatFor(model);
    const prompt = fmt.build(prefix, suffix);
    const stop = [...fmt.stop, '\n\n\n'];

    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());
    let completion = '';
    try {
      // llama.cpp: POST /completion -> { content }. Ollama: POST /api/generate (raw) -> { response }.
      const [endpoint, body] =
        backend === 'ollama'
          ? ['/api/generate', { model, prompt, raw: true, stream: false, keep_alive: '30m', options: { temperature: 0.1, num_predict: 128, stop } }]
          : ['/completion', { prompt, n_predict: 128, temperature: 0.1, stop, cache_prompt: true }];
      const res = await fetch(`${url}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return;
      const data: any = await res.json();
      completion = cleanCompletion(String(data.content ?? data.response ?? ''), suffix);
    } catch {
      return; // server down or request cancelled: show nothing
    } finally {
      sub.dispose();
    }
    if (token.isCancellationRequested || !completion.trim()) return;

    this.flushRejected();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.lastShown = { id, model, languageId: doc.languageId, prefix, suffix, completion, accepted: false };

    const item = new vscode.InlineCompletionItem(completion, new vscode.Range(pos, pos));
    item.command = { command: 'perdev.completionAccepted', title: 'Accepted', arguments: [id] };
    return [item];
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
