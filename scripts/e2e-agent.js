// End-to-end check of the agent loop outside VS Code, against a real model server.
// Usage: node scripts/e2e-agent.js <workspaceDir> "<task>" [model] [baseUrl]
// Requires `npm run compile` first. Commands and edits are auto-approved, so
// point it at a throwaway copy of a project.

const Module = require('module');
const path = require('path');
const fs = require('fs');

// Minimal stand-in for the parts of the vscode API the agent tools use.
const root = path.resolve(process.argv[2] || '.');
const fakeVscode = {
  workspace: {
    async findFiles(pattern) {
      const all = [];
      (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (['node_modules', '.git', 'out', '__pycache__'].includes(e.name)) continue;
          const full = path.join(dir, e.name);
          e.isDirectory() ? walk(full) : all.push(full);
        }
      })(root);
      const re = globToRegex(pattern || '**/*');
      return all.filter((f) => re.test(path.relative(root, f).replace(/\\/g, '/'))).map((f) => ({ fsPath: f }));
    },
    asRelativePath(u) {
      return path.relative(root, u.fsPath).replace(/\\/g, '/');
    },
  },
  window: { showWarningMessage: async () => 'Allow' },
};
function globToRegex(g) {
  const s = g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.');
  return new RegExp(`^${s}$`);
}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'vscode') return 'vscode';
  return origResolve.call(this, req, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: fakeVscode };

const { Agent } = require('../out/agent');

(async () => {
  const task = process.argv[3] || 'List the files in this project and summarize what it does.';
  const cfg = {
    baseUrl: process.argv[5] || 'http://127.0.0.1:8080/v1',
    apiKey: 'local',
    model: process.argv[4] || 'perdev-coder',
  };
  const agent = new Agent(root);
  const started = Date.now();
  const outcome = await agent.run(
    task,
    cfg,
    { maxSteps: 15, maxContextChars: 40000, approveCommands: false, approveEdits: false },
    (e) => {
      if (e.type === 'text') process.stdout.write(e.delta);
      else if (e.type === 'assistant_end') process.stdout.write('\n');
      else if (e.type === 'tool_start') console.log(`\n>> ${e.name} ${e.args}`);
      else if (e.type === 'tool_end') console.log(`<< ${e.result.slice(0, 400).replace(/\n/g, '\n   ')}`);
      else if (e.type === 'error') console.log(`!! ${e.message}`);
    },
  );
  const toolCalls = agent.messages.filter((m) => m.role === 'tool').length;
  console.log(`\n== outcome: ${outcome}, tool calls: ${toolCalls}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exit(outcome === 'done' ? 0 : 1);
})();
