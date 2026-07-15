import * as vscode from 'vscode'
import type { ApiItem, ProjectItem } from './swaggerTypes'

const STORAGE_KEY = 'swaggerHelper.projects'

export type TreeNode = ProjectNode | ApiNode

export class SwaggerTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private eventEmitter = new vscode.EventEmitter<TreeNode | undefined | null | void>()
  readonly onDidChangeTreeData = this.eventEmitter.event
  private keyword = ''

  constructor(private readonly context: vscode.ExtensionContext) { }

  refresh() {
    this.eventEmitter.fire()
  }

  setKeyword(keyword: string) {
    this.keyword = keyword.trim().toLowerCase()
    this.refresh()
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    const projects = this.getProjects()
    if (!element) {
      return projects.map(p => new ProjectNode(p))
    }
    if (element.type === 'project') {
      const list = element.project.apis.filter(api => this.matchApi(api))
      return list.map(api => new ApiNode(element.project, api))
    }
    return []
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element
  }

  getProjects() {
    return this.context.globalState.get<ProjectItem[]>(STORAGE_KEY, [])
  }

  async saveProjects(projects: ProjectItem[]) {
    await this.context.globalState.update(STORAGE_KEY, projects)
    this.refresh()
  }

  private matchApi(api: ApiItem) {
    if (!this.keyword) return true
    const full = `${api.method.toLowerCase()} ${api.path.toLowerCase()}`
    return full.includes(this.keyword)
  }
}

export class ProjectNode extends vscode.TreeItem {
  readonly type = 'project' as const
  constructor(readonly project: ProjectItem) {
    super(project.title, vscode.TreeItemCollapsibleState.Collapsed)
    // 使用稳定 id，避免刷新时树的展开/收起状态被重置
    this.id = project.id
    this.contextValue = 'project'
    this.description = project.url
    this.tooltip = `${project.title}\n${project.url}`
    this.iconPath = new vscode.ThemeIcon('folder-library')
  }
}

export class ApiNode extends vscode.TreeItem {
  readonly type = 'api' as const
  constructor(readonly project: ProjectItem, readonly api: ApiItem) {
    super(`${api.method.toUpperCase()} ${api.path}`, vscode.TreeItemCollapsibleState.None)
    // 设置稳定 id，格式包含项目 id + 方法 + 路径
    this.id = `${project.id}::${api.method.toUpperCase()} ${api.path}`
    this.contextValue = 'api'
    this.tooltip = `${api.method.toUpperCase()} ${api.path}`
    this.command = {
      command: 'swaggerHelper.openApiDetail',
      title: '打开接口详情',
      arguments: [project, api]
    }
    const methodConfig: Record<
      string,
      { icon: string; color: vscode.ThemeColor }
    > = {
      get: {
        icon: 'arrow-circle-down',
        color: new vscode.ThemeColor('charts.blue'),
      },

      post: {
        icon: 'arrow-circle-up',
        color: new vscode.ThemeColor('charts.green'),
      },

      put: {
        icon: 'sync',
        color: new vscode.ThemeColor('charts.yellow'),
      },

      delete: {
        icon: 'trash',
        color: new vscode.ThemeColor('charts.red'),
      },

      patch: {
        icon: 'diff-modified',
        color: new vscode.ThemeColor('charts.orange'),
      },
    }

    const config = methodConfig[api.method?.toLowerCase()]

    this.iconPath = new vscode.ThemeIcon(
      config?.icon || 'circle-large-outline',
      config?.color
    )
  }
}
