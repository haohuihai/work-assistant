import * as vscode from 'vscode'
import { openApiDetail } from './apiDetail'
import { showPipelineList } from './pipeLine'
import {
  buildProjectByUrl,
  buildRequestJson,
  buildResponseJson,
  findApis,
  loadSwaggerDoc
} from './swaggerDoc'
import { ProjectNode, SwaggerTreeProvider } from './swaggerTree'
import type { ApiItem, ProjectItem } from './swaggerTypes'
import { normalizeUrl } from './utils'

export function activateSwaggerHelper(context: vscode.ExtensionContext) {
  const provider = new SwaggerTreeProvider(context)
  const workView = vscode.window.createTreeView('swaggerHelper.workView', { treeDataProvider: provider })

  context.subscriptions.push(
    workView,
    vscode.commands.registerCommand('swaggerHelper.openUI', async () => {
      await addProject(provider)
    }),
    vscode.commands.registerCommand('swaggerHelper.addProject', async () => {
      await addProject(provider)
    }),
    vscode.commands.registerCommand('swaggerHelper.searchRequests', async () => {
      const keyword = await vscode.window.showInputBox({
        prompt: '输入 URL 关键字（支持方法+路径模糊搜索）',
        placeHolder: '/user/login 或 post /user'
      })
      if (keyword === undefined) return
      provider.setKeyword(keyword)
      if (keyword.trim()) {
        vscode.window.showInformationMessage(`已启用搜索：${keyword}`)
      } else {
        vscode.window.showInformationMessage('已清空搜索')
      }
    }),
    vscode.commands.registerCommand('swaggerHelper.clearSearch', () => {
      provider.setKeyword('')
      vscode.window.showInformationMessage('已清空搜索')
    }),
    vscode.commands.registerCommand('swaggerHelper.renameProject', async (node?: ProjectNode) => {
      if (!node) return
      const nextTitle = await vscode.window.showInputBox({
        prompt: '修改项目标题',
        value: node.project.title
      })
      if (!nextTitle?.trim()) return
      const projects = provider.getProjects().map(p => p.id === node.project.id ? { ...p, title: nextTitle.trim() } : p)
      await provider.saveProjects(projects)
    }),
    vscode.commands.registerCommand('swaggerHelper.refreshProject', async (node?: ProjectNode) => {
      if (!node) return
      await refreshProject(provider, node.project.id)
    }),
    vscode.commands.registerCommand('swaggerHelper.openApiDetail', async (project: ProjectItem, api: ApiItem) => {
      openApiDetail(project, api)
    }),
    vscode.commands.registerCommand('swaggerHelper.showPipelineList', async () => {
      try {
        await showPipelineList()
      } catch (error: unknown) {
        const text = error instanceof Error ? error.message : String(error)
        vscode.window.showErrorMessage(`查看流水线失败：${text}`)
      }
    }),
    vscode.commands.registerCommand('swaggerHelper.lookupRoute', async () => {
      const url = await vscode.window.showInputBox({
        prompt: 'Swagger 地址（支持 index.html / swagger-ui.html / api-docs.json）',
        placeHolder: 'http://host:port/index.html'
      })
      if (!url) return
      const routeInput = await vscode.window.showInputBox({
        prompt: '后端路由（支持关键字）',
        placeHolder: '/api/user/login'
      })
      if (!routeInput) return
      try {
        const swagger = await loadSwaggerDoc(url)
        const matches = findApis(swagger, routeInput)
        if (matches.length === 0) {
          vscode.window.showWarningMessage(`未找到匹配路由：${routeInput}`)
          return
        }
        const api = matches.length === 1 ? matches[0] : await pickApi(matches)
        if (!api) return
        const detailApi: ApiItem = {
          path: api.path,
          method: api.method,
          reqJson: buildRequestJson(swagger, api.path, api.method),
          resJson: buildResponseJson(swagger, api.path, api.method)
        }
        openApiDetail({ id: 'temp', title: url, url, apis: [], updatedAt: Date.now() }, detailApi)
      } catch (error: any) {
        vscode.window.showErrorMessage(`Swagger 解析失败：${error?.message || String(error)}`)
      }
    })
  )
}

async function addProject(provider: SwaggerTreeProvider) {
  const url = await vscode.window.showInputBox({
    prompt: '请输入 Swagger 地址',
    placeHolder: 'http://host:port/v3/api-docs'
  })
  if (!url?.trim()) return
  const normalized = normalizeUrl(url)
  try {
    const project = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '加载 Swagger 项目',
        cancellable: false
      },
      async progress => {
        progress.report({ message: `正在加载 ${normalized}` })
        return await buildProjectByUrl(normalized)
      }
    )
    const projects = provider.getProjects()
    const existed = projects.findIndex(p => p.url === normalized)
    if (existed >= 0) {
      projects[existed] = { ...projects[existed], ...project, id: projects[existed].id }
    } else {
      projects.push(project)
    }
    await provider.saveProjects(projects)
    vscode.window.showInformationMessage(`已保存项目：${project.title}`)
  } catch (error: any) {
    vscode.window.showErrorMessage(`拉取失败：${error?.message || String(error)}`)
  }
}

async function refreshProject(provider: SwaggerTreeProvider, projectId: string) {
  const projects = provider.getProjects()
  const target = projects.find(p => p.id === projectId)
  if (!target) return
  try {
    const refreshed = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '更新 Swagger 项目',
        cancellable: false
      },
      async progress => {
        progress.report({ message: `正在刷新 ${target.url}` })
        return await buildProjectByUrl(target.url, target.id, target.title)
      }
    )
    const next = projects.map(p => p.id === projectId ? refreshed : p)
    await provider.saveProjects(next)
    vscode.window.showInformationMessage(`已更新：${refreshed.title}`)
  } catch (error: any) {
    vscode.window.showErrorMessage(`更新失败：${error?.message || String(error)}`)
  }
}

async function pickApi(matches: Array<{ path: string; method: string }>) {
  const picked = await vscode.window.showQuickPick(
    matches.map(item => ({
      label: `${item.method.toUpperCase()} ${item.path}`,
      path: item.path,
      method: item.method
    })),
    { placeHolder: '匹配到多个路由，请选择一个' }
  )
  return picked ? { path: picked.path, method: picked.method } : undefined
}
