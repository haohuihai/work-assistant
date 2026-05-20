import * as vscode from 'vscode'

declare function setTimeout(handler: (...args: any[]) => void, timeout: number): unknown

type SampleTreeNode = {
  id: string
  label: string
  description?: string
  children?: SampleTreeNode[]
}

const TEST_CUSTOM_EDITOR_VIEW_TYPE = 'swaggerHelper.apiTestCustomEditor'
const TEST_PANEL_VIEW_TYPE = 'swaggerHelper.apiTestPanel'
const TEST_WEBVIEW_VIEW_ID = 'swaggerHelper.apiTestPage'

class SimpleTreeProvider implements vscode.TreeDataProvider<SampleTreeNode> {
  private readonly emitter = new vscode.EventEmitter<SampleTreeNode | undefined | void>()
  readonly onDidChangeTreeData = this.emitter.event

  constructor(private readonly rootItems: SampleTreeNode[]) { }

  refresh() {
    this.emitter.fire()
  }

  getTreeItem(element: SampleTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.children?.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    )
    item.id = element.id
    item.description = element.description
    item.iconPath = new vscode.ThemeIcon(element.children?.length ? 'list-tree' : 'symbol-event')
    return item
  }

  getChildren(element?: SampleTreeNode): SampleTreeNode[] {
    return element?.children ?? this.rootItems
  }
}

class ApiTestFileDecorationProvider implements vscode.FileDecorationProvider {
  readonly onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>().event

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.fsPath.endsWith('.apitest')) {
      return {
        badge: 'T',
        tooltip: 'API 测试文件'
      }
    }
    return undefined
  }
}

class ApiTestTerminalLinkProvider implements vscode.TerminalLinkProvider<vscode.TerminalLink> {
  provideTerminalLinks(context: vscode.TerminalLinkContext): vscode.ProviderResult<vscode.TerminalLink[]> {
    const links: vscode.TerminalLink[] = []
    const regex = /(https?:\/\/[^\s]+)/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(context.line)) !== null) {
      links.push(new vscode.TerminalLink(match.index, match[1].length, match[1]))
    }
    return links
  }

  handleTerminalLink(link: vscode.TerminalLink): vscode.ProviderResult<void> {
    const target = link.tooltip || '链接'
    vscode.window.showInformationMessage(`点击了终端链接：${target}`)
  }
}

class ApiTestTerminalProfileProvider implements vscode.TerminalProfileProvider {
  provideTerminalProfile(): vscode.ProviderResult<vscode.TerminalProfile> {
    return new vscode.TerminalProfile({
      name: 'API Test Profile',
      shellPath: 'powershell.exe',
      shellArgs: ['-NoLogo']
    })
  }
}

class ApiTestUriHandler implements vscode.UriHandler {
  handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
    void vscode.window.showInformationMessage(`收到 URI：${uri.toString()}`)
  }
}

class ApiTestPanelSerializer implements vscode.WebviewPanelSerializer {
  async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: unknown): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true }
    webviewPanel.webview.html = getApiTestPanelHtml(state)
  }
}

class ApiTestCustomReadonlyEditorProvider implements vscode.CustomReadonlyEditorProvider {
  async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
    return {
      uri,
      dispose: () => { }
    }
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true }
    const bytes = await vscode.workspace.fs.readFile(document.uri)
    const text = bytesToString(bytes)
    webviewPanel.webview.html = `
      <html>
      <body style="font-family:Segoe UI,sans-serif;padding:16px;">
        <h2>Custom Editor Test</h2>
        <p>文件：${escapeHtml(document.uri.fsPath)}</p>
        <pre style="white-space:pre-wrap;background:#111827;color:#E5E7EB;padding:12px;border-radius:8px;">${escapeHtml(text)}</pre>
      </body>
      </html>
    `
  }
}

class ApiTestWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runner: ApiTestRunner
  ) { }

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    this.view = webviewView
    webviewView.webview.options = { enableScripts: true }
    webviewView.webview.html = getApiTestPageHtml(webviewView.webview, this.context.extensionUri)
    webviewView.webview.onDidReceiveMessage(async (message: { action?: string }) => {
      if (!message?.action) return
      await this.runner.run(message.action)
    })
  }

  async reveal() {
    await vscode.commands.executeCommand('workbench.view.extension.swaggerHelperApiTest')
    this.view?.show?.(true)
  }
}

