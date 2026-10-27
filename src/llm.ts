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
): Promise<StreamResult> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, tools, stream: true, temperature: 0.2 }),
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

  let toolCalls = [...calls.values()];
  if (toolCalls.length === 0) {
    toolCalls = parseFallbackToolCalls(content);
  }
  return { content, toolCalls };
}

// Small open models sometimes write tool calls as text instead of using the
// structured field. Accept <tool_call>{...}</tool_call> blocks and bare
// {"name": ..., "arguments": ...} JSON objects.
export function parseFallbackToolCalls(text: string): ToolCall[] {
  const candidates: string[] = [];
  const tagged = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = tagged.exec(text))) candidates.push(m[1]);
  if (candidates.length === 0) {
    const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
    while ((m = fenced.exec(text))) candidates.push(m[1]);
  }
  if (candidates.length === 0 && text.trim().startsWith('{')) candidates.push(text.trim());

  const calls: ToolCall[] = [];
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (typeof obj.name !== 'string') continue;
      const args = obj.arguments ?? obj.parameters ?? {};
      calls.push({
        id: `call_fb_${calls.length}_${Date.now()}`,
        type: 'function',
        function: { name: obj.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
      });
    } catch {
      // not a tool call
    }
  }
  return calls;
}
