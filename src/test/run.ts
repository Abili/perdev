// Unit tests for the parts that don't need VS Code. Run with: npm test
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseFallbackToolCalls } from '../llm';
import { trimContext } from '../context';
import { cleanCompletion, fimFormatFor } from '../fim';
import { ChatMessage } from '../llm';
import { SessionStore, newSessionId, titleFrom } from '../sessions';
import { carryOverSection, looksLikeAskingUserToAct, looksLikeUnfinishedPlan } from '../prompt';

test('a reply asking the user to run a tool is detected (real 7B replies)', () => {
  const names = ['read_file', 'list_files'];
  assert.equal(looksLikeAskingUserToAct("To understand what `calc.py` does, I'll need to read its contents. Please call `read_file` with the path to `calc.py`.", names), true);
  assert.equal(looksLikeAskingUserToAct("I'll need to read its contents. Could you please provide the content of calc.py?", names), true);
  assert.equal(looksLikeAskingUserToAct('calc.py defines add, subtract and average. Please run the tests when you can.', names), false);
});

test('a reply that only plans a change is detected; a finished summary is not', () => {
  // Real replies from the local 7B model.
  assert.equal(looksLikeUnfinishedPlan('The error occurs because it divides by zero. To fix this, we need to add a check to ensure that the list is not empty.'), true);
  assert.equal(looksLikeUnfinishedPlan('I fixed the `average` function in `calc.py` to handle the empty list. The tests now pass successfully.'), false);
  assert.equal(looksLikeUnfinishedPlan('The function returns the sum of two numbers.'), false);
});
import { formatCommandResult, planEdit, stripLineNumbers } from '../toolSpecs';
import { LoopGuard } from '../loopGuard';
import { resolveShell } from '../shell';

test('repeated identical tool calls are blocked, then the run is stopped', () => {
  const g = new LoopGuard();
  assert.equal(g.check('run_command', '{"command":"python calc.py"}').action, 'run');
  g.record('run_command', '{"command":"python calc.py"}', 'exit code: 0\n(the command finished and printed nothing)');
  const second = g.check('run_command', '{ "command": "python calc.py" }'); // same call, different spacing
  assert.equal(second.action, 'block');
  assert.match((second as any).message, /printed nothing[\s\S]*not run again/);
  assert.equal(g.check('run_command', '{"command":"python calc.py"}').action, 'block');
  assert.equal(g.check('run_command', '{"command":"python calc.py"}').action, 'stop'); // fourth identical call
  assert.equal(g.check('run_command', '{"command":"python -m unittest"}').action, 'run');
});

test('after an edit, reading the file again is allowed', () => {
  const g = new LoopGuard();
  g.record('read_file', '{"path":"calc.py"}', 'old');
  assert.equal(g.check('read_file', '{"path":"calc.py"}').action, 'block');
  g.forgetReads();
  assert.equal(g.check('read_file', '{"path":"calc.py"}').action, 'run');
});

test('a silent command says so explicitly', () => {
  assert.equal(formatCommandResult(0, '', '', ''), 'exit code: 0\n(the command finished and printed nothing)');
  assert.equal(formatCommandResult(1, '', '', 'boom'), 'exit code: 1\n\n[stderr]\nboom');
});

test('shell choice: Git Bash or PowerShell on Windows, never WSL bash', () => {
  const none = resolveShell('auto', 'win32', { ProgramFiles: 'Z:\\nope' });
  assert.equal(none.kind, 'powershell');
  assert.equal(resolveShell('cmd', 'win32', {}).kind, 'cmd');
  if (process.platform === 'win32' && fsSync.existsSync('C:\\Program Files\\Git\\bin\\bash.exe')) {
    const s = resolveShell('auto', 'win32', process.env);
    assert.equal(s.kind, 'bash');
    assert.ok(!/system32/i.test(s.path));
  }
});

test('edit with a line-numbered old_str still applies (real 7B output)', () => {
  const file = 'def average(numbers):\n    return sum(numbers) / len(numbers)\n';
  const p = planEdit(file,
    '    13      return sum(numbers) / len(numbers)\n',
    '    13      if len(numbers) > 0:\n    14          return sum(numbers) / len(numbers)\n    15      else:\n    16          return 0\n');
  assert.equal(p.ok, true);
  if (p.ok) {
    assert.equal(p.stripped, true);
    assert.equal(file.replace(p.oldStr, p.newStr), 'def average(numbers):\n    if len(numbers) > 0:\n        return sum(numbers) / len(numbers)\n    else:\n        return 0\n');
  }
});

