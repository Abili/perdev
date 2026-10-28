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
import { DocsLookup, extractSection, htmlToText, pickDocSet, rank } from '../docs';
import { McpClient, resultText } from '../mcp';
import { describeActivity, partialField } from '../activity';
import { androidPackage, androidProjectFiles, chooseAndroidVersions } from '../androidTemplate';

test('Android versions come from the local Gradle cache when available', () => {
  const home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'perdev-gradle-'));
  const cache = path.join(home, 'caches', 'modules-2', 'files-2.1');
  // A PC whose cache has an older BOM and core-ktx than the defaults.
  fsSync.mkdirSync(path.join(cache, 'androidx.compose', 'compose-bom', '2024.12.01'), { recursive: true });
  fsSync.mkdirSync(path.join(cache, 'androidx.core', 'core-ktx', '1.16.0'), { recursive: true });
  const c = chooseAndroidVersions({ GRADLE_USER_HOME: home, LOCALAPPDATA: home });
  assert.equal(c.versions.composeBom, '2024.12.01');
  assert.equal(c.versions.coreKtx, '1.16.0');
  assert.ok(c.cached.includes('composeBom 2024.12.01'));
  assert.ok(c.missing.some((m) => m.startsWith('agp ')));
  // Nothing cached at all: the defaults.
  const empty = chooseAndroidVersions({ GRADLE_USER_HOME: path.join(home, 'none') });
  assert.equal(empty.versions.agp, '9.1.1');
  assert.equal(empty.cached.length, 0);
  fsSync.rmSync(home, { recursive: true, force: true });
});
import { refusedCommand } from '../safety';
import { createAvd, parseAdbDevices } from '../devices';

test('devices: adb output is read into phones and emulators', () => {
  const out = 'List of devices attached\nR5CY72BFREA            device usb:1-1 product:pa3qxxx model:SM_S938B device:pa3q transport_id:1\nemulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 transport_id:2\nABC123 unauthorized usb:1-2 transport_id:3\n\n';
  const d = parseAdbDevices(out);
  assert.deepEqual(d.map((x) => [x.serial, x.kind, x.state, x.model]), [
    ['R5CY72BFREA', 'usb', 'device', 'SM S938B'],
    ['emulator-5554', 'emulator', 'device', 'sdk gphone64 x86 64'],
    ['ABC123', 'usb', 'unauthorized', 'ABC123'],
  ]);
});

test('devices: an emulator is created from an installed system image, drawn in software', () => {
  const home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'perdev-avd-'));
  const prev = process.env.ANDROID_AVD_HOME;
  delete process.env.ANDROID_AVD_HOME;
  createAvd({ api: 'android-36', tag: 'google_apis_playstore', abi: 'x86_64', dir: '' }, 'Test_Phone', home);
  if (prev !== undefined) process.env.ANDROID_AVD_HOME = prev;
  const cfg = fsSync.readFileSync(path.join(home, '.android', 'avd', 'Test_Phone.avd', 'config.ini'), 'utf8');
  assert.match(cfg, /image\.sysdir\.1=system-images[\\/]android-36[\\/]google_apis_playstore[\\/]x86_64[\\/]/);
  assert.match(cfg, /hw\.gpu\.mode=swiftshader_indirect/);
  assert.match(cfg, /hw\.accelerometer=yes/); // shake detection needs it
  assert.match(fsSync.readFileSync(path.join(home, '.android', 'avd', 'Test_Phone.ini'), 'utf8'), /target=android-36/);
  fsSync.rmSync(home, { recursive: true, force: true });
});

test('safety net: dangerous commands are refused in any mode, normal ones run', () => {
  const root = 'E:\\codingprojects\\notes';
  for (const bad of ['format C:', 'diskpart', 'rm -rf /', 'rm -rf ~', 'Remove-Item -Recurse C:\\', 'del /s /q C:\\Users\\eco\\Documents', 'rm -rf /c/Users/eco', 'rm -rf ../other-project', 'shutdown /s /t 0', 'reg delete HKLM\\Software\\X /f']) {
    assert.ok(refusedCommand(bad, root), `should refuse: ${bad}`);
  }
  for (const ok of ['npm test', 'python -m unittest -v', 'rm -rf build', 'rm -rf node_modules', 'del /q E:\\codingprojects\\notes\\tmp.txt', './gradlew assembleDebug', 'git status']) {
    assert.equal(refusedCommand(ok, root), undefined, `should allow: ${ok}`);
  }
});
import { looksLikeCodeForUser, looksLikeQuestion } from '../prompt';

