// Stops the agent from repeating the exact same tool call. Small local models
// sometimes re-run a command or re-read a file over and over when a result
// confuses them (no output, an unfamiliar error).

export type GuardDecision =
  | { action: 'run' }
  | { action: 'block'; message: string }
  | { action: 'stop'; message: string };

export class LoopGuard {
  private seen = new Map<string, { count: number; result: string }>();

  // maxRepeats: identical calls answered from the earlier result before the run stops.
  constructor(private readonly maxRepeats = 3) {}

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
    // Hand back the full earlier result: the model may genuinely need it again
    // (e.g. to copy old_str exactly after a failed edit), just not to rerun it.
    return {
      action: 'block',
      message:
        `${prev.result}\n\n[Same result as your earlier identical ${name} call: nothing has changed since, so it was not run again. ` +
        'Use this result for your next step; do not repeat the call.]',
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
