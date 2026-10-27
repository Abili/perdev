// Tool definitions sent to the model. Kept free of VS Code imports so the
// training-data scripts can use exactly the same specs.

import { ToolSpec } from './llm';

export const MAX_OUTPUT = 12000;

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file. Returns lines prefixed with line numbers. Use offset/limit for big files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root' },
          offset: { type: 'number', description: '1-based line to start at (optional)' },
          limit: { type: 'number', description: 'Number of lines to read (optional, default 400)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or completely overwrite an existing one.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace an exact snippet in a file. old_str must match the file exactly (including indentation) and occur exactly once. Read the file first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_str: { type: 'string', description: 'Exact text to replace' },
          new_str: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in the workspace matching a glob pattern, e.g. "src/**/*.ts". Defaults to all files.',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string', description: 'Glob pattern (optional)' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description: 'Search file contents with a regular expression. Returns matching lines as path:line: text.',
      parameters: {
        type: 'object',
        properties: {
          regex: { type: 'string', description: 'JavaScript regular expression' },
          glob: { type: 'string', description: 'Limit to files matching this glob (optional)' },
        },
        required: ['regex'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the workspace root (e.g. tests, builds, git status). Returns exit code and output. Times out after 120s.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

// Same truncation the tools apply at runtime; training data uses it too.
export function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const half = MAX_OUTPUT / 2;
  return `${s.slice(0, half)}\n\n... [${s.length - MAX_OUTPUT} characters truncated] ...\n\n${s.slice(-half)}`;
}
