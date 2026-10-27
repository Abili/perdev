// Unit tests for the parts that don't need VS Code. Run with: npm test
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseFallbackToolCalls } from '../llm';
import { trimContext } from '../context';
import { cleanCompletion, fimFormatFor } from '../fim';
import { ChatMessage } from '../llm';
import { SessionStore, newSessionId, titleFrom } from '../sessions';
import { carryOverSection } from '../prompt';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('chats save, list and keep their branch link', async () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'perdev-test-'));
  const store = new SessionStore(() => dir);
  const now = new Date().toISOString();
  const parent = { id: newSessionId(), title: 'Fix the parser', createdAt: now, updatedAt: now, messages: [{ role: 'user' as const, content: 'fix it' }] };
  await store.save(parent);
  const child = { id: newSessionId() + 'b', title: 'Fix the parser (continued)', createdAt: now, updatedAt: now, parentId: parent.id, parentTitle: parent.title, carriedSummary: 'Goal: fix parser', messages: [] };
  await store.save(child);
  const list = await store.list();
  assert.equal(list.length, 2);
  assert.equal(list.find((s) => s.id === child.id)?.parentId, parent.id);
  assert.equal(((list[0] as any).messages), undefined); // list() omits messages
  assert.equal((await store.load(parent.id))?.messages[0].content, 'fix it');
  assert.equal(await store.load('missing'), undefined);
  fsSync.rmSync(dir, { recursive: true, force: true });
});

test('chat titles come from the first user message without editor context', () => {
  assert.equal(titleFrom([{ role: 'system', content: 's' }, { role: 'user', content: 'Add tests\n\n[Context: the user has a.py open]' }]), 'Add tests');
  assert.equal(titleFrom([]), 'New chat');
  assert.ok(titleFrom([{ role: 'user', content: 'x'.repeat(100) }]).endsWith('...'));
});

test('carried-over summary names the parent chat', () => {
  const s = carryOverSection('Fix the parser', 'Goal: fix parser\nNext steps: run tests');
  assert.match(s, /Continued from an earlier chat \("Fix the parser"\)/);
  assert.match(s, /Next steps: run tests/);
});

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
