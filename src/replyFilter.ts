// Decides what part of a streaming reply reaches the chat. When the user asked
// for work (not a question), code belongs in files, not in the chat: a code
// block ends the reply early so PerDev can have it written to the file instead
// (the local 7B otherwise spends minutes typing whole files into the chat, then
// writes them again). Tool calls written as text are hidden too; only a short
// "Writing X..." status shows.

export interface FilterUpdate {
  show: string; // new text for the chat
  cutForCode: boolean; // a code block started: stop generating
  toolCall?: { name: string; partialArgs: string }; // a tool call is being written as text
}

const MARKERS = ['```', '<tool_call>', '{"name"'];

export class ReplyFilter {
  full = '';
  private shown = 0;
  private hiddenFrom = -1;
  private cut = false;

  constructor(private readonly isQuestion: boolean) {}

  push(delta: string): FilterUpdate {
    this.full += delta;
    let toolCall: FilterUpdate['toolCall'];
    if (this.hiddenFrom < 0) {
      const fence = this.isQuestion ? -1 : this.full.indexOf('```');
      const tagged = this.full.indexOf('<tool_call>');
      const json = this.full.search(/\{\s*"name"\s*:/);
      const at = [fence, tagged, json].filter((i) => i >= 0).sort((a, b) => a - b)[0];
      if (at !== undefined) {
        this.hiddenFrom = at;
        if (at === fence) this.cut = true;
      }
    }
    if (this.hiddenFrom >= 0) {
      const m = this.full.slice(this.hiddenFrom).match(/"name"\s*:\s*"([A-Za-z0-9_]+)"\s*,\s*"arguments"\s*:\s*([\s\S]*)$/);
      if (m) toolCall = { name: m[1], partialArgs: m[2] };
    }
    // Hold back a trailing piece that might be the start of a marker ("``", "<tool", '{"na').
    const end = this.hiddenFrom >= 0 ? this.hiddenFrom : this.full.length - heldBack(this.full);
    const show = end > this.shown ? this.full.slice(this.shown, end) : '';
    this.shown = Math.max(this.shown, end);
    return { show, cutForCode: this.cut, toolCall };
  }

  // At the end: release held-back text that turned out not to be a marker.
  flush(): string {
    if (this.hiddenFrom >= 0 || this.shown >= this.full.length) return '';
    const rest = this.full.slice(this.shown);
    this.shown = this.full.length;
    return rest;
  }
}

function heldBack(text: string): number {
  for (let n = Math.min(10, text.length); n > 0; n--) {
    const tail = text.slice(-n);
    if (MARKERS.some((m) => m.startsWith(tail) || tail.startsWith('{') && '{"name"'.startsWith(tail.replace(/\s+/g, '')))) return n;
  }
  return 0;
}
