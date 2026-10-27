// The agent loop: ask the model, run any tools it calls, feed results back,
// repeat until it answers without tools.

import * as os from 'os';
import { ChatMessage, LlmConfig, streamChat } from './llm';
import { TOOL_SPECS, runTool, ToolContext } from './tools';
import { trimContext } from './context';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'assistant_end' }
  | { type: 'tool_start'; id: string; name: string; args: string }
  | { type: 'tool_end'; id: string; result: string }
  | { type: 'error'; message: string }
  | { type: 'done'; outcome: 'done' | 'stopped' | 'error' | 'max_steps' };

export function systemPrompt(root: string): string {
  return `You are PerDev, an expert software engineer working inside the user's code editor.

Workspace root: ${root}
OS: ${os.platform()} (${os.release()})
Date: ${new Date().toISOString().slice(0, 10)}

You can call tools to read, search, create and edit files and to run shell commands.
How to work:
- Explore before changing things: use list_files, search and read_file to understand the code.
- Make focused changes with edit_file. Always read a file before editing it, and copy old_str exactly.
- Use write_file only for new files or full rewrites.
- After changing code, verify it: run the tests, the build or the program with run_command when possible, and fix what fails.
- Paths are relative to the workspace root.
- When the task is complete, reply with a short summary of what you changed. Do not call tools in that final reply.
- If the request is just a question, answer it directly and concisely.`;
}

export class Agent {
  messages: ChatMessage[] = [];
  private abort?: AbortController;

  constructor(private readonly root: string) {
    this.reset();
  }

  get running() {
    return !!this.abort;
  }

  reset() {
    this.messages = [{ role: 'system', content: systemPrompt(this.root) }];
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
