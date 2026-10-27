// Unit tests for the parts that don't need VS Code. Run with: npm test
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseFallbackToolCalls } from '../llm';
import { trimContext } from '../context';
import { cleanCompletion, fimFormatFor } from '../fim';
import { ChatMessage } from '../llm';

test('fallback parser reads <tool_call> blocks', () => {
  const calls = parseFallbackToolCalls('Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n</tool_call>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'a.ts' });
});

test('fallback parser reads fenced JSON and bare JSON', () => {
  assert.equal(parseFallbackToolCalls('```json\n{"name":"list_files","arguments":{}}\n```')[0].function.name, 'list_files');
  assert.equal(parseFallbackToolCalls('{"name":"search","parameters":{"regex":"x"}}')[0].function.name, 'search');
});

test('fallback parser ignores ordinary answers', () => {
  assert.equal(parseFallbackToolCalls('Here is the fix:\n```ts\nconst x = { a: 1 };\n```').length, 0);
  assert.equal(parseFallbackToolCalls('The answer is 42.').length, 0);
});

test('trimContext removes old tool output first and keeps system + latest user', () => {
  const big = 'x'.repeat(5000);
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first' },
    { role: 'tool', content: big, tool_call_id: '1' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second' },
    { role: 'tool', content: 'recent', tool_call_id: '2' },
  ];
  trimContext(msgs, 1000);
  assert.equal(msgs[0].content, 'sys');
  assert.ok(msgs[2].content!.startsWith('[old tool output removed'));
  assert.equal(msgs.at(-1)!.content, 'recent');
});

test('trimContext drops whole early turns when still too big', () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a'.repeat(3000) },
    { role: 'assistant', content: 'b'.repeat(3000) },
    { role: 'user', content: 'latest' },
  ];
  trimContext(msgs, 1000);
  assert.deepEqual(msgs.map((m) => m.content), ['sys', 'latest']);
});

test('FIM format is chosen by model name', () => {
  assert.ok(fimFormatFor('qwen2.5-coder:1.5b-base').build('A', 'B').startsWith('<|fim_prefix|>A'));
  assert.ok(fimFormatFor('starcoder2:3b').build('A', 'B').startsWith('<fim_prefix>'));
});

test('cleanCompletion stops before repeating the suffix', () => {
  const out = cleanCompletion('  return a + b;\n}\n\nfunction next() {', '\n}\n\nfunction next() {}');
  assert.equal(out, '  return a + b;');
  assert.equal(cleanCompletion('foo()  \n\n', ''), 'foo()');
});
