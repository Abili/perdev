import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { ChatViewProvider } from './chatView';
import { AutocompleteProvider } from './autocomplete';
import { TrainingLogger } from './logger';
import { LocalServers } from './server';
import { SessionStore } from './sessions';
import { McpManager } from './mcpManager';
import { DevicePicker } from './devicePicker';
import { stopBackground } from './tools';
import { resumePendingProject, StartPage } from './startPage';
import { resolveShell, ShellPreference } from './shell';

export function activate(context: vscode.ExtensionContext) {
  const servers = new LocalServers();
  context.subscriptions.push(servers);
  servers.ensureRunning();

  const logger = new TrainingLogger(context);
  const toolsLog = vscode.window.createOutputChannel('PerDev Tools');
  const mcp = new McpManager((line) => toolsLog.appendLine(line));
  context.subscriptions.push(toolsLog, { dispose: () => mcp.dispose() });
  const devices = new DevicePicker(context);
  context.subscriptions.push(devices);
  const chat = new ChatViewProvider(logger, new SessionStore(() => logger.dir), mcp, devices);
  const autocomplete = new AutocompleteProvider(logger);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, autocomplete),
    vscode.commands.registerCommand('perdev.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('perdev.stop', () => chat.stop()),
    vscode.commands.registerCommand('perdev.branchChat', () => chat.branch()),
    vscode.commands.registerCommand('perdev.history', () => chat.showHistory()),
    vscode.commands.registerCommand('perdev.completionAccepted', (id: string) => autocomplete.markAccepted(id)),
    vscode.commands.registerCommand('perdev.toggleAutocomplete', async () => {
      const c = vscode.workspace.getConfiguration('perdev');
      const next = !c.get<boolean>('autocomplete.enabled', true);
      await c.update('autocomplete.enabled', next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`PerDev autocomplete ${next ? 'on' : 'off'}`, 3000);
    }),
    vscode.commands.registerCommand('perdev.startServers', async () => {
      servers.showLog();
      await servers.ensureRunning();
    }),
    vscode.commands.registerCommand('perdev.openDataFolder', async () => {
      await fs.mkdir(logger.dir, { recursive: true });
      await vscode.env.openExternal(vscode.Uri.file(logger.dir));
    }),
  );

  const start = new StartPage(context);
  context.subscriptions.push(vscode.commands.registerCommand('perdev.newProject', () => start.show()));

  if (!vscode.workspace.workspaceFolders?.length) {
    // No project open: greet with "What are you building today?".
    if (vscode.workspace.getConfiguration('perdev').get<boolean>('startPage.show', true)) start.show();
  } else {
    // A project just created from the start page: run its setup and queue the first request.
    const shell = resolveShell(vscode.workspace.getConfiguration('perdev').get<ShellPreference>('agent.shell', 'auto'));
    void resumePendingProject(context, (text) => chat.prefill(text), shell.kind === 'bash' ? shell.path : undefined, shell.kind === 'bash' ? 'bash' : 'powershell');
    // Open the agent chat (right-hand sidebar) whenever a project opens, like other AI editors.
    if (vscode.workspace.getConfiguration('perdev').get<boolean>('chat.openOnStartup', true)) {
      void vscode.commands.executeCommand('workbench.view.extension.perdev');
    }
  }

  // A status bar button that opens the chat, for anyone who closes the sidebar.
  const chatButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  chatButton.text = '$(comment-discussion) PerDev Chat';
  chatButton.tooltip = 'Open the PerDev agent chat (Ctrl+L)';
  chatButton.command = 'perdev.openChat';
  chatButton.show();
  context.subscriptions.push(
    chatButton,
    vscode.commands.registerCommand('perdev.openChat', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.perdev');
      await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
      chat.focusInput();
    }),
  );
}

export function deactivate() {
  stopBackground();
}
