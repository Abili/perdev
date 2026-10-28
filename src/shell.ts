// Which shell run_command uses. Models know bash best (most training data is
// Linux), and Windows' default cmd.exe has no ls, cat, grep, etc., which made
// the local model retry failing commands. So on Windows prefer Git Bash,
// then PowerShell.

import * as fs from 'fs';
import * as path from 'path';

export type ShellPreference = 'auto' | 'bash' | 'powershell' | 'cmd';

export interface Shell {
  kind: 'bash' | 'powershell' | 'cmd' | 'sh';
  path: string;
  // How the model is told about it in the system prompt.
  label: string;
}

export function resolveShell(pref: ShellPreference = 'auto', platform = process.platform, env = process.env): Shell {
  if (platform !== 'win32') {
    return fs.existsSync('/bin/bash') ? { kind: 'bash', path: '/bin/bash', label: 'bash' } : { kind: 'sh', path: '/bin/sh', label: 'sh' };
  }
  if (pref === 'auto' || pref === 'bash') {
    const bash = findGitBash(env);
    if (bash) return { kind: 'bash', path: bash, label: 'bash (Git Bash on Windows; Unix commands like ls, cat, grep work)' };
  }
  if (pref === 'cmd') return { kind: 'cmd', path: env.ComSpec || 'cmd.exe', label: 'cmd.exe (Windows Command Prompt)' };
  return { kind: 'powershell', path: 'powershell.exe', label: 'Windows PowerShell 5.1 (use ; between commands, not &&)' };
}

// Git for Windows' bash. Deliberately not C:\Windows\System32\bash.exe (WSL).
function findGitBash(env: NodeJS.ProcessEnv): string | undefined {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')];
  for (const root of roots) {
    if (!root) continue;
    const p = path.join(root, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
