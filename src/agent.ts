// The agent loop: ask the model, run any tools it calls, feed results back,
// repeat until it answers without tools.

import { ChatMessage, continueAsToolCall, LlmConfig, StreamHooks, streamChat } from './llm';
import { describeActivity } from './activity';
import { TOOL_SPECS, runTool, ToolContext } from './tools';
import { truncate } from './toolSpecs';
import { conversationSize, trimContext } from './context';
import {
  carryOverSection,
  HANDOFF_PROMPT,
  looksLikeAskingUserToAct,
  looksLikeCodeForUser,
  looksLikeQuestion,
  looksLikeUnfinishedPlan,
  systemPrompt,
} from './prompt';
import { LoopGuard } from './loopGuard';
import { resolveShell, Shell } from './shell';
import { DocsLookup } from './docs';
import { ExtraTools } from './mcpManager';
import { resultText } from './mcp';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'assistant_end' }
  | { type: 'tool_start'; id: string; name: string; args: string; label?: string }
  | { type: 'tool_end'; id: string; result: string }
  | { type: 'error'; message: string }
  | { type: 'status'; text: string } // what the agent is doing right now
  | { type: 'thinking'; delta: string } // the model's visible reasoning, if it shows any
  | { type: 'image'; data: string; mimeType: string } // e.g. a device screenshot, for the user
  | { type: 'step' } // a round of tool calls finished (the chat is saved)
  | { type: 'done'; outcome: 'done' | 'stopped' | 'error' | 'max_steps' };