test('code pasted for the user (instead of written to files) is detected', () => {
  const tutorial = 'To build it, follow these steps:\n\n```kotlin\nclass MainActivity : ComponentActivity() {\n  override fun onCreate(b: Bundle?) {\n    super.onCreate(b)\n    setContent { App() }\n  }\n}\n```\nThen add the sensor:\n```kotlin\nval sm = getSystemService(SENSOR_SERVICE)\nval a = sm.getDefaultSensor(1)\nsm.registerListener(this, a, 2)\n```';
  assert.equal(looksLikeCodeForUser(tutorial), true);
  assert.equal(looksLikeCodeForUser('Use `str.join` like this: ```py\n", ".join(x)\n```'), false); // a one-line example is fine
  assert.equal(looksLikeQuestion('how do I read a file in Kotlin?'), true);
  assert.equal(looksLikeQuestion('a simple sticky notes app\n\n[Workspace files:\nPERDEV.md]'), false);
});

test('Android template: a complete Compose project with a safe package name', () => {
  assert.equal(androidPackage('Sticky Notes!'), 'com.example.stickynotes');
  assert.equal(androidPackage('2048 game'), 'com.example.app2048game');
  const files = androidProjectFiles('Sticky Notes');
  for (const f of ['settings.gradle.kts', 'build.gradle.kts', 'gradle/libs.versions.toml', 'app/build.gradle.kts', 'app/src/main/AndroidManifest.xml', 'app/src/main/java/com/example/stickynotes/MainActivity.kt']) {
    assert.ok(files[f], f);
  }
  assert.match(files['app/build.gradle.kts'], /namespace = "com\.example\.stickynotes"/);
  assert.match(files['settings.gradle.kts'], /includeGroupByRegex\("com\\\\\.android\.\*"\)/);
});
import { splitThinking } from '../llm';

test('activity lines describe tool calls, even while their arguments are still streaming', () => {
  assert.equal(describeActivity('write_file', '{"path": "src/app.ts", "content": "imp'), 'Writing src/app.ts');
  assert.equal(describeActivity('write_file', '{"pa'), 'Writing a file');
  assert.equal(describeActivity('run_command', '{"command":"python -m unittest -v"}'), 'Running python -m unittest -v');
  assert.equal(describeActivity('lookup_docs', '{"docs":"python","query":"str.join"}'), 'Looking up “str.join” in the python docs');
  assert.equal(describeActivity('tap', '{"text":"Add note"}'), 'Tapping “Add note”');
  assert.equal(describeActivity('mystery_tool', '{}'), 'Using mystery tool');
  assert.equal(partialField('{"path": "a\\\\b.ts"', 'path'), 'a\\b.ts');
});

test('<think> reasoning is separated from the reply, even mid-stream', () => {
  assert.deepEqual(splitThinking('<think>check the tests first</think>\n\nThe tests pass.', true), { visible: 'The tests pass.', thinking: 'check the tests first' });
  assert.deepEqual(splitThinking('<think>still thinking', false), { visible: '', thinking: 'still thinking' });
  // A partial tag at the end is held back while streaming, never shown as reply text.
  assert.deepEqual(splitThinking('<thi', false), { visible: '', thinking: '' });
  assert.deepEqual(splitThinking('Hello <', false), { visible: 'Hello ', thinking: '' });
  assert.deepEqual(splitThinking('No thinking here.', false), { visible: 'No thinking here.', thinking: '' });
});
import { checkAvailability, packageName, PROJECT_TYPES, writeStarterFiles } from '../projectTypes';

test('project types: every card has a setup, names are made safe, iOS needs a Mac', async () => {
  assert.ok(PROJECT_TYPES.length >= 9);
  for (const t of PROJECT_TYPES) assert.ok(t.setup && t.agentPrompt && t.title, t.id);
  assert.equal(packageName('My Cool App!'), 'my-cool-app');
  assert.equal(PROJECT_TYPES.find((t) => t.id === 'flutter')!.setup.kind === 'command' && (PROJECT_TYPES.find((t) => t.id === 'flutter')!.setup as any).command('Shop App 2'), 'flutter create --project-name shop_app_2 .');
  const win = await checkAvailability('win32');
  assert.equal(win.ios.ok, false);
  assert.match(win.ios.note!, /needs a Mac/);
  assert.equal(win['static-site'].ok, true); // nothing required
});

