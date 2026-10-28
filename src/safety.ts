// Commands the agent never runs, in Auto or Manual mode: they could wreck the
// PC or delete things outside the project. Checked before run_command.
// Returns the reason a command is refused, or undefined when it's allowed.

import * as path from 'path';

const ALWAYS_REFUSED: { re: RegExp; why: string }[] = [
  { re: /\b(format|diskpart|mkfs(\.\w+)?|fdisk|bcdedit|cipher\s+\/w)\b/i, why: 'it can erase or repartition a disk' },
  { re: /\b(shutdown|restart-computer|stop-computer)\b/i, why: 'it shuts down or restarts the computer' },
  { re: /\breg(\.exe)?\s+(delete|add)\s+hk(lm|ey_local_machine)/i, why: 'it changes system-wide registry settings' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, why: 'it is a fork bomb' },
  { re: /\bdd\s+[^|]*\bof=\/dev\//i, why: 'it writes directly to a disk device' },
];

// Deleting commands, for checking where they point.
const DELETE = /\b(rm|rmdir|rd|del|erase|remove-item|ri)\b/i;

export function refusedCommand(command: string, root: string): string | undefined {
  for (const r of ALWAYS_REFUSED) if (r.re.test(command)) return `Refused: this command is never run by PerDev because ${r.why}.`;
  if (!DELETE.test(command)) return undefined;

  // Recursive deletes of a drive, the home folder or system folders.
  if (/(^|\s)(\/|~\/?|[a-z]:\\?|\$home|%userprofile%|c:\\windows\S*|\/c\/?)(\s|$|["'])/i.test(command) && /(-r|-rf|-fr|\/s|-recurse)\b/i.test(command)) {
    return 'Refused: this would delete a whole drive, your home folder or a system folder.';
  }
  // Deleting absolute paths outside the project.
  const absolute = command.match(/(?:[a-z]:[\\/][^\s"'|&;]*|\/[a-z]\/[^\s"'|&;]*|~[\\/][^\s"'|&;]*)/gi) ?? [];
  const rootNorm = normalize(root);
  for (const p of absolute) {
    const n = normalize(p.replace(/^\/([a-z])\//i, '$1:/'));
    if (!n.startsWith(rootNorm)) return `Refused: deleting ${p} is outside this project (${root}). PerDev only deletes inside the project.`;
  }
  // Climbing out of the project with ../ while deleting.
  if (/\.\.[\\/]/.test(command)) return 'Refused: deleting with ../ could reach outside this project.';
  return undefined;
}

function normalize(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() + '/';
}
