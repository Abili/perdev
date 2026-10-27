import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { ChatViewProvider } from './chatView';
import { AutocompleteProvider } from './autocomplete';
import { TrainingLogger } from './logger';
import { LocalServers } from './server';
import { SessionStore } from './sessions';

export function activate(context: vscode.ExtensionContext) {
  const servers = new LocalServers();
  context.subscriptions.push(servers);
  servers.ensureRunning();

  const logger = new TrainingLogger(context);
  const chat = new ChatViewProvider(logger, new SessionStore(() => logger.dir));
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

  // First launch: open the agent panel so people see PerDev right away.
  if (!context.globalState.get<boolean>('perdev.panelShown')) {
    vscode.commands.executeCommand('workbench.view.extension.perdev');
    context.globalState.update('perdev.panelShown', true);
  }
}

export function deactivate() {}