class ApiTestRunner {
  private infoStatusDisposable?: vscode.Disposable
  private timeoutStatusDisposable?: vscode.Disposable
  private promiseStatusDisposable?: vscode.Disposable
  private leftStatusBar?: vscode.StatusBarItem
  private rightStatusBar?: vscode.StatusBarItem
  private createdInputBox?: vscode.InputBox
  private readonly output = vscode.window.createOutputChannel('API Test Output', 'typescript')
  private readonly logOutput = vscode.window.createOutputChannel('API Test Log', { log: true })
  private readonly quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>()
  private readonly treeProvider = new SimpleTreeProvider([
    {
      id: 'group-a',
      label: 'Alpha',
      description: '2 个节点',
      children: [
        { id: 'alpha-1', label: 'createTreeView 节点 1' },
        { id: 'alpha-2', label: 'createTreeView 节点 2' }
      ]
    }
  ])
  private readonly treeDataProvider = new SimpleTreeProvider([
    {
      id: 'group-b',
      label: 'Beta',
      description: 'registerTreeDataProvider',
      children: [
        { id: 'beta-1', label: 'registerTreeDataProvider 节点 1' },
        { id: 'beta-2', label: 'registerTreeDataProvider 节点 2' }
      ]
    }
  ])

  constructor(private readonly context: vscode.ExtensionContext) { }

  getDisposables() {
    return [this.output, this.logOutput]
  }

  getTreeProvider() {
    return this.treeProvider
  }

  getTreeDataProvider() {
    return this.treeDataProvider
  }

  async run(action: string) {
    const handlers: Record<string, () => Promise<void>> = {
      createInputBox: () => this.testCreateInputBox(),
      createOutputChannel: () => this.testCreateOutputChannel(),
      createLogOutputChannel: () => this.testCreateLogOutputChannel(),
      createQuickPick: () => this.testCreateQuickPick(),
      createStatusBarItemId: () => this.testCreateStatusBarWithId(),
      createStatusBarItem: () => this.testCreateStatusBar(),
      createTerminalName: () => this.testCreateTerminalWithName(),
      createTerminalOptions: () => this.testCreateTerminalWithOptions(),
      createTerminalExtension: () => this.testCreateExtensionTerminal(),
      createTextEditorDecorationType: () => this.testDecoration(),
      createTreeView: () => this.testCreateTreeView(),
      createWebviewPanel: () => this.testCreateWebviewPanel(),
      registerCustomEditorProvider: () => this.testCustomEditorProvider(),
      registerFileDecorationProvider: () => this.testFileDecoration(),
      registerTerminalLinkProvider: () => this.testTerminalLinkProvider(),
      registerTerminalProfileProvider: () => this.testTerminalProfileProvider(),
      registerTreeDataProvider: () => this.testRegisterTreeDataProvider(),
      registerUriHandler: () => this.testUriHandler(),
      registerWebviewPanelSerializer: () => this.testWebviewPanelSerializer(),
      registerWebviewViewProvider: () => this.testWebviewViewProvider(),
      setStatusBarMessageTimeout: () => this.testStatusBarMessageTimeout(),
      setStatusBarMessageThenable: () => this.testStatusBarMessageThenable(),
      setStatusBarMessage: () => this.testStatusBarMessage(),
      showErrorMessage: () => this.testErrorMessage(),
      showInformationMessage: () => this.testInformationMessage(),
      showInputBox: () => this.testShowInputBox(),
      showNotebookDocument: () => this.testShowNotebookDocument(),
      showOpenDialog: () => this.testShowOpenDialog(),
      showQuickPickString: () => this.testShowQuickPickString(),
      showQuickPickMany: () => this.testShowQuickPickMany(),
      showQuickPickObject: () => this.testShowQuickPickObject(),
      showSaveDialog: () => this.testShowSaveDialog(),
      showTextDocumentDocument: () => this.testShowTextDocumentDocument(),
      showTextDocumentUri: () => this.testShowTextDocumentUri(),
      showWarningMessage: () => this.testWarningMessage(),
      showWorkspaceFolderPick: () => this.testShowWorkspaceFolderPick(),
      withProgress: () => this.testWithProgress(),
      withScmProgress: () => this.testWithScmProgress()
    }

    const handler = handlers[action]
    if (!handler) {
      await vscode.window.showWarningMessage(`未实现的测试项：${action}`)
      return
    }
    try {
      await handler()
    } catch (error: any) {
      await vscode.window.showErrorMessage(`测试失败：${error?.message || String(error)}`)
    }
  }

