// The agent loop: ask the model, run any tools it calls, feed results back,
// repeat until it answers without tools.

import { ChatMessage, continueAsToolCall, LlmConfig, StreamHooks, StreamResult, streamChat, ToolCall, ToolSpec } from './llm';
import { ReplyFilter } from './replyFilter';
import * as fs from 'fs';
import * as path from 'path';
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
  | { type: 'unverified'; reason: string } // finished, but nothing was successfully built/tested
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
    // Asked to do something (not just chat or a question).
    const isWorkRequest = !isQuestion && /\b(build|create|make|add|fix|implement|write|change|update|refactor|remove|rename|generate|set ?up)\b/i.test(userText);
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
    // Verification gate: changed files must be built/tested successfully before "done".
    let changedFiles = 0;
    let verified = false;
    let verifyTries = 0;
    let lastFailure = '';
    // Set when the model is going round in circles with untested changes: the next step tests them.
    let forceVerify = false;
    // Code saved by write_file this run, to spot the model sending the same file again.
    const written = new Set<string>();
    // Android with a device: build, install, then launch is the test.
    const onDevice = !!extra?.has('launch') && fs.existsSync(path.join(this.root, 'settings.gradle.kts'));
    const progress = { built: false, installed: false };
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
      // Have the model build/test (the fitting tool for this project) instead of choosing its own step.
      const verifyCall = () => {
        verifyTries++;
        status('Testing what was built…');
        return continueAsToolCall(cfg, this.messages, tools, '', signal, hooks.toolCall, verificationTool(this.root, extra, progress));
      };
      // Android needs up to three (build, install, launch).
      const mayForceVerify = () => !isQuestion && changedFiles > 0 && !verified && verifyTries < (onDevice ? 5 : 3);
      for (let step = 0; step < opts.maxSteps; step++) {
        trimContext(this.messages, opts.maxContextChars);
        status(toolsUsed === 0 ? 'Thinking…' : 'Thinking about the results…');
        // Code goes to files, not the chat: a finished code block ends the reply
        // and is written to its file; a reply repeating itself is cut (see ReplyFilter).
        const filter = new ReplyFilter(isQuestion);
        const cutCtl = new AbortController();
        let looping = false;
        const onText = (d: string) => {
          const u = filter.push(d);
          if (u.show) emit({ type: 'text', delta: u.show });
          if (u.toolCall) status(describeActivity(u.toolCall.name, u.toolCall.partialArgs));
          if (u.codeLines !== undefined) status(`Writing code… (${u.codeLines} lines)`);
          if ((u.cutForCode || u.repeating) && !cutCtl.signal.aborted) {
            looping = u.repeating && !u.cutForCode;
            status(looping ? 'Getting back on track…' : 'Saving the code to its file…');
            cutCtl.abort();
          }
        };
        let result: StreamResult;
        let codeCut = false;
        let forcedCall: ToolCall | undefined;
        const forced = forceVerify ? await verifyCall() : undefined;
        forceVerify = false;
        if (forced) {
          result = { content: '', toolCalls: [forced] };
        } else {
          try {
            result = await streamChat(cfg, this.messages, tools, onText, AbortSignal.any([signal, cutCtl.signal]), temperature, hooks);
          } catch (e: any) {
            if (signal.aborted || !cutCtl.signal.aborted) throw e;
            codeCut = !looping;
            result = { content: looping ? filter.visible : filter.full, toolCalls: [] };
          }
        }
        const rest = filter.flush();
        if (rest) emit({ type: 'text', delta: rest });
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
          const midTaskStall = toolsUsed > 0 && (looping || !result.content.trim() || looksLikeUnfinishedPlan(result.content));
          // At the first step only a short announcement counts ("I'll read its contents
          // first. Please wait..."): a real answer that mentions a next step is longer.
          // For a work request, any first reply that did nothing is a stall (often a whole plan, then nothing).
          const firstStepAnnouncement = toolsUsed === 0 && (isWorkRequest || (result.content.trim().length < 400 && looksLikeUnfinishedPlan(result.content)));
          // Asked to build or change something, it pasted code for the user to copy:
          // make it write that code into the actual files instead.
          // (Not when it's the same code as a file it already saved: see below.)
          const sameCodeAgain = codeCut && !!filter.code && written.has(filter.code.body);
          const codeDump = !isQuestion && !sameCodeAgain && (codeCut || looksLikeCodeForUser(result.content));
          // About to finish after changing files, without a successful build/test:
          // make it test first (it claimed "built and tested" when every build had failed).
          const unverifiedFinish = mayForceVerify() && !midTaskStall && !asking && !codeDump;
          if (unverifiedFinish) {
            const call = await verifyCall();
            if (call) {
              // Its claim of success isn't kept: the test result decides.
              result = { content: '', toolCalls: [call] };
            }
          }
          // The same code as a file it already saved: that file is done; test the work
          // (or, if it was tested, finish without the repeated code).
          if (sameCodeAgain) {
            const call = !result.toolCalls.length && mayForceVerify() ? await verifyCall() : undefined;
            result = { content: introBeforeCode(result.content), toolCalls: call ? [call] : result.toolCalls };
          }
          // A whole code block was written: save it as is (the model only names
          // the file), instead of having the model write the same code again.
          if (!result.toolCalls.length && codeCut && filter.code && !sameCodeAgain) {
            const intro = introBeforeCode(result.content);
            const filePath = await nameFileFor(cfg, this.messages, tools, intro, filter.code, signal);
            if (filePath) {
              result = {
                content: intro,
                toolCalls: [{ id: `call_code_${Date.now()}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: filePath, content: filter.code.body }) } }],
              };
            }
          }
          if (result.toolCalls.length) {
            // a verification step or a code block to save was added above
          } else if (retries < 2 && (midTaskStall || looping || asking || firstStepAnnouncement || codeDump)) {
            retries++;
            status(codeDump ? 'Creating the files…' : 'Planning the next step…');
            const keep = asking || looping ? '' : codeDump ? introBeforeCode(result.content) : result.content;
            const call = await continueAsToolCall(cfg, this.messages, tools, keep, signal, hooks.toolCall, codeDump ? 'write_file' : undefined);
            if (!call) {
              status('Thinking again…');
              temperature = 0.4;
              continue;
            }
            result = { content: keep, toolCalls: [call] };
          } else if (mayForceVerify() && (forcedCall = await verifyCall())) {
            // Out of recovery attempts with untested changes: test them before ending.
            result = { content: '', toolCalls: [forcedCall] };
          } else {
            this.messages.push({ role: 'assistant', content: result.content || null });
            outcome = 'done';
            if (!isQuestion && changedFiles > 0 && !verified) {
              emit({ type: 'unverified', reason: lastFailure || 'Nothing was built or tested after the changes.' });
            }
            break;
          }
        }

        this.messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });

        // A tool call (the model's own or recovered from a stall) is progress, so only
        // consecutive failed recoveries count. Loops stay bounded by maxSteps and LoopGuard.
        retries = 0;
        toolsUsed += result.toolCalls.length;
        let stopMessage: string | undefined;
        let finishedRepeat = false;
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
          } else if ((decision.action === 'stop' || isWrite(name)) && mayForceVerify()) {
            // Stuck (or re-sending a file it already wrote), with changes that were
            // never tested: test them rather than wait for it or give up.
            output = `${decision.message.replace(/^PerDev stopped because/, 'Not run again:')}\nNext, the changes get built and tested.`;
            forceVerify = true;
          } else if ((isWrite(name) || decision.action === 'stop') && verified && changedFiles > 0) {
            // Repeating itself after the work was written and tested: it's done.
            output = decision.message;
            finishedRepeat = true;
          } else {
            output = decision.message;
            if (decision.action === 'stop') stopMessage = decision.message;
          }
          emit({ type: 'tool_end', id: call.id, result: output });
          this.messages.push({ role: 'tool', tool_call_id: call.id, name, content: output });
          // Track what changed and whether it was then built/tested successfully.
          const failed = output.startsWith('Error:');
          if ((name === 'write_file' || name === 'edit_file') && !failed && decision.action === 'run') {
            changedFiles++;
            verified = false;
            if (name === 'write_file') {
              try {
                written.add(JSON.parse(args).content);
              } catch {
                // not JSON: nothing to remember
              }
            }
          }
          if (isWrite(name) && decision.action === 'run' && !failed) progress.built = progress.installed = false;
          if (VERIFYING_TOOLS.has(name)) {
            const ok =
              !failed &&
              !/BUILD FAILED/.test(output) &&
              !(name === 'run_command' && !/^exit code: 0\b/.test(output)) &&
              !(name === 'open_in_browser' && /Console errors:|Failed requests:/.test(output));
            if (ok && name === 'build') progress.built = true;
            if (ok && name === 'install') progress.installed = true;
            // An Android app counts as tested once it runs on the device, not when it merely builds.
            if (ok && (!onDevice || name === 'launch' || name === 'ui_tree')) verified = true;
            if (!ok) lastFailure = `${describeActivity(name, args)}: ${firstLine(output.replace(/^Error:\s*/, '')).slice(0, 200)}`;
          }
        }
        emit({ type: 'step' });
        if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
        if (stopMessage) {
          emit({ type: 'error', message: stopMessage });
          if (!isQuestion && changedFiles > 0 && !verified) {
            emit({ type: 'unverified', reason: lastFailure || 'Nothing was built or tested after the changes.' });
          }
          outcome = 'stopped';
          break;
        }
        if (finishedRepeat) {
          const summary = 'Done: the changes are written, and they were built and tested successfully.';
          emit({ type: 'text', delta: summary });
          emit({ type: 'assistant_end' });
          this.messages.push({ role: 'assistant', content: summary });
          outcome = 'done';
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

// Which file a finished code block belongs in: the model continues its own reply
// (intro + the code) with the start of a write_file call and names the path.
// Measured on the 7B: it re-picked MainActivity.kt and rewrote it identically
// when asked to write the file from scratch, but names the right file when it
// can see the code. Undefined if it doesn't give a plausible path.
async function nameFileFor(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  intro: string,
  code: { lang: string; body: string },
  signal: AbortSignal,
): Promise<string | undefined> {
  const prefill = `${intro}\n\n\`\`\`${code.lang}\n${code.body}\`\`\`\n<tool_call>\n{"name": "write_file", "arguments": {"path": "`;
  let text = '';
  const ctl = new AbortController();
  try {
    await streamChat(
      cfg,
      [...messages, { role: 'assistant', content: prefill }],
      tools,
      (d) => {
        text += d;
        if (text.includes('"')) ctl.abort();
      },
      AbortSignal.any([signal, ctl.signal]),
      0,
      { maxTokens: 60 },
    );
  } catch (e) {
    if (signal.aborted) throw e;
  }
  const p = text.split('"')[0].trim();
  return /^[\w./\\-]+\.[A-Za-z0-9]+$/.test(p) && !p.includes('..') ? p : undefined;
}

function isWrite(name: string): boolean {
  return name === 'write_file' || name === 'edit_file';
}

function firstLine(s: string): string {
  return s.split('\n')[0];
}

// Tools whose success counts as having built or tested the work.
const VERIFYING_TOOLS = new Set(['run_command', 'open_in_browser', 'build', 'install', 'launch']);

// The most fitting check for this project: build an Android app, open a web page, or run a command.
function verificationTool(root: string, extra?: ExtraTools, progress = { built: false, installed: false }): string {
  if (extra?.has('build') && fs.existsSync(path.join(root, 'settings.gradle.kts'))) {
    if (!progress.built) return 'build';
    if (!progress.installed && extra.has('install')) return 'install';
    if (extra.has('launch')) return 'launch';
    return 'build';
  }
  if (fs.existsSync(path.join(root, 'index.html'))) return 'open_in_browser';
  return 'run_command';
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
