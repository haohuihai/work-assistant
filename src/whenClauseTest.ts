import * as vscode from 'vscode'

let customContextEnabled = false

/** when 子句测试命令：每个命令对应文档中的一种条件写法 */
export function registerWhenClauseTest(context: vscode.ExtensionContext) {
  vscode.commands.executeCommand('setContext', 'ext.supportedFolders', ['test', 'foo', 'bar'])
  vscode.commands.executeCommand('setContext', 'ext.whenTest.enabled', false)

  const tests: Array<{ command: string; label: string; clause: string }> = [
    { command: 'whenTest.logicalAnd', label: '逻辑与 (&&)', clause: 'textInputFocus && !editorReadonly' },
    { command: 'whenTest.logicalOr', label: '逻辑或 (||)', clause: 'isLinux || isWindows || isMac' },
    { command: 'whenTest.equalityLang', label: '相等 (==)', clause: "editorLangId == typescript" },
    { command: 'whenTest.inequalityExt', label: '不等 (!=)', clause: "resourceExtname != .js" },
    { command: 'whenTest.comparison', label: '比较 (>=)', clause: 'workspaceFolderCount >= 1' },
    { command: 'whenTest.matchRegex', label: '正则 (=~)', clause: 'resourceFilename =~ /test/i' },
    { command: 'whenTest.inOperator', label: 'in 运算符', clause: 'resourceFilename in ext.supportedFolders' },
    { command: 'whenTest.notInOperator', label: 'not in 运算符', clause: 'resourceFilename not in ext.supportedFolders' },
    { command: 'whenTest.customContext', label: '自定义 context', clause: 'ext.whenTest.enabled' },
    { command: 'whenTest.configSetting', label: '配置项 (config.)', clause: 'config.editor.minimap.enabled' },
    { command: 'whenTest.viewContext', label: '视图 context', clause: 'view == swaggerHelper.workView' },
    { command: 'whenTest.viewItem', label: 'viewItem', clause: 'view == swaggerHelper.workView && viewItem == project' },
    { command: 'ext.doSpecial', label: '文档示例 (in)', clause: 'explorerResourceIsFolder && resourceFilename in ext.supportedFolders' },
  ]

  for (const { command, label, clause } of tests) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        vscode.window.showInformationMessage(`✓ when 匹配成功\n${label}\n${clause}`)
      }),
    )
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('whenTest.toggleEnabled', async () => {
      customContextEnabled = !customContextEnabled
      await vscode.commands.executeCommand('setContext', 'ext.whenTest.enabled', customContextEnabled)
      vscode.window.showInformationMessage(
        `ext.whenTest.enabled = ${customContextEnabled}\n编辑器右键「自定义 context」应${customContextEnabled ? '出现' : '消失'}`,
      )
    }),
  )
}