export class Agent {
  messages: ChatMessage[] = [];
  private abort?: AbortController;
  private baseSystem = '';

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
    this.baseSystem = systemPrompt(this.root, { shell: this.shell.label }) + extra;
    this.messages = [{ role: 'system', content: this.baseSystem }];
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
    opts: {
      maxSteps: number;
      maxContextChars: number;
      approveCommands: boolean;
      approveEdits: boolean;
      docs?: DocsLookup;
      // Tools from MCP servers (e.g. DroidLoop), and how to ask the user before using them.
      extra?: ExtraTools;
      confirm?: (title: string, detail: string) => Promise<boolean>;
    },
    emit: (e: AgentEvent) => void,
  ): Promise<'done' | 'stopped' | 'error' | 'max_steps'> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.messages.push({ role: 'user', content: userText });
    const isQuestion = looksLikeQuestion(userText);
    const extra = opts.extra;
    const tools = extra ? [...TOOL_SPECS, ...extra.specs] : TOOL_SPECS;
    const toolNames = tools.map((t) => t.function.name);
    // Guidance for this request's extra tools rides in the system prompt (never trimmed).
    if (this.messages[0]?.role === 'system' && this.baseSystem) {
      this.messages[0].content = this.baseSystem + (extra?.notes ? `

${extra.notes}` : '');
    }
    const ctx: ToolContext = {
      root: this.root,
      approveCommands: opts.approveCommands,
      approveEdits: opts.approveEdits,
      signal,
      shellPath: this.shell.path,
      docs: opts.docs,
      emitImage: (data, mimeType) => emit({ type: 'image', data, mimeType }),
    };

    let outcome: 'done' | 'stopped' | 'error' | 'max_steps' = 'max_steps';
    let toolsUsed = 0;
    let retries = 0;
    let temperature: number | undefined;
    const guard = new LoopGuard();
    try {
      // Say what's happening at every moment, so the chat never sits silent.
      let lastStatus = '';
      const status = (text: string) => {
        if (text !== lastStatus) emit({ type: 'status', text: (lastStatus = text) });
      };
      const hooks: StreamHooks = {
        toolCall: (name, partial) => status(describeActivity(name, partial)),
        reasoning: (delta) => emit({ type: 'thinking', delta }),
      };
      for (let step = 0; step < opts.maxSteps; step++) {
        trimContext(this.messages, opts.maxContextChars);
        status(toolsUsed === 0 ? 'Thinking…' : 'Thinking about the results…');
        let result = await streamChat(cfg, this.messages, tools, (d) => emit({ type: 'text', delta: d }), signal, temperature, hooks);
        emit({ type: 'assistant_end' });
        temperature = undefined;

        if (result.toolCalls.length === 0) {
          // Small models often stall: mid-task they announce the next step ("Let's
          // read calc.py.") or describe a change and stop, and from the first step on
          // they may ask the user to run a tool ("Please call read_file ..."). Measured
          // on Qwen2.5-Coder-7B, telling it to act afterwards doesn't work (it just
          // ends). What works is continuing its reply with the start of a tool call;
          // if that fails, drop the reply and re-ask a little less deterministically.
          const asking = looksLikeAskingUserToAct(result.content, toolNames);
          const midTaskStall = toolsUsed > 0 && (!result.content.trim() || looksLikeUnfinishedPlan(result.content));
          // At the first step only a short announcement counts ("I'll read its contents
          // first. Please wait..."): a real answer that mentions a next step is longer.
          const firstStepAnnouncement = toolsUsed === 0 && result.content.trim().length < 400 && looksLikeUnfinishedPlan(result.content);
          // Asked to build or change something, it pasted code for the user to copy:
          // make it write that code into the actual files instead.
          const codeDump = !isQuestion && looksLikeCodeForUser(result.content);
          if (retries < 2 && (midTaskStall || asking || firstStepAnnouncement || codeDump)) {
            retries++;
            status(codeDump ? 'Creating the files…' : 'Planning the next step…');
            const keep = asking ? '' : codeDump ? introBeforeCode(result.content) : result.content;
            const call = await continueAsToolCall(cfg, this.messages, tools, keep, signal, hooks.toolCall, codeDump ? 'write_file' : undefined);
            if (!call) {
              status('Thinking again…');
              temperature = 0.4;
              continue;
            }
            result = { content: keep, toolCalls: [call] };
          } else {
            this.messages.push({ role: 'assistant', content: result.content || null });
            outcome = 'done';
            break;
          }
        }

        this.messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });

        // A tool call (the model's own or recovered from a stall) is progress, so only
        // consecutive failed recoveries count. Loops stay bounded by maxSteps and LoopGuard.
        retries = 0;
        toolsUsed += result.toolCalls.length;
        let stopMessage: string | undefined;
        for (const call of result.toolCalls) {
          if (signal.aborted) break;
          const { name, arguments: args } = call.function;
          emit({ type: 'tool_start', id: call.id, name, args, label: describeActivity(name, args) });
          const asks =
            (name === 'run_command' && opts.approveCommands) ||
            ((name === 'write_file' || name === 'edit_file') && opts.approveEdits) ||
            (!!extra?.has(name) && extra.needsApproval(name));
          status(asks ? `Waiting for your approval: ${describeActivity(name, args)}` : `${describeActivity(name, args)}…`);
          const decision = guard.check(name, args);
          let output: string;
          if (decision.action === 'run' && extra?.has(name)) {
            output = await this.runExtra(extra, name, args, opts.confirm, emit);
            // A device action that worked (tap, type...) changes what later calls return.
            if (!extra.isReadOnly(name) && !output.startsWith('Error:')) guard.forgetAll();
            guard.record(name, args, output);
          } else if (decision.action === 'run') {
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

  private async runExtra(
    extra: ExtraTools,
    name: string,
    args: string,
    confirm: ((title: string, detail: string) => Promise<boolean>) | undefined,
    emit: (e: AgentEvent) => void,
  ): Promise<string> {
    if (extra.needsApproval(name) && confirm && !(await confirm(`PerDev wants to use ${name}`, args))) {
      return 'Error: the user declined this action.';
    }
    try {
      const r = await extra.call(name, args);
      for (const img of r.images) emit({ type: 'image', data: img.data, mimeType: img.mimeType });
      return truncate(resultText(r));
    } catch (e: any) {
      return `Error: ${e?.message ?? e}`;
    }
  }
}

// The explanation before the first code block, kept short: the pasted code
// itself is dropped from the history so the model doesn't re-read it.
function introBeforeCode(reply: string): string {
  const intro = reply.split('```')[0].trim();
  return intro.length > 600 ? intro.slice(0, 600).replace(/\s+\S*$/, '') + '…' : intro;
}

function friendlyError(e: any, cfg: LlmConfig): string {
  const msg = e?.message ?? String(e);
  if (/fetch failed|ECONNREFUSED/i.test(msg) || e?.cause?.code === 'ECONNREFUSED') {
    return `Could not reach the model server at ${cfg.baseUrl}. Run "PerDev: Start Local Model Servers" from the command palette and check the "PerDev Servers" output for errors.`;
  }
  return msg;
}
