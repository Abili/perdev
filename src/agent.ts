// The agent loop: ask the model, run any tools it calls, feed results back,
// repeat until it answers without tools.

import { ChatMessage, LlmConfig, streamChat } from './llm';
import { TOOL_SPECS, runTool, ToolContext } from './tools';
import { conversationSize, trimContext } from './context';
import { carryOverSection, HANDOFF_PROMPT, looksLikeUnfinishedPlan, systemPrompt } from './prompt';
import { LoopGuard } from './loopGuard';
import { resolveShell, Shell } from './shell';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'assistant_end' }
  | { type: 'tool_start'; id: string; name: string; args: string }
  | { type: 'tool_end'; id: string; result: string }
  | { type: 'error'; message: string }
  | { type: 'step' } // a round of tool calls finished (the chat is saved)
  | { type: 'done'; outcome: 'done' | 'stopped' | 'error' | 'max_steps' };

export class Agent {
  messages: ChatMessage[] = [];
  private abort?: AbortController;

  constructor(
    private readonly root: string,
    private readonly shell: Shell = resolveShell(),
  ) {
    this.reset();
  }

  get running() {
    return !!this.abort;
  }

  // carry: handoff from a parent chat, built into the system prompt so it is never trimmed.
  reset(carry?: { parentTitle: string; summary: string }) {
    const extra = carry ? carryOverSection(carry.parentTitle, carry.summary) : '';
    this.messages = [{ role: 'system', content: systemPrompt(this.root, { shell: this.shell.label }) + extra }];
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
      shellPath: this.shell.path,
    };

    let outcome: 'done' | 'stopped' | 'error' | 'max_steps' = 'max_steps';
    let toolsUsed = 0;
    let retries = 0;
    let temperature: number | undefined;
    const guard = new LoopGuard();
    try {
      for (let step = 0; step < opts.maxSteps; step++) {
        trimContext(this.messages, opts.maxContextChars);
        const result = await streamChat(cfg, this.messages, TOOL_SPECS, (d) => emit({ type: 'text', delta: d }), signal, temperature);
        emit({ type: 'assistant_end' });
        temperature = undefined;

        if (result.toolCalls.length === 0) {
          // Mid-task, small models sometimes stop to describe the next change instead
          // of making it. Measured on Qwen2.5-Coder-7B: telling it to act afterwards
          // doesn't work (it just ends), but re-asking the same step usually does.
          // So drop that reply and retry (up to twice), a little less deterministically.
          if (toolsUsed > 0 && retries < 2 && (!result.content.trim() || looksLikeUnfinishedPlan(result.content))) {
            retries++;
            temperature = 0.4;
            continue;
          }
          this.messages.push({ role: 'assistant', content: result.content || null });
          outcome = 'done';
          break;
        }

        this.messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });

        toolsUsed += result.toolCalls.length;
        let stopMessage: string | undefined;
        for (const call of result.toolCalls) {
          if (signal.aborted) break;
          const { name, arguments: args } = call.function;
          emit({ type: 'tool_start', id: call.id, name, args });
          const decision = guard.check(name, args);
          let output: string;
          if (decision.action === 'run') {
            output = await runTool(name, args, ctx);
            guard.record(name, args, output);
            if ((name === 'write_file' || name === 'edit_file') && !output.startsWith('Error:')) guard.forgetReads();
          } else {
            output = decision.message;
            if (decision.action === 'stop') stopMessage = decision.message;
          }
          emit({ type: 'tool_end', id: call.id, result: output });
          this.messages.push({ role: 'tool', tool_call_id: call.id, name, content: output });
        }
        emit({ type: 'step' });
        if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
        if (stopMessage) {
          emit({ type: 'error', message: stopMessage });
          outcome = 'stopped';
          break;
        }
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
