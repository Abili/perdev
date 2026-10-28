// The agent's tools: read, write, edit, list, search files and run commands.
// Everything is scoped to the workspace root.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { TOOL_SPECS, formatCommandResult, planEdit, stripLineNumbers, truncate } from './toolSpecs';
import { DocsLookup } from './docs';
import { refusedCommand } from './safety';

export { TOOL_SPECS };

export interface ToolContext {
  root: string;
  approveCommands: boolean;
  approveEdits: boolean;
  signal: AbortSignal;
  shellPath?: string; // run_command's shell; default is the OS shell
  docs?: DocsLookup; // lookup_docs; undefined when docs lookup is turned off
}

const EXCLUDE = '**/{node_modules,.git,out,dist,build,.venv,__pycache__}/**';

function resolveInRoot(root: string, p: string): string {
  const full = path.resolve(root, p);
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path "${p}" is outside the workspace.`);
  }
  return full;
}

async function confirm(message: string, detail: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Allow');
  return choice === 'Allow';
}

export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  let args: any;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return `Error: arguments were not valid JSON: ${rawArgs}`;
  }
  try {
    switch (name) {
      case 'read_file':
        return await readFile(ctx, args);
      case 'write_file':
        return await writeFile(ctx, args);
      case 'edit_file':
        return await editFile(ctx, args);
      case 'list_files':
        return await listFiles(args);
      case 'search':
        return await search(ctx, args);
      case 'run_command':
        return await runCommand(ctx, args);
      case 'update_plan': {
        // The chat renders the checklist from this call's arguments.
        const steps = Array.isArray(args.steps) ? args.steps : [];
        const done = steps.filter((s: any) => /done|complete/i.test(s?.status ?? '')).length;
        return steps.length ? `Plan shown to the user (${done}/${steps.length} done).` : 'Error: give "steps": a list of {text, status}.';
      }
      case 'lookup_docs':
        if (!ctx.docs) return 'Error: documentation lookup is turned off (perdev.docs.enabled).';
        return truncate(await ctx.docs.lookup(args));
      default:
        return `Error: unknown tool "${name}". Available: ${TOOL_SPECS.map((t) => t.function.name).join(', ')}`;
    }
  } catch (e: any) {
    return `Error: ${e?.message ?? String(e)}`;
  }
}

async function readFile(ctx: ToolContext, a: { path: string; offset?: number; limit?: number }) {
  const full = resolveInRoot(ctx.root, a.path);
  const text = await fs.readFile(full, 'utf8');
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, a.offset ?? 1);
  const limit = a.limit ?? 400;
  const slice = lines.slice(start - 1, start - 1 + limit);
  const body = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');
  const more = start - 1 + limit < lines.length ? `\n[${lines.length} lines total; use offset to read more]` : '';
  return truncate(body + more);
}

// Show a file the agent just wrote, like other coding tools do: it opens as a
// preview tab (replaced by the next one) without taking focus from the chat,
// and the Explorer highlights it in the file tree.
function showChangedFile(full: string) {
  if (typeof vscode.window?.showTextDocument !== 'function') return; // outside VS Code (tests)
  void Promise.resolve(vscode.window.showTextDocument(vscode.Uri.file(full), { preview: true, preserveFocus: true })).catch(() => {});
}

const NUMBERS_NOTE = ' Note: read_file line numbers were removed from your text; never include them.';

async function writeFile(ctx: ToolContext, a: { path: string; content: string }) {
  const full = resolveInRoot(ctx.root, a.path);
  const { text: content, stripped } = stripLineNumbers(a.content);
  if (ctx.approveEdits && !(await confirm(`PerDev wants to write ${a.path}`, content.slice(0, 1500)))) {
    return 'Error: the user declined this write.';
  }
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
  showChangedFile(full);
  return `Wrote ${a.path} (${content.split('\n').length} lines).${stripped ? NUMBERS_NOTE : ''}`;
}

async function editFile(ctx: ToolContext, a: { path: string; old_str: string; new_str: string }) {
  const full = resolveInRoot(ctx.root, a.path);
  const original = await fs.readFile(full, 'utf8');
  // Models often normalize line endings; match against LF and restore CRLF if the file uses it.
  const crlf = original.includes('\r\n');
  const text = crlf ? original.replace(/\r\n/g, '\n') : original;
  const plan = planEdit(text, a.old_str ?? '', a.new_str ?? '');
  if (!plan.ok) return plan.error;
  const { oldStr, newStr, stripped } = plan;
  if (ctx.approveEdits && !(await confirm(`PerDev wants to edit ${a.path}`, `- ${oldStr}\n+ ${newStr}`))) {
    return 'Error: the user declined this edit.';
  }
  let updated = text.replace(oldStr, () => newStr);
  if (crlf) updated = updated.replace(/\n/g, '\r\n');
  await fs.writeFile(full, updated, 'utf8');
  showChangedFile(full);
  return `Edited ${a.path}.${stripped ? NUMBERS_NOTE : ''}`;
}

async function listFiles(a: { pattern?: string }) {
  const uris = await vscode.workspace.findFiles(a.pattern || '**/*', EXCLUDE, 500);
  const paths = uris.map((u) => vscode.workspace.asRelativePath(u)).sort();
  return paths.length ? truncate(paths.join('\n')) : 'No files matched.';
}

async function search(ctx: ToolContext, a: { regex: string; glob?: string }) {
  let re: RegExp;
  try {
    re = new RegExp(a.regex);
  } catch (e: any) {
    return `Error: invalid regex: ${e.message}`;
  }
  const uris = await vscode.workspace.findFiles(a.glob || '**/*', EXCLUDE, 2000);
  const hits: string[] = [];
  for (const uri of uris) {
    if (ctx.signal.aborted || hits.length >= 200) break;
    let text: string;
    try {
      const stat = await fs.stat(uri.fsPath);
      if (stat.size > 1_000_000) continue;
      text = await fs.readFile(uri.fsPath, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue; // binary
    const rel = vscode.workspace.asRelativePath(uri);
    text.split(/\r?\n/).forEach((line, i) => {
      if (hits.length < 200 && re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
    });
  }
  return hits.length ? truncate(hits.join('\n')) : 'No matches.';
}

async function runCommand(ctx: ToolContext, a: { command: string }) {
  // Never run, whatever the mode: wiping disks, deleting outside the project...
  const refused = refusedCommand(a.command ?? '', ctx.root);
  if (refused) return `Error: ${refused}`;
  if (ctx.approveCommands && !(await confirm('PerDev wants to run a command', a.command))) {
    return 'Error: the user declined to run this command.';
  }
  return new Promise<string>((resolve) => {
    const child = exec(
      a.command,
      { cwd: ctx.root, timeout: 120_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, ...(ctx.shellPath ? { shell: ctx.shellPath } : {}) },
      (err, stdout, stderr) => {
        const code = err ? ((err as any).code ?? 1) : 0;
        const timedOut = err && (err as any).killed ? ' (timed out or stopped)' : '';
        resolve(truncate(formatCommandResult(code, timedOut, stdout, stderr)));
      },
    );
    ctx.signal.addEventListener('abort', () => child.kill(), { once: true });
  });
}