  private async testCreateInputBox() {
    this.createdInputBox?.dispose()
    const input = vscode.window.createInputBox()
    this.createdInputBox = input
    input.title = 'createInputBox()'
    input.prompt = '输入任意文本并回车'
    input.placeholder = '例如 hello world'
    input.value = 'simple case'
    input.onDidAccept(() => {
      void vscode.window.showInformationMessage(`createInputBox 返回：${input.value}`)
      input.hide()
    })
    input.onDidHide(() => input.dispose())
    input.show()
  }

  private async testCreateOutputChannel() {
    this.output.clear()
    this.output.appendLine('createOutputChannel(name, languageId)')
    this.output.appendLine('const answer = 42')
    this.output.show(true)
  }

  private async testCreateLogOutputChannel() {
    this.logOutput.info('createOutputChannel(name, { log: true })')
    this.logOutput.warn('这是一条简单的 warn 日志')
    this.logOutput.show(true)
  }

  private async testCreateQuickPick() {
    this.quickPick.items = [
      { label: 'Alpha', description: '第一个选项' },
      { label: 'Beta', description: '第二个选项' }
    ]
    this.quickPick.title = 'createQuickPick<T>()'
    this.quickPick.placeholder = '请选择一个选项'
    this.quickPick.onDidAccept(() => {
      const selected = this.quickPick.selectedItems[0]?.label || '未选择'
      void vscode.window.showInformationMessage(`createQuickPick 选择了：${selected}`)
      this.quickPick.hide()
    })
    this.quickPick.show()
  }

  private async testCreateStatusBarWithId() {
    this.leftStatusBar?.dispose()
    this.leftStatusBar = vscode.window.createStatusBarItem('swaggerHelper.test.left', vscode.StatusBarAlignment.Left, 100)
    this.leftStatusBar.text = '$(beaker) API Test Left'
    this.leftStatusBar.tooltip = 'createStatusBarItem(id, alignment, priority)'
    this.leftStatusBar.show()
  }

  private async testCreateStatusBar() {
    this.rightStatusBar?.dispose()
    this.rightStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this.rightStatusBar.text = '$(rocket) API Test Right'
    this.rightStatusBar.tooltip = 'createStatusBarItem(alignment, priority)'
    this.rightStatusBar.show()
  }

  private async testCreateTerminalWithName() {
    const terminal = vscode.window.createTerminal('API Test Terminal', 'powershell.exe', ['-NoLogo'])
    terminal.show()
    terminal.sendText('Write-Output "createTerminal(name, shellPath, shellArgs)"')
  }

  private async testCreateTerminalWithOptions() {
    const terminal = vscode.window.createTerminal({
      name: 'API Test Options Terminal',
      shellPath: 'powershell.exe',
      shellArgs: ['-NoLogo']
    })
    terminal.show()
    terminal.sendText('Write-Output "createTerminal(options)"')
  }

  private async testCreateExtensionTerminal() {
    const writer = new vscode.EventEmitter<string>()
    const terminal = vscode.window.createTerminal({
      name: 'API Test Virtual Terminal',
      pty: {
        onDidWrite: writer.event,
        open: () => {
          writer.fire('createTerminal(options: ExtensionTerminalOptions)\r\n')
        },
        close: () => {
          writer.dispose()
        }
      }
    })
    terminal.show()
  }