test('starter files are written but never overwrite existing files', () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'perdev-start-'));
  const site = PROJECT_TYPES.find((t) => t.id === 'static-site')!;
  fsSync.writeFileSync(path.join(dir, 'index.html'), 'mine');
  const written = writeStarterFiles(dir, (site.setup as any).files('Shop'));
  assert.deepEqual(written.sort(), ['app.js', 'style.css']);
  assert.equal(fsSync.readFileSync(path.join(dir, 'index.html'), 'utf8'), 'mine');
  const api = PROJECT_TYPES.find((t) => t.id === 'node-api')!;
  writeStarterFiles(dir, (api.setup as any).files('My Shop'));
  assert.equal(JSON.parse(fsSync.readFileSync(path.join(dir, 'package.json'), 'utf8')).name, 'my-shop');
  fsSync.rmSync(dir, { recursive: true, force: true });
});
import { isAndroidProject, McpManager } from '../mcpManager';

// A minimal MCP server over stdio, standing in for DroidLoop.
const FAKE_MCP = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const tools = ['list_devices', 'tap', 'ui_tree', 'screenshot', 'run_flow', 'launch'].map((name) => ({ name, description: name + ' tool', inputSchema: { type: 'object', properties: {} } }));
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  else if (m.method === 'tools/call') {
    const n = m.params.name;
    if (n === 'screenshot') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'scale 0.5' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }] } });
    else if (n === 'tap') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'No element with id 99' }], isError: true } });
    else send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: n + ' ok ' + JSON.stringify(m.params.arguments) }] } });
  }
});`;
const fakeServer = () => ({ command: process.execPath, args: ['-e', FAKE_MCP] });

test('MCP client: connects, lists tools, calls them, reports images and errors', async () => {
  const c = new McpClient('fake', fakeServer());
  await c.start();
  assert.deepEqual(c.tools.map((t) => t.name), ['list_devices', 'tap', 'ui_tree', 'screenshot', 'run_flow', 'launch']);
  assert.equal(resultText(await c.callTool('list_devices', { all: true })), 'list_devices ok {"all":true}');
  const shot = await c.callTool('screenshot', {});
  assert.equal(shot.images.length, 1);
  assert.match(resultText(shot), /scale 0\.5\n\[1 image\(s\) shown to the user[\s\S]*use ui_tree/);
  assert.match(resultText(await c.callTool('tap', { elementId: 99 })), /^Error: No element with id 99/);
  c.stop();
});

test('MCP manager: Android-only servers, tool subsets, read-only tools skip approval', async () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'perdev-mcp-'));
  const m = new McpManager(() => {});
  const servers = { droidloop: { ...fakeServer(), when: 'android' as const } };
  assert.equal(await m.toolsFor(dir, servers, 'explain calc.py'), undefined); // not an Android project
  assert.equal(isAndroidProject(dir), false);
  const viaWords = await m.toolsFor(dir, servers, 'run it on the emulator');
  assert.ok(viaWords);
  fsSync.writeFileSync(path.join(dir, 'gradlew'), '');
  const extra = (await m.toolsFor(dir, servers, 'explain MainActivity'))!;
  // DroidLoop's default subset leaves out run_flow.
  assert.deepEqual(extra.specs.map((s) => s.function.name).sort(), ['launch', 'list_devices', 'screenshot', 'tap', 'ui_tree']);
  assert.equal(extra.needsApproval('ui_tree'), false);
  assert.equal(extra.needsApproval('tap'), true);
  assert.match(extra.notes, /call ui_tree/);
  assert.equal(resultText(await extra.call('ui_tree', '{}')), 'ui_tree ok {}');
  // After an action that changes the screen, the new screen is attached.
  assert.equal(resultText(await extra.call('launch', '{"packageName":"a.b"}')), 'launch ok {"packageName":"a.b"}\n\nScreen now (ui_tree):\nui_tree ok {}');
  // A failed action gets no screen attached.
  assert.equal(resultText(await extra.call('tap', '{"elementId":99}')), 'Error: No element with id 99');
  m.dispose();
  // The stopped server may still hold the folder for a moment on Windows.
  fsSync.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const CATALOG = [
  { name: 'Python', slug: 'python~3.12', release: '3.12.9' },
  { name: 'Python', slug: 'python~3.13', release: '3.13.8' },
  { name: 'Python', slug: 'python~2.7', release: '2.7.17' },
  { name: 'JavaScript', slug: 'javascript' },
  { name: 'Node.js', slug: 'node', release: '26.3.1' },
  { name: 'Node.js', slug: 'node~22_lts', release: '22.20.0' },
  { name: 'Web APIs', slug: 'dom' },
];

test('doc sets: aliases, newest version by default, explicit versions', () => {
  assert.equal((pickDocSet(CATALOG, 'python') as any).slug, 'python~3.13');
  assert.equal((pickDocSet(CATALOG, 'Python 3.12') as any).slug, 'python~3.12');
  assert.equal((pickDocSet(CATALOG, 'py') as any).slug, 'python~3.13');
  assert.equal((pickDocSet(CATALOG, 'js') as any).slug, 'javascript');
  assert.equal((pickDocSet(CATALOG, 'node') as any).slug, 'node');
  assert.equal((pickDocSet(CATALOG, 'dom') as any).slug, 'dom');
  assert.match(pickDocSet(CATALOG, 'cobol') as string, /^Error: no documentation named "cobol"/);
});

test('doc search ranks exact and method-name matches first', () => {
  const entries = [
    { name: 'str.join()', path: 'library/stdtypes#str.join', type: 'Built-in Types' },
    { name: 'os.path.join()', path: 'library/os.path#os.path.join', type: 'Files' },
    { name: 'shlex.join()', path: 'library/shlex#shlex.join', type: 'Parsing' },
    { name: 'threading.Thread.join()', path: 'library/threading#threading.Thread.join', type: 'Concurrency' },
  ];
  assert.equal(rank(entries, 'str.join')[0].name, 'str.join()');
  assert.equal(rank(entries, 'os.path.join()')[0].name, 'os.path.join()');
  assert.equal(rank(entries, 'join').length, 4);
  const js = [{ name: 'Map', path: 'global_objects/map', type: 'Map' }, { name: 'Array.map', path: 'global_objects/array/map', type: 'Array' }];
  assert.equal(rank(js, 'Array.prototype.map()')[0].name, 'Array.map');
  assert.equal(rank(entries, 'nothing here').length, 0);
});

test('a doc page is cut down to the requested entry and turned into text', () => {
  const html =
    '<h1>Built-in Types</h1><dl class="py method"><dt class="sig" id="str.isupper"><code>str.isupper()</code></dt><dd><p>Return True if upper.</p></dd></dl>' +
    '<dl class="py method"><dt class="sig" id="str.join"><code>str.join(iterable)</code></dt><dd><p>Return a string which is the concatenation of the strings in <em>iterable</em>.</p>' +
    '<pre>&gt;&gt;&gt; ", ".join(["a", "b"])\n\'a, b\'</pre></dd></dl><dl class="py method"><dt class="sig" id="str.ljust"><code>str.ljust()</code></dt><dd><p>Pad.</p></dd></dl>';
  const s = extractSection(html, 'str.join', 6000);
  assert.match(s, /`str\.join\(iterable\)`/);
  assert.match(s, /concatenation of the strings/);
  assert.match(s, /```\n>>> ", "\.join\(\["a", "b"\]\)/);
  assert.doesNotMatch(s, /isupper|ljust/);
  assert.equal(htmlToText('<p>a &amp; b &lt;c&gt;</p>'), 'a & b <c>');
});

