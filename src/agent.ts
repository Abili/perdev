// The agent loop: ask the model, run any tools it calls, feed results back,
// repeat until it answers without tools.

import { ChatMessage, LlmConfig, streamChat } from './llm';
import { TOOL_SPECS, runTool, ToolContext } from './tools';
import { conversationSize, trimContext } from './context';
import { carryOverSection, HANDOFF_PROMPT, systemPrompt } from './prompt';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'assistant_end' }
  | { type: 'tool_start'; id: string; name: string; args: string }
  | { type: 'tool_end'; id: string; result: string }
  | { type: 'error'; message: string }
  | { type: 'done'; outcome: 'done' | 'stopped' | 'error' | 'max_steps' };

export class Agent {
  messages: ChatMessage[] = [];
  private abort?: AbortController;

  constructor(private readonly root: string) {
    this.reset();
  }

  get running() {
    return !!this.abort;
  }

  // carry: handoff from a parent chat, built into the system prompt so it is never trimmed.
  reset(carry?: { parentTitle: string; summary: string }) {
    const extra = carry ? carryOverSection(carry.parentTitle, carry.summary) : '';
    this.messages = [{ role: 'system', content: systemPrompt(this.root) + extra }];
  }

  // How full the conversation is, relative to the trimming budget (0..1+).
  usage(maxContextChars: number): number {
    return conversationSize(this.messages) / maxContextChars;
  }

  // Ask the model for a handoff note that a fresh chat can continue from.
  async summarize(cfg: LlmConfig, maxContextChars: number, onText: (d: string) => void): Promise<string> {
    this.abort = new AbortController();
    try {
      const msgs: ChatMessage[] = JSON.parse(JSON.stringify(this.messages));
      // Leave room for the note itself.
      trimContext(msgs, Math.floor(maxContextChars * 0.85));
      msgs.push({ role: 'user', content: HANDOFF_PROMPT });
      const result = await streamChat(cfg, msgs, [], onText, this.abort.signal);
      return result.content.trim();
    } finally {
      this.abort = undefined;
    }
  }

  stop() {
    this.abort?.abort();
  }

  async run(
    userText: string,
    cfg: LlmConfig,
    opts: { maxSteps: number; maxContextChars: number; approveCommands: boolean; approveEdits: boolean },
    emit: (e: AgentEvent) => void,
  ): Promise<'done' | 'stopped' | 'error' | 'max_steps'> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.messages.push({ role: 'user', content: userText });
    const ctx: ToolContext = {
      root: this.root,
      approveCommands: opts.approveCommands,
      approveEdits: opts.approveEdits,
      signal,
    };

    let outcome: 'done' | 'stopped' | 'error' | 'max_steps' = 'max_steps';
    try {
      for (let step = 0; step < opts.maxSteps; step++) {
        trimContext(this.messages, opts.maxContextChars);
        const result = await streamChat(cfg, this.messages, TOOL_SPECS, (d) => emit({ type: 'text', delta: d }), signal);
        emit({ type: 'assistant_end' });

        this.messages.push({
          role: 'assistant',
          content: result.content || null,
          ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
        });

        if (result.toolCalls.length === 0) {
          outcome = 'done';
          break;
        }

        for (const call of result.toolCalls) {
          if (signal.aborted) break;
          emit({ type: 'tool_start', id: call.id, name: call.function.name, args: call.function.arguments });
          const output = await runTool(call.function.name, call.function.arguments, ctx);
          emit({ type: 'tool_end', id: call.id, result: output });
          this.messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: output });
        }
        if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      }
      if (outcome === 'max_steps') {
        emit({ type: 'error', message: `Stopped after ${opts.maxSteps} steps. Say "continue" to keep going.` });
      }
    } catch (e: any) {
      if (signal.aborted || e?.name === 'AbortError') {
        outcome = 'stopped';
      } else {
        outcome = 'error';
        emit({ type: 'error', message: friendlyError(e, cfg) });
      }
    } finally {
      this.abort = undefined;
      emit({ type: 'done', outcome });
    }
    return outcome;
  }
}

function friendlyError(e: any, cfg: LlmConfig): string {
  const msg = e?.message ?? String(e);
  if (/fetch failed|ECONNREFUSED/i.test(msg) || e?.cause?.code === 'ECONNREFUSED') {
    return `Could not reach the model server at ${cfg.baseUrl}. Run "PerDev: Start Local Model Servers" from the command palette and check the "PerDev Servers" output for errors.`;
  }
  return msg;
}
