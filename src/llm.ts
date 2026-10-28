// Minimal OpenAI-compatible chat client with streaming and tool calls.
// Works with Ollama, vLLM, llama.cpp server, LM Studio, OpenRouter, etc.

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface StreamResult {
  content: string;
  toolCalls: ToolCall[];
  reasoning?: string;
}

export async function streamChat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  onText: (delta: string) => void,
  signal: AbortSignal,
  temperature = 0.2,
  hooks: StreamHooks = {},
): Promise<StreamResult> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    // max_tokens stops a runaway reply (small models sometimes repeat themselves).
    body: JSON.stringify({ model: cfg.model, messages, ...(tools.length ? { tools } : {}), stream: true, temperature, max_tokens: hooks.maxTokens ?? 2048 }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Model server returned ${res.status}: ${await res.text().catch(() => '')}`);
  }

  let raw = ''; // everything the model wrote, including any <think> blocks
  let content = ''; // what the user sees as the reply
  let reasoning = '';
  let shownText = 0;
  let shownThink = 0;
  const calls = new Map<number, ToolCall>();
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = '';
  // Route new text to the reply or to the visible "Thinking" block.
  const flushText = (final: boolean) => {
    const split = splitThinking(raw, final);
    content = split.visible;
    if (split.visible.length > shownText) onText(split.visible.slice(shownText));
    shownText = split.visible.length;
    if (split.thinking.length > shownThink) hooks.reasoning?.(split.thinking.slice(shownThink));
    shownThink = split.thinking.length;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      // Reasoning models send their thinking separately (reasoning_content) or inline in <think>.
      const thought = delta.reasoning_content ?? delta.reasoning;
      if (typeof thought === 'string' && thought) {
        reasoning += thought;
        hooks.reasoning?.(thought);
      }
      if (delta.content) {
        raw += delta.content;
        flushText(false);
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? calls.size;
        let call = calls.get(idx);
        if (!call) {
          call = {
            id: tc.id ?? `call_${idx}_${Date.now()}`,
            type: 'function',
            function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
          };
          calls.set(idx, call);
        } else {
          if (tc.function?.name) call.function.name += tc.function.name;
          if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
        }
        // Writing a call (e.g. a whole file) can take a while: say what's coming.
        if (call.function.name) hooks.toolCall?.(call.function.name, call.function.arguments);
      }
    }
  }
  flushText(true);
  const thinking = (reasoning + splitThinking(raw, true).thinking).trim();

  if (calls.size > 0) return { content, toolCalls: [...calls.values()], reasoning: thinking };
  const fallback = parseFallbackToolCalls(content, tools.map((t) => t.function.name));
  if (!fallback.call) return { content, toolCalls: [], reasoning: thinking };
  // Keep only what came before the call: the rest is a plan that depends on
  // results the model hasn't seen yet (often with invented results).
  return { content: fallback.before, toolCalls: [fallback.call], reasoning: thinking };
}

export interface StreamHooks {
  // Reply length limit (default 2048 tokens; stops runaway replies).
  maxTokens?: number;
  // A tool call is being written: its name, and its arguments so far.
  toolCall?: (name: string, partialArgs: string) => void;
  // The model's visible reasoning, as it streams.
  reasoning?: (delta: string) => void;
}

// Separates <think>...</think> reasoning from the reply. While streaming
// (final=false), a trailing partial "<think" tag is held back so it never
// flashes up in the reply.
export function splitThinking(raw: string, final: boolean): { visible: string; thinking: string } {
  let visible = '';
  let thinking = '';
  let i = 0;
  for (;;) {
    const open = raw.indexOf('<think>', i);
    if (open < 0) {
      visible += raw.slice(i);
      break;
    }
    visible += raw.slice(i, open);
    const close = raw.indexOf('</think>', open + 7);
    if (close < 0) {
      thinking += raw.slice(open + 7);
      i = raw.length;
      break;
    }
    thinking += raw.slice(open + 7, close);
    i = close + 8;
  }
  if (!final) {
    const tail = visible.match(/<\/?t?h?i?n?k?$/);
    if (tail && '<think>'.startsWith(tail[0])) visible = visible.slice(0, -tail[0].length);
  }
  // A reply usually starts with blank lines after a </think>.
  return { visible: visible.replace(/^\s+/, ''), thinking };
}

// Small open models sometimes write tool calls as text instead of using the
// structured field: <tool_call>{...}</tool_call> blocks, ```json fences or bare
// {"name": ..., "arguments": ...} objects, often several in a row as a plan.
// Returns only the first real call, plus the text before it. Objects with a
// "result"/"output" field are the model imagining a tool's answer, not a call.
export function parseFallbackToolCalls(text: string, toolNames?: string[]): { call?: ToolCall; before: string } {
  const found: { json: string; index: number }[] = [];
  const add = (re: RegExp) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) found.push({ json: m[1], index: m.index });
  };
  add(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g);
  if (found.length === 0) add(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g);
  if (found.length === 0) {
    // A bare {"name": ...} object anywhere in the text, possibly mid-sentence.
    const re = /\{\s*"name"\s*:/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const json = extractJsonObject(text, m.index);
      if (json) found.push({ json, index: m.index });
    }
  }

  for (const f of found.sort((a, b) => a.index - b.index)) {
    let obj: any;
    try {
      obj = JSON.parse(f.json);
    } catch {
      continue;
    }
    if (typeof obj?.name !== 'string') continue;
    if (toolNames && !toolNames.includes(obj.name)) continue;
    if ('result' in obj || 'output' in obj) continue;
    const args = obj.arguments ?? obj.parameters ?? {};
    return {
      call: {
        id: `call_fb_${Date.now()}`,
        type: 'function',
        function: { name: obj.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
      },
      before: text.slice(0, f.index).trim(),
    };
  }
  return { before: text };
}

