// Stops the agent from repeating the exact same tool call. Small local models
// sometimes re-run a command or re-read a file over and over when a result
// confuses them (no output, an unfamiliar error).

export type GuardDecision =
  | { action: 'run' }
  | { action: 'block'; message: string }
  | { action: 'stop'; message: string };

export class LoopGuard {
  private seen = new Map<string, { count: number; result: string }>();

  constructor(private readonly maxRepeats = 2) {}

  static key(name: string, rawArgs: string): string {
    let args: unknown = rawArgs;
    try {
      args = sortKeys(JSON.parse(rawArgs || '{}'));
    } catch {
      // keep the raw text
    }
    return `${name} ${JSON.stringify(args)}`;
  }

  // Ask before running a call. Identical calls after the first are not run again.
  check(name: string, rawArgs: string): GuardDecision {
    const prev = this.seen.get(LoopGuard.key(name, rawArgs));
    if (!prev) return { action: 'run' };
    prev.count++;
    if (prev.count > this.maxRepeats) {
      return {
        action: 'stop',
        message: `PerDev stopped because the model kept repeating the same step (${describe(name, rawArgs)}). Try rephrasing the request or giving more detail.`,
      };
    }
    const shown = prev.result.length > 600 ? prev.result.slice(0, 600) + '\n...' : prev.result;
    return {
      action: 'block',
      message:
        `Not run again: you already made this exact ${name} call and nothing has changed since. Its result was:\n${shown}\n\n` +
        'Do not repeat it. Use that result: take a different step, or if the task is done, reply with a short summary.',
    };
  }

  record(name: string, rawArgs: string, result: string) {
    const k = LoopGuard.key(name, rawArgs);
    if (!this.seen.has(k)) this.seen.set(k, { count: 1, result });
  }

  // A change to the workspace can make an earlier read or command give a new result.
  forgetReads() {
    for (const k of [...this.seen.keys()]) {
      if (!k.startsWith('write_file ') && !k.startsWith('edit_file ')) this.seen.delete(k);
    }
  }
}

function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

function describe(name: string, rawArgs: string): string {
  try {
    const a = JSON.parse(rawArgs || '{}');
    const detail = a.command ?? a.path ?? a.regex ?? a.pattern;
    return detail ? `${name} ${String(detail).slice(0, 80)}` : name;
  } catch {
    return name;
  }
}
