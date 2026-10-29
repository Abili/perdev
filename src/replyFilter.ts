// Decides what part of a streaming reply reaches the chat. When the user asked
// for work (not a question), code belongs in files, not in the chat: a code
// block is hidden while it streams, and once it is complete the reply ends so
// PerDev can write that code to its file (the local 7B otherwise types whole
// files into the chat, then writes them again). Tool calls written as text are
// hidden too, and a reply stuck repeating itself ("Step 12: Update Plan ...
// Step 13: Update Plan ...") is cut off.

export interface FilterUpdate {
  show: string; // new text for the chat
  cutForCode: boolean; // a whole code block has been written: stop generating
  repeating: boolean; // the reply is going round in circles: stop generating
  codeLines?: number; // lines of hidden code so far, for the status line
  toolCall?: { name: string; partialArgs: string }; // a tool call is being written as text
}

const MARKERS = ['```', '<tool_call>', '{"name"'];

export class ReplyFilter {
  full = '';
  private shown = 0;
  private hiddenFrom = -1;
  private fenceAt = -1;
  private cut = false;
  private repeated = false;
  // The first complete code block of a work reply.
  code?: { lang: string; body: string };

  constructor(private readonly isQuestion: boolean) {}

  push(delta: string): FilterUpdate {
    this.full += delta;
    let toolCall: FilterUpdate['toolCall'];
    let codeLines: number | undefined;
    if (this.hiddenFrom < 0) {
      const fence = this.isQuestion ? -1 : this.full.indexOf('```');
      const tagged = this.full.indexOf('<tool_call>');
      const json = this.full.search(/\{\s*"name"\s*:/);
      const at = [fence, tagged, json].filter((i) => i >= 0).sort((a, b) => a - b)[0];
      if (at !== undefined) {
        this.hiddenFrom = at;
        if (at === fence) this.fenceAt = fence;
      }
    }
    if (this.fenceAt >= 0 && !this.cut) {
      const m = this.full.slice(this.fenceAt).match(/^```([\w+#.-]*)[^\n]*\n([\s\S]*?)\n?```/);
      if (m && /^\s*\{\s*"name"\s*:/.test(m[2])) {
        // A tool call written in a ```json block, not code for a file: it stays
        // hidden and is run as a call when the reply ends.
        this.fenceAt = -1;
      } else if (m) {
        this.code = { lang: m[1], body: m[2] + '\n' };
        this.cut = true;
      } else codeLines = this.full.slice(this.fenceAt).split('\n').length - 1;
    }
    if (this.hiddenFrom >= 0 && this.fenceAt < 0) {
      const m = this.full.slice(this.hiddenFrom).match(/"name"\s*:\s*"([A-Za-z0-9_]+)"\s*,\s*"arguments"\s*:\s*([\s\S]*)$/);
      if (m) toolCall = { name: m[1], partialArgs: m[2] };
    }
    if (!this.repeated && !this.isQuestion && repeatsItself(this.full)) {
      this.repeated = true;
      // Show nothing more of it.
      if (this.hiddenFrom < 0) this.hiddenFrom = this.full.length;
    }
    // Hold back a trailing piece that might be the start of a marker ("``", "<tool", '{"na').
    const end = this.hiddenFrom >= 0 ? this.hiddenFrom : this.full.length - heldBack(this.full);
    const show = end > this.shown ? this.full.slice(this.shown, end) : '';
    this.shown = Math.max(this.shown, end);
    return { show, cutForCode: this.cut, repeating: this.repeated, codeLines, toolCall };
  }

  // What was shown in the chat (the reply minus hidden code, tool calls and repetition).
  get visible(): string {
    return this.full.slice(0, this.shown);
  }

  // At the end: release held-back text that turned out not to be a marker.
  flush(): string {
    if (this.hiddenFrom >= 0 || this.shown >= this.full.length) return '';
    const rest = this.full.slice(this.shown);
    this.shown = this.full.length;
    return rest;
  }
}

// The same line of prose three times: the model is looping, not progressing.
// Code is left out: it legitimately repeats lines.
export function repeatsItself(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?(```|$)/g, '').replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, '');
  const counts = new Map<string, number>();
  for (const raw of prose.split('\n')) {
    const line = raw.replace(/^[#\s*-]*(step\s*\d+[:.]?)?\s*/i, '').trim().toLowerCase();
    if (line.length < 20) continue;
    const n = (counts.get(line) ?? 0) + 1;
    if (n >= 3) return true;
    counts.set(line, n);
  }
  return false;
}

function heldBack(text: string): number {
  for (let n = Math.min(10, text.length); n > 0; n--) {
    const tail = text.slice(-n);
    if (MARKERS.some((m) => m.startsWith(tail) || tail.startsWith('{') && '{"name"'.startsWith(tail.replace(/\s+/g, '')))) return n;
  }
  return 0;
}
