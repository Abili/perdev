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
}

export async function streamChat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  onText: (delta: string) => void,
  signal: AbortSignal,
  temperature = 0.2,
): Promise<StreamResult> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    // max_tokens stops a runaway reply (small models sometimes repeat themselves).
    body: JSON.stringify({ model: cfg.model, messages, ...(tools.length ? { tools } : {}), stream: true, temperature, max_tokens: 2048 }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Model server returned ${res.status}: ${await res.text().catch(() => '')}`);
  }

  let content = '';
  const calls = new Map<number, ToolCall>();
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = '';

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
      if (delta.content) {
        content += delta.content;
        onText(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? calls.size;
        const existing = calls.get(idx);
        if (!existing) {
          calls.set(idx, {
            id: tc.id ?? `call_${idx}_${Date.now()}`,
            type: 'function',
            function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
          });
        } else {
          if (tc.function?.name) existing.function.name += tc.function.name;
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
        }
      }
    }
  }

  if (calls.size > 0) return { content, toolCalls: [...calls.values()] };
  const fallback = parseFallbackToolCalls(content, tools.map((t) => t.function.name));
  if (!fallback.call) return { content, toolCalls: [] };
  // Keep only what came before the call: the rest is a plan that depends on
  // results the model hasn't seen yet (often with invented results).
  return { content: fallback.before, toolCalls: [fallback.call] };
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
): Promise<ToolCall | undefined> {
  const prefilled: ChatMessage[] = [...messages, { role: 'assistant', content: replySoFar.trim() + PREFILL }];
  const r = await streamChat(cfg, prefilled, tools, () => {}, signal);
  const text = '{"name": "' + r.content;
  return parseFallbackToolCalls(text, tools.map((t) => t.function.name)).call;
}