// The balanced {...} starting at `start`, respecting JSON strings; undefined if unbalanced.
export function extractJsonObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

// When the model announces a step ("Let's read calc.py.") but stops, continue
// its own reply with the start of a tool call so the only natural continuation
// is the call itself. llama.cpp continues a trailing assistant message (prefill).
// Measured on Qwen2.5-Coder-7B: 6/6 correct calls, versus re-asking, which
// usually repeats the announcement.
const PREFILL = '\n<tool_call>\n{"name": "';
export async function continueAsToolCall(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  replySoFar: string,
  signal: AbortSignal,
  onToolCall?: (name: string, partialArgs: string) => void,
  // Force a particular tool: e.g. write_file when the model pasted code instead of writing files.
  forceTool?: string,
): Promise<ToolCall | undefined> {
  const start = !forceTool
    ? '{"name": "'
    : forceTool === 'write_file'
      ? '{"name": "write_file", "arguments": {"path": "'
      : `{"name": "${forceTool}", "arguments": {`;
  const prefilled: ChatMessage[] = [...messages, { role: 'assistant', content: replySoFar.trim() + '\n<tool_call>\n' + start }];
  // The call arrives as text ('read_file", "arguments": {"path": ...'): report it as it streams.
  let written = '';
  const onText = (d: string) => {
    written += d;
    if (forceTool) return onToolCall?.(forceTool, start.slice(start.indexOf('"arguments"') + 13) + written);
    const m = written.match(/^([A-Za-z0-9_]+)"\s*,\s*"arguments"\s*:\s*([\s\S]*)$/);
    if (m) onToolCall?.(m[1], m[2]);
  };
  // A whole file can be long: allow more tokens than a normal reply.
  const r = await streamChat(cfg, prefilled, tools, onText, signal, undefined, { maxTokens: forceTool ? 6144 : undefined });
  const text = start + r.content;
  return parseFallbackToolCalls(text, tools.map((t) => t.function.name)).call;
}