test('docs lookup downloads each index and page once, then uses the cache', async () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'perdev-docs-'));
  const fetched: string[] = [];
  const fake = async (url: string) => {
    fetched.push(url);
    if (url.endsWith('docs.json')) return JSON.stringify(CATALOG);
    if (url.endsWith('index.json')) return JSON.stringify({ entries: [{ name: 'json.loads()', path: 'library/json#json.loads', type: 'Internet Data' }] });
    return '<dl><dt id="json.loads">json.loads(s)</dt><dd><p>Deserialize s to a Python object.</p></dd></dl>';
  };
  const docs = new DocsLookup(dir, fake);
  const first = await docs.lookup({ docs: 'python', query: 'json.loads' });
  assert.match(first, /Python 3\.13\.8 documentation, best match: json\.loads\(\)/);
  assert.match(first, /Deserialize s to a Python object/);
  const second = await docs.lookup({ docs: 'python', query: 'json.loads' });
  assert.equal(second, first);
  assert.equal(fetched.length, 3); // catalog, index, page: each once
  assert.match(await docs.lookup({ docs: '', query: 'x' }), /^Error: say which documentation/);
  fsSync.rmSync(dir, { recursive: true, force: true });
});

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

test('after a device action, repeating an earlier call runs it again', () => {
  const g = new LoopGuard();
  g.record('type_text', '{"text":"Milk"}', 'Error: no focused text field');
  assert.equal(g.check('type_text', '{"text":"Milk"}').action, 'block');
  g.forgetAll(); // e.g. after tapping the field
  assert.equal(g.check('type_text', '{"text":"Milk"}').action, 'run');
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