test('edits that really contain numbers, or match nothing, are not rewritten', () => {
  const file = 'x = [\n  1  ,\n  2  ,\n]\n';
  const p = planEdit(file, '  1  ,\n  2  ,', '  3  ,');
  assert.equal(p.ok && p.stripped, false); // exact text is in the file: used as-is
  assert.equal(planEdit('a = 1\n', '    5  b = 2', 'c').ok, false);
  assert.match((planEdit('a\na\n', 'a', 'b') as any).error, /occurs 2 times/);
});

test('line numbers copied from read_file are stripped', () => {
  // Exactly what the 7B model produced in a real test, including an empty line.
  const copied = '    1  # A tiny sandbox\n    2  \n    3  def add(a, b):\n    4      return a + b';
  assert.deepEqual(stripLineNumbers(copied), { text: '# A tiny sandbox\n\ndef add(a, b):\n    return a + b', stripped: true });
  // Empty line that lost its trailing spaces.
  assert.equal(stripLineNumbers('   12  x = 1\n   13\n   14  y = 2').text, 'x = 1\n\ny = 2');
});

test('real content that merely starts with numbers is left alone', () => {
  const data = '1  apple\n5  banana\n9  cherry'; // not consecutive
  assert.equal(stripLineNumbers(data).stripped, false);
  assert.equal(stripLineNumbers('def f():\n    return 1').stripped, false);
  assert.equal(stripLineNumbers('    7  single line').stripped, false); // too little evidence
});
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

const TOOLS = ['read_file', 'write_file', 'edit_file', 'list_files', 'search', 'run_command'];

test('fallback parser reads <tool_call> blocks', () => {
  const r = parseFallbackToolCalls('Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n</tool_call>', TOOLS);
  assert.equal(r.call?.function.name, 'read_file');
  assert.deepEqual(JSON.parse(r.call!.function.arguments), { path: 'a.ts' });
  assert.equal(r.before, 'Let me look.');
});

test('fallback parser reads fenced JSON and bare JSON', () => {
  assert.equal(parseFallbackToolCalls('```json\n{"name":"list_files","arguments":{}}\n```', TOOLS).call?.function.name, 'list_files');
  assert.equal(parseFallbackToolCalls('{"name":"search","parameters":{"regex":"x"}}', TOOLS).call?.function.name, 'search');
});

test('a written-out plan runs only its first call and drops invented results (real 7B reply)', () => {
  const reply =
    "To understand what `calc.py` does, I'll first list the files.\n\n```json\n{\"name\": \"list_files\", \"arguments\": {\"pattern\": \"calc.py\"}}\n```\n\n" +
    'Next, search.\n\n```json\n{"name": "search", "arguments": {"regex": "calc"}}\n```\n\n' +
    'After running the above commands, here\'s the summary:\n```json\n{"name": "list_files", "arguments": {"pattern": "calc.py"}, "result": ["calc.py"]}\n```';
  const r = parseFallbackToolCalls(reply, TOOLS);
  assert.equal(r.call?.function.name, 'list_files');
  assert.equal(r.before, "To understand what `calc.py` does, I'll first list the files.");
  // A block that only shows an imagined result is never run.
  assert.equal(parseFallbackToolCalls('```json\n{"name": "list_files", "arguments": {}, "result": ["a"]}\n```', TOOLS).call, undefined);
});

test('a bare JSON call mid-sentence is found (real 7B reply)', () => {
  const r = parseFallbackToolCalls("It appears that `calc.py` exists. Let's read its contents.  {\"name\": \"read_file\", \"arguments\": {\"path\": \"calc.py\"}} Then I'll explain.", TOOLS);
  assert.equal(r.call?.function.name, 'read_file');
  assert.equal(r.before, "It appears that `calc.py` exists. Let's read its contents.");
  // What a prefilled continuation looks like once the prefix is put back.
  assert.equal(parseFallbackToolCalls('{"name": "' + 'read_file", "arguments": {"path": "calc.py"}}\n\n', TOOLS).call?.function.name, 'read_file');
});

test('"let me know" is not an unfinished plan', () => {
  assert.equal(looksLikeUnfinishedPlan('calc.py defines add, subtract and average. Let me know if you want tests.'), false);
  assert.equal(looksLikeUnfinishedPlan("Let me read calc.py first."), true);
});

test('fallback parser ignores ordinary answers and unknown names', () => {
  assert.equal(parseFallbackToolCalls('Here is the fix:\n```ts\nconst x = { a: 1 };\n```', TOOLS).call, undefined);
  assert.equal(parseFallbackToolCalls('The answer is 42.', TOOLS).call, undefined);
  assert.equal(parseFallbackToolCalls('```json\n{"name": "John", "arguments": {}}\n```', TOOLS).call, undefined);
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