  private async testDecoration() {
    const doc = await vscode.workspace.openTextDocument({
      language: 'typescript',
      content: 'const demo = "createTextEditorDecorationType";\nconsole.log(demo);\n'
    })
    const editor = await vscode.window.showTextDocument(doc, { preview: false })
    const decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
      borderRadius: '4px'
    })
    editor.setDecorations(decoration, [new vscode.Range(0, 0, 0, doc.lineAt(0).text.length)])
    this.context.subscriptions.push(decoration)
  }

  private async testCreateTreeView() {
    this.treeProvider.refresh()
    await vscode.commands.executeCommand('workbench.view.extension.swaggerHelperApiTest')
    await vscode.commands.executeCommand('swaggerHelper.apiTestTreeView.focus')
  }

  private async testCreateWebviewPanel() {
    const panel = vscode.window.createWebviewPanel(
      TEST_PANEL_VIEW_TYPE,
      'API 测试 Panel',
      { preserveFocus: false, viewColumn: vscode.ViewColumn.Beside },
      { enableScripts: true, retainContextWhenHidden: true }
    )
    panel.webview.html = getApiTestPanelHtml({ from: 'createWebviewPanel' })
  }

  private async testCustomEditorProvider() {
    const uri = await this.ensureApiTestFile()
    await vscode.commands.executeCommand('vscode.openWith', uri, TEST_CUSTOM_EDITOR_VIEW_TYPE)
  }

  private async testFileDecoration() {
    const uri = await this.ensureApiTestFile()
    await vscode.commands.executeCommand('revealInExplorer', uri)
    await vscode.window.showInformationMessage('请在资源管理器中查看 .apitest 文件上的 T 徽标')
  }

  private async testTerminalLinkProvider() {
    const terminal = vscode.window.createTerminal('API Test Link Terminal')
    terminal.show()
    terminal.sendText('Write-Output "访问链接 https://code.visualstudio.com/"')
  }

  private async testTerminalProfileProvider() {
    await vscode.commands.executeCommand('workbench.action.terminal.newWithProfile', {
      profileName: 'API Test Profile'
    })
  }

  private async testRegisterTreeDataProvider() {
    this.treeDataProvider.refresh()
    await vscode.commands.executeCommand('workbench.view.extension.swaggerHelperApiTest')
    await vscode.commands.executeCommand('swaggerHelper.apiTestDataView.focus')
  }

  private async testUriHandler() {
    const uri = vscode.Uri.parse('vscode://local/swagger-helper-pro?from=api-test')
    await vscode.env.openExternal(uri)
  }

  private async testWebviewPanelSerializer() {
    const panel = vscode.window.createWebviewPanel(
      TEST_PANEL_VIEW_TYPE,
      'Serializer Test Panel',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    )
    panel.webview.html = getApiTestPanelHtml({ from: 'registerWebviewPanelSerializer' })
    await vscode.window.showInformationMessage('已注册 serializer；重启并恢复窗口时可看到恢复效果')
  }

  private async testWebviewViewProvider() {
    await vscode.window.showInformationMessage('当前测试页本身就是 registerWebviewViewProvider 的示例')
  }

  private async testStatusBarMessageTimeout() {
    this.timeoutStatusDisposable?.dispose()
    this.timeoutStatusDisposable = vscode.window.setStatusBarMessage('2 秒后自动消失', 2000)
  }

  private async testStatusBarMessageThenable() {
    this.promiseStatusDisposable?.dispose()
    this.promiseStatusDisposable = vscode.window.setStatusBarMessage(
      '等待 1.5 秒后消失',
      wait(1500)
    )
  }

  private async testStatusBarMessage() {
    this.infoStatusDisposable?.dispose()
    this.infoStatusDisposable = vscode.window.setStatusBarMessage('常驻状态栏消息，直到再次点击其它状态栏测试')
  }

  private async testErrorMessage() {
    const selected = await vscode.window.showErrorMessage('这是一个错误提示', '重试', '忽略')
    if (selected) {
      await vscode.window.showInformationMessage(`你选择了：${selected}`)
    }
  }

  private async testInformationMessage() {
    const selected = await vscode.window.showInformationMessage('这是一个信息提示', '知道了', '稍后')
    if (selected) {
      await vscode.window.showInformationMessage(`你选择了：${selected}`)
    }
  }

  private async testShowInputBox() {
    const value = await vscode.window.showInputBox({
      prompt: 'showInputBox() 简单用例',
      value: 'hello'
    })
    if (value !== undefined) {
      await vscode.window.showInformationMessage(`showInputBox 返回：${value}`)
    }
  }

  private async testShowNotebookDocument() {
    const notebook = await vscode.workspace.openNotebookDocument('jupyter-notebook', new vscode.NotebookData([
      new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, '# API Test Notebook', 'markdown'),
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'print("showNotebookDocument")', 'python')
    ]))
    await vscode.window.showNotebookDocument(notebook)
  }

  private async testShowOpenDialog() {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      openLabel: '选择一个文件'
    })
    if (result?.length) {
      await vscode.window.showInformationMessage(`你选择了：${result[0].fsPath}`)
    }
  }

  private async testShowQuickPickString() {
    const result = await vscode.window.showQuickPick(['GET /users', 'POST /login'], {
      placeHolder: 'showQuickPick(string[])'
    })
    if (result) {
      await vscode.window.showInformationMessage(`选择结果：${result}`)
    }
  }

  private async testShowQuickPickMany() {
    const result = await vscode.window.showQuickPick(['TagA', 'TagB', 'TagC'], {
      placeHolder: 'showQuickPick 多选',
      canPickMany: true
    })
    if (result?.length) {
      await vscode.window.showInformationMessage(`已选择：${result.join(', ')}`)
    }
  }

  private async testShowQuickPickObject() {
    const result = await vscode.window.showQuickPick([
      { label: 'Alpha', description: '对象示例 A' },
      { label: 'Beta', description: '对象示例 B' }
    ], {
      placeHolder: 'showQuickPick<T>()'
    })
    if (result) {
      await vscode.window.showInformationMessage(`选择结果：${result.label}`)
    }
  }

  private async testShowSaveDialog() {
    const result = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(this.context.globalStorageUri, 'demo-output.json'),
      saveLabel: '保存示例文件'
    })
    if (result) {
      await vscode.window.showInformationMessage(`保存路径：${result.fsPath}`)
    }
  }

  private async testShowTextDocumentDocument() {
    const doc = await vscode.workspace.openTextDocument({
      language: 'json',
      content: '{\n  "message": "showTextDocument(document)"\n}'
    })
    await vscode.window.showTextDocument(doc, { preview: false })
  }

  private async testShowTextDocumentUri() {
    const uri = await this.ensureApiTestFile()
    await vscode.window.showTextDocument(uri, { preview: false })
  }

  private async testWarningMessage() {
    const selected = await vscode.window.showWarningMessage('这是一个警告提示', '继续', '取消')
    if (selected) {
      await vscode.window.showInformationMessage(`你选择了：${selected}`)
    }
  }

  private async testShowWorkspaceFolderPick() {
    const folder = await vscode.window.showWorkspaceFolderPick({
      placeHolder: '选择一个工作区目录'
    })
    if (folder) {
      await vscode.window.showInformationMessage(`选择了工作区：${folder.name}`)
    }
  }

  private async testWithProgress() {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'withProgress 简单用例',
        cancellable: false
      },
      async progress => {
        progress.report({ increment: 30, message: '准备中' })
        await wait(300)
        progress.report({ increment: 70, message: '完成' })
        await wait(300)
      }
    )
  }

  private async testWithScmProgress() {
    await vscode.window.withScmProgress(async progress => {
      progress.report(50)
      await wait(250)
      progress.report(100)
    })
    await vscode.window.showInformationMessage('withScmProgress 已执行')
  }

  private async ensureApiTestFile() {
    const fileUri = vscode.Uri.joinPath(this.context.globalStorageUri, 'sample.apitest')
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri)
    await vscode.workspace.fs.writeFile(
      fileUri,
      stringToBytes('name: sample.apitest\npurpose: custom editor and file decoration demo\n')
    )
    return fileUri
  }
}

