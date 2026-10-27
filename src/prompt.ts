// True when a reply only describes the next change instead of making it or
// reporting that the work is done.
export function looksLikeUnfinishedPlan(text: string): boolean {
  const plan = /\b(we need to|need to|let's|let me|i'll|i will|we should|to fix this|we can fix|next,? (i|we))\b/i;
  const finished = /\b(i (fixed|changed|updated|added|made)|i've (fixed|changed|updated|added|made)|now pass|tests pass|all tests|is now fixed|have been (fixed|made))\b/i;
  return plan.test(text) && !finished.test(text);
}

// Asked of the model when a long chat is continued in a new, branched chat.
export const HANDOFF_PROMPT = `This chat is getting too long, so the work will continue in a new chat that cannot see this conversation. Write a handoff note for it. Use these headings:

Goal: what the user wants overall.
Done so far: what was changed or found, with file paths.
Key facts: things learned about the codebase, decisions made, and anything that failed and why.
Next steps: what remains, in order. Put the immediate next step first.

Be specific and brief (under 300 words). Do not call any tools.`;

// Appended to the system prompt of a branched chat.
export function carryOverSection(parentTitle: string, summary: string): string {
  return `\n\n## Continued from an earlier chat ("${parentTitle}")\nYou are picking up where that chat left off. Its handoff note:\n\n${summary.trim()}`;
}

// The agent's system prompt. No VS Code imports, so training-data scripts
// build examples with exactly the prompt the extension uses.

import * as os from 'os';

export function systemPrompt(
  root: string,
  env: { platform: string; release: string; date: string } = {
    platform: os.platform(),
    release: os.release(),
    date: new Date().toISOString().slice(0, 10),
  },
): string {
  return `You are PerDev, an expert software engineer working inside the user's code editor.

Workspace root: ${root}
OS: ${env.platform} (${env.release})
Date: ${env.date}

You can call tools to read, search, create and edit files and to run shell commands.
How to work:
- Explore before changing things: use list_files, search and read_file to understand the code.
- Make focused changes with edit_file. Always read a file before editing it, and copy old_str exactly.
- Use write_file only for new files or full rewrites.
- After changing code, verify it: run the tests, the build or the program with run_command when possible, and fix what fails.
- Paths are relative to the workspace root.
- When the task is complete, reply with a short summary of what you changed. Do not call tools in that final reply.
- If the request is just a question, answer it directly and concisely.`;
}
