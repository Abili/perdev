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
      description: 'Create a new file or completely overwrite an existing one. To change part of an existing file, use edit_file instead.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root' },
          content: { type: 'string', description: 'Full file content, exactly as it should be saved (no line numbers)' },
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
        'Replace an exact snippet in a file. This is the preferred way to change existing files. old_str must match the file exactly (including indentation) and occur exactly once. Read the file first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_str: { type: 'string', description: 'Exact text to replace, copied from the file without the line numbers read_file shows' },
          new_str: { type: 'string', description: 'Replacement text (no line numbers)' },
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
  {
    type: 'function',
    function: {
      name: 'start_server',
      description:
        'Start a long-running dev server in the background (e.g. "npm run dev", "python -m http.server 8000") and return its address once it answers. Use run_command for commands that finish.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          url: { type: 'string', description: 'Optional: the address it serves, e.g. http://localhost:5173 (found automatically otherwise)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_in_browser',
      description:
        'Open a page of this project in a browser to test it: returns the title, visible text, console errors and failed requests, and shows the page to the user. Takes a localhost address or a file in the project (e.g. index.html).',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'e.g. http://localhost:5173 or index.html' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_plan',
      description:
        'Show the user your plan as a checklist. For a task with several steps, call it first with all the steps, then again with the full list whenever a step starts or finishes.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'All steps, in order',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Short step, e.g. "Add shake detection"' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
              },
              required: ['text', 'status'],
            },
          },
        },
        required: ['steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_docs',
      description:
        "Look something up in a language's or library's official documentation (via DevDocs). Use it when unsure how a function, class or API works instead of guessing. Returns the best matching section plus other matching pages.",
      parameters: {
        type: 'object',
        properties: {
          docs: { type: 'string', description: 'Which documentation, e.g. python, javascript, typescript, node, react, html, css, dom, rust, go, django, flask, numpy, pandas. Add a version if it matters: "python 3.12".' },
          query: { type: 'string', description: 'What to look up, e.g. "str.join", "json.loads", "Array.prototype.map", "useEffect"' },
          page: { type: 'string', description: 'Optional: a page from an earlier lookup_docs result, to read it instead of searching' },
        },
        required: ['docs'],
      },
    },
  },
];

// Small models sometimes copy read_file's "   12  " line-number prefixes into
// the text they write. If every non-empty line carries such a prefix, remove it.
// Returns the text unchanged otherwise.
// minLines: how many numbered lines count as evidence (callers that can verify
// the result against the file may pass 1).
export function stripLineNumbers(text: string, minLines = 2): { text: string; stripped: boolean } {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const prefix = /^ {0,4}(\d{1,5})(?:  |$)/;
  if (nonEmpty.length < minLines || !nonEmpty.every((l) => prefix.test(l))) return { text, stripped: false };
  // Numbers must count up by one, like read_file output, to avoid touching real data.
  const nums = nonEmpty.map((l) => Number(l.match(prefix)![1]));
  if (!nums.every((n, i) => i === 0 || n === nums[i - 1] + 1)) return { text, stripped: false };
  return { text: lines.map((l) => l.replace(prefix, '')).join('\n'), stripped: true };
}

// Works out what an edit_file call should replace in `text` (LF line endings).
// Accepts old_str/new_str with read_file line numbers when that is clearly what
// happened: the numbered text isn't in the file but the un-numbered text is.
export function planEdit(
  text: string,
  oldStr: string,
  newStr: string,
): { ok: true; oldStr: string; newStr: string; stripped: boolean } | { ok: false; error: string } {
  oldStr = oldStr.replace(/\r\n/g, '\n');
  newStr = newStr.replace(/\r\n/g, '\n');
  let stripped = false;
  if (!text.includes(oldStr)) {
    const o = stripLineNumbers(oldStr, 1);
    if (o.stripped && text.includes(o.text)) {
      oldStr = o.text;
      stripped = true;
      const n = stripLineNumbers(newStr, 1);
      if (n.stripped) newStr = n.text;
    }
  }
  const count = oldStr ? text.split(oldStr).length - 1 : 0;
  if (count === 0) {
    return { ok: false, error: 'Error: old_str was not found in the file. Read the file again and copy the text exactly, including indentation.' };
  }
  if (count > 1) {
    return { ok: false, error: `Error: old_str occurs ${count} times. Include more surrounding lines so it is unique.` };
  }
  return { ok: true, oldStr, newStr, stripped };
}

// The text run_command returns. A silent command says so explicitly: a bare
// "exit code: 0" made the local model think nothing had happened and run it again.
export const NO_OUTPUT_NOTE = '(the command finished and printed nothing)';
export function formatCommandResult(code: number | string, note: string, stdout: string, stderr: string): string {
  const body = stdout || stderr ? `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}` : NO_OUTPUT_NOTE;
  return `exit code: ${code}${note}\n${body}`;
}

// Same truncation the tools apply at runtime; training data uses it too.
export function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const half = MAX_OUTPUT / 2;
  return `${s.slice(0, half)}\n\n... [${s.length - MAX_OUTPUT} characters truncated] ...\n\n${s.slice(-half)}`;
}