export function registerApiTestPage(context: vscode.ExtensionContext) {
  const apiTestRunner = new ApiTestRunner(context)
  const apiTestViewProvider = new ApiTestWebviewProvider(context, apiTestRunner)
  const apiTestTreeView = vscode.window.createTreeView('swaggerHelper.apiTestTreeView', {
    treeDataProvider: apiTestRunner.getTreeProvider()
  })

  context.subscriptions.push(
    apiTestTreeView,
    ...apiTestRunner.getDisposables(),
    vscode.window.registerWebviewViewProvider(TEST_WEBVIEW_VIEW_ID, apiTestViewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.window.registerTreeDataProvider('swaggerHelper.apiTestDataView', apiTestRunner.getTreeDataProvider()),
    vscode.window.registerFileDecorationProvider(new ApiTestFileDecorationProvider()),
    vscode.window.registerTerminalLinkProvider(new ApiTestTerminalLinkProvider()),
    vscode.window.registerTerminalProfileProvider('swaggerHelper.apiTestProfile', new ApiTestTerminalProfileProvider()),
    vscode.window.registerUriHandler(new ApiTestUriHandler()),
    vscode.window.registerWebviewPanelSerializer(TEST_PANEL_VIEW_TYPE, new ApiTestPanelSerializer()),
    vscode.window.registerCustomEditorProvider(TEST_CUSTOM_EDITOR_VIEW_TYPE, new ApiTestCustomReadonlyEditorProvider()),
    vscode.commands.registerCommand('swaggerHelper.openApiTestPage', async () => {
      await apiTestViewProvider.reveal()
    })
  )
}

function escapeHtml(raw: string) {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function wait(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

function bytesToString(bytes: Uint8Array) {
  return Array.from(bytes).map(item => String.fromCharCode(item)).join('')
}

function stringToBytes(value: string) {
  return Uint8Array.from(Array.from(value).map(char => char.charCodeAt(0)))
}

function getApiTestPanelHtml(state?: unknown) {
  return `
    <html>
    <body style="font-family:Segoe UI,sans-serif;padding:16px;background:#111827;color:#E5E7EB;">
      <h2 style="margin-top:0;">Webview Panel Test</h2>
      <p>这个面板用于测试 <code>createWebviewPanel</code> 和 <code>registerWebviewPanelSerializer</code>。</p>
      <pre style="white-space:pre-wrap;background:#0F172A;padding:12px;border-radius:8px;">${escapeHtml(JSON.stringify(state ?? { tip: 'no state' }, null, 2))}</pre>
    </body>
    </html>
  `
}

function getApiTestPageHtml(_webview: vscode.Webview, _extensionUri: vscode.Uri) {
  const groups: Array<{ title: string; items: Array<{ action: string; label: string; desc: string }> }> = [
    {
      title: '创建类 API',
      items: [
        { action: 'createInputBox', label: 'createInputBox()', desc: '创建 InputBox 并显示默认值' },
        { action: 'createOutputChannel', label: 'createOutputChannel(name, languageId?)', desc: '打开普通输出面板' },
        { action: 'createLogOutputChannel', label: 'createOutputChannel(name, { log: true })', desc: '打开日志输出面板' },
        { action: 'createQuickPick', label: 'createQuickPick<T>()', desc: '创建可复用 QuickPick' },
        { action: 'createStatusBarItemId', label: 'createStatusBarItem(id, ...)', desc: '左侧状态栏示例' },
        { action: 'createStatusBarItem', label: 'createStatusBarItem(alignment, ...)', desc: '右侧状态栏示例' },
        { action: 'createTerminalName', label: 'createTerminal(name?, shellPath?, shellArgs?)', desc: '创建普通终端' },
        { action: 'createTerminalOptions', label: 'createTerminal(options: TerminalOptions)', desc: '使用 options 创建终端' },
        { action: 'createTerminalExtension', label: 'createTerminal(options: ExtensionTerminalOptions)', desc: '创建虚拟终端' },
        { action: 'createTextEditorDecorationType', label: 'createTextEditorDecorationType(...)', desc: '高亮临时文本' },
        { action: 'createTreeView', label: 'createTreeView<T>(...)', desc: '聚焦 createTreeView 示例树' },
        { action: 'createWebviewPanel', label: 'createWebviewPanel(...)', desc: '打开测试 panel' }
      ]
    },
    {
      title: '注册类 API',
      items: [
        { action: 'registerCustomEditorProvider', label: 'registerCustomEditorProvider(...)', desc: '打开 .apitest 自定义编辑器' },
        { action: 'registerFileDecorationProvider', label: 'registerFileDecorationProvider(...)', desc: '给 .apitest 文件加徽标' },
        { action: 'registerTerminalLinkProvider', label: 'registerTerminalLinkProvider(...)', desc: '终端输出可点击链接' },
        { action: 'registerTerminalProfileProvider', label: 'registerTerminalProfileProvider(...)', desc: '新建指定 profile 终端' },
        { action: 'registerTreeDataProvider', label: 'registerTreeDataProvider<T>(...)', desc: '聚焦 registerTreeDataProvider 示例树' },
        { action: 'registerUriHandler', label: 'registerUriHandler(...)', desc: '触发 vscode:// URI' },
        { action: 'registerWebviewPanelSerializer', label: 'registerWebviewPanelSerializer(...)', desc: '注册 panel 序列化示例' },
        { action: 'registerWebviewViewProvider', label: 'registerWebviewViewProvider(...)', desc: '当前测试页自身示例' }
      ]
    },
    {
      title: '消息与窗口 API',
      items: [
        { action: 'setStatusBarMessageTimeout', label: 'setStatusBarMessage(text, timeout)', desc: '2 秒后自动消失' },
        { action: 'setStatusBarMessageThenable', label: 'setStatusBarMessage(text, thenable)', desc: '等待 Promise 完成后消失' },
        { action: 'setStatusBarMessage', label: 'setStatusBarMessage(text)', desc: '显示常驻消息' },
        { action: 'showErrorMessage', label: 'showErrorMessage(...)', desc: '错误提示 + 选择项' },
        { action: 'showInformationMessage', label: 'showInformationMessage(...)', desc: '信息提示 + 选择项' },
        { action: 'showInputBox', label: 'showInputBox(...)', desc: '直接弹出输入框' },
        { action: 'showNotebookDocument', label: 'showNotebookDocument(...)', desc: '打开一个临时 notebook' },
        { action: 'showOpenDialog', label: 'showOpenDialog(...)', desc: '选择文件' },
        { action: 'showQuickPickString', label: 'showQuickPick(strings)', desc: '字符串单选' },
        { action: 'showQuickPickMany', label: 'showQuickPick(strings, canPickMany)', desc: '字符串多选' },
        { action: 'showQuickPickObject', label: 'showQuickPick<T>(items)', desc: '对象单选' },
        { action: 'showSaveDialog', label: 'showSaveDialog(...)', desc: '选择保存位置' },
        { action: 'showTextDocumentDocument', label: 'showTextDocument(document, ...)', desc: '打开临时文档' },
        { action: 'showTextDocumentUri', label: 'showTextDocument(uri, ...)', desc: '打开示例文件' },
        { action: 'showWarningMessage', label: 'showWarningMessage(...)', desc: '警告提示 + 选择项' },
        { action: 'showWorkspaceFolderPick', label: 'showWorkspaceFolderPick(...)', desc: '选择工作区目录' },
        { action: 'withProgress', label: 'withProgress(...)', desc: '通知进度条' },
        { action: 'withScmProgress', label: 'withScmProgress(...)', desc: 'SCM 进度示例' }
      ]
    }
  ]

  const sections = groups.map(group => `
    <section style="margin-bottom:20px;">
      <h3 style="margin:0 0 10px 0;">${group.title}</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:10px;">
        ${group.items.map(item => `
          <button data-action="${item.action}" style="text-align:left;border:1px solid #374151;background:#1F2937;color:#E5E7EB;border-radius:10px;padding:12px;cursor:pointer;">
            <div style="font-weight:600;margin-bottom:6px;">${item.label}</div>
            <div style="color:#9CA3AF;font-size:12px;">${item.desc}</div>
          </button>
        `).join('')}
      </div>
    </section>
  `).join('')

  return `
    <html>
    <body style="font-family:Segoe UI,sans-serif;margin:0;padding:16px;background:#111827;color:#E5E7EB;">
      <h2 style="margin:0 0 8px 0;">VS Code Window API 测试页</h2>
      <p style="margin:0 0 16px 0;color:#9CA3AF;">每个按钮都对应一个最简单可见的示例，用来快速验证行为。</p>
      ${sections}
      <script>
        const vscode = acquireVsCodeApi();
        document.querySelectorAll('button[data-action]').forEach(button => {
          button.addEventListener('click', () => {
            vscode.postMessage({ action: button.dataset.action });
          });
        });
      </script>
    </body>
    </html>
  `
}
