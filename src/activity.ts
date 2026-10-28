// Plain-English descriptions of what the agent is doing, for the chat's live
// activity line. Works on partial JSON arguments while a call is still streaming.

// Reads one string field from JSON that may be incomplete ('{"path": "src/ap').
export function partialField(json: string, field: string): string | undefined {
  const m = json.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
  if (!m) return undefined;
  return m[1].replace(/\\(["\\/])/g, '$1').replace(/\\n/g, ' ');
}

function short(s: string, max = 60): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

// "Writing src/app.ts", "Running npm test", "Tapping on the device"...
export function describeActivity(name: string, args: string): string {
  const f = (k: string) => partialField(args, k);
  switch (name) {
    case 'read_file':
      return f('path') ? `Reading ${short(f('path')!)}` : 'Reading a file';
    case 'write_file':
      return f('path') ? `Writing ${short(f('path')!)}` : 'Writing a file';
    case 'edit_file':
      return f('path') ? `Editing ${short(f('path')!)}` : 'Editing a file';
    case 'list_files':
      return 'Looking through the project files';
    case 'update_plan':
      return 'Updating the plan';
    case 'start_server':
      return f('command') ? `Starting ${short(f('command')!)}` : 'Starting the dev server';
    case 'open_in_browser':
      return f('url') ? `Opening ${short(f('url')!)} in the browser` : 'Opening the page in the browser';
    case 'search':
      return f('regex') ? `Searching the code for “${short(f('regex')!, 40)}”` : 'Searching the code';
    case 'run_command':
      return f('command') ? `Running ${short(f('command')!)}` : 'Preparing a command';
    case 'lookup_docs': {
      const q = f('query') ?? f('page');
      const d = f('docs');
      return q ? `Looking up “${short(q, 40)}”${d ? ` in the ${d} docs` : ''}` : 'Checking the documentation';
    }
    // Android (DroidLoop)
    case 'list_devices':
      return 'Checking connected devices';
    case 'start_emulator':
      return 'Starting the emulator';
    case 'build':
      return 'Building the app';
    case 'install':
      return 'Installing the app on the device';
    case 'launch':
      return f('packageName') ? `Launching ${short(f('packageName')!)}` : 'Launching the app';
    case 'ui_tree':
      return 'Reading the device screen';
    case 'screenshot':
      return 'Taking a screenshot';
    case 'tap':
      return f('text') ? `Tapping “${short(f('text')!, 30)}”` : 'Tapping on the device';
    case 'type_text':
      return f('text') ? `Typing “${short(f('text')!, 30)}”` : 'Typing on the device';
    case 'press_key':
      return f('key') ? `Pressing ${f('key')}` : 'Pressing a key';
    case 'scroll':
    case 'swipe':
      return 'Scrolling on the device';
    case 'wait_for':
      return 'Waiting for the screen to update';
    case 'logcat':
      return 'Checking the app logs for crashes';
    case 'app_state':
      return 'Checking the app state';
    default:
      return `Using ${name.replace(/_/g, ' ')}`;
  }
}
