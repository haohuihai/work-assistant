import * as vscode from 'vscode'

export function registerRightClickMenu(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('swaggerHelper.publish', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('未找到工作区，无法执行发布命令')
        return
      }

      const terminal = vscode.window.createTerminal({
        name: 'Publish',
        cwd: workspaceFolder.uri.fsPath,
      })
      terminal.show()
      terminal.sendText('npm run publish')
    }),
  )
}
