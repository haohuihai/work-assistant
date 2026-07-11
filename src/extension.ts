import * as vscode from 'vscode'
import { registerApiTestPage } from './apiTestPage'
import { fetchWithDebug } from './httpDebug'
import { registerRightClickMenu } from './rightClickMenu'
import { showPipelineList } from './pipeLine'
import { escapeHtml, normalizeUrl } from './utils'
type ApiItem = {
  path: string
  method: string
  reqJson: any
  resJson: any
}

type ProjectItem = {
  id: string
  title: string
  url: string
  apis: ApiItem[]
  updatedAt: number
}

const STORAGE_KEY = 'swaggerHelper.projects'

class SwaggerTreeProvider implements vscode.TreeDataProvider<TreeNode> {
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

class ProjectNode extends vscode.TreeItem {
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

class ApiNode extends vscode.TreeItem {
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

type TreeNode = ProjectNode | ApiNode

let detailPanel: vscode.WebviewPanel | undefined

export function activate(context: vscode.ExtensionContext) {
  const provider = new SwaggerTreeProvider(context)
  const workView = vscode.window.createTreeView('swaggerHelper.workView', { treeDataProvider: provider })
  // registerApiTestPage(context)
  registerRightClickMenu(context)
  // registerWhenClauseTest(context)
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

// 新增项目
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

async function buildProjectByUrl(url: string, id?: string, title?: string): Promise<ProjectItem> {
  const swagger = await loadSwaggerDoc(url)
  const apis: ApiItem[] = []
  Object.keys(swagger.paths || {}).forEach(path => {
    Object.keys(swagger.paths[path] || {}).forEach(method => {
      apis.push({
        path,
        method,
        reqJson: buildRequestJson(swagger, path, method),
        resJson: buildResponseJson(swagger, path, method)
      })
    })
  })
  return {
    id: id || `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    title: title || url,
    url,
    apis,
    updatedAt: Date.now()
  }
}

function openApiDetail(project: ProjectItem, api: ApiItem) {
  if (!detailPanel) {
    detailPanel = vscode.window.createWebviewPanel(
      'swaggerHelperDetail',
      '接口详情',
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    )
    detailPanel.onDidDispose(() => {
      detailPanel = undefined
    })
  }
  detailPanel.title = `${api.method.toUpperCase()} ${api.path}`
  detailPanel.webview.html = getDetailHtml(project, api)
  detailPanel.reveal(vscode.ViewColumn.Beside)
}

async function loadSwaggerDoc(inputUrl: string) {
  const normalized = normalizeUrl(inputUrl)

  // 1) 先按 JSON 文档尝试，兼容直接输入 /v2/api-docs 或 /v3/api-docs
  const direct = await tryGetSwaggerJson(normalized)
  if (direct) return direct

  // 2) 如果是 Swagger UI 页面，解析页面内容中的 JSON 文档地址
  const fromHtml = await resolveSwaggerJsonUrlFromHtml(normalized)
  if (fromHtml) {
    const parsed = await tryGetSwaggerJson(fromHtml)
    if (parsed) return parsed
  }

  // 3) 常见默认路径兜底
  for (const candidate of buildSwaggerDocCandidates(normalized)) {
    const parsed = await tryGetSwaggerJson(candidate)
    if (parsed) return parsed
  }

  throw new Error(`无法从该地址解析 Swagger 文档：${inputUrl}`)
}


async function httpGetText(url: string, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchWithDebug(url, {
      method: 'GET',
      headers: { 'User-Agent': 'VSCode Extension' },
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

async function tryGetSwaggerJson(url: string) {
  try {
    const text = await httpGetText(url, 12000)
    const data = JSON.parse(text)
    if (data && typeof data === 'object' && (data.openapi || data.swagger) && data.paths) {
      return data
    }
    return undefined
  } catch {
    return undefined
  }
}

async function resolveSwaggerJsonUrlFromHtml(pageUrl: string) {
  try {
    const html = await httpGetText(pageUrl, 12000)
    if (!html) return undefined

    // Swagger UI 常见配置：url: "xxx"
    const urlMatch =
      html.match(/["'\s]url["'\s]*:\s*["']([^"']+)["']/i) ||
      html.match(/swaggerUrl\s*[:=]\s*["']([^"']+)["']/i) ||
      html.match(/[?&]url=([^"'&\s>]+)/i)
    if (urlMatch?.[1]) {
      return toAbsoluteUrl(pageUrl, decodeURIComponent(urlMatch[1]))
    }

    // OpenAPI 3 常见配置：urls: [{ url: "xxx" }]
    const urlsMatch = html.match(/["']url["']\s*:\s*["']([^"']+)["']/i)
    if (urlsMatch?.[1]) {
      return toAbsoluteUrl(pageUrl, urlsMatch[1])
    }
  } catch {
    return undefined
  }
  return undefined
}

function buildSwaggerDocCandidates(inputUrl: string) {
  const parsed = splitUrl(inputUrl)
  if (!parsed) return []
  const origin = parsed.origin
  const path = parsed.path || '/'
  const candidates = new Set<string>()

  const known = ['/v3/api-docs', '/v2/api-docs', '/swagger/v1/swagger.json', '/openapi.json']
  known.forEach(p => candidates.add(`${origin}${p}`))

  const baseDir = path.endsWith('/') ? path : path.substring(0, path.lastIndexOf('/') + 1)
  const localKnown = ['v3/api-docs', 'v2/api-docs', 'swagger/v1/swagger.json', 'openapi.json']
  localKnown.forEach(p => candidates.add(`${origin}${baseDir}${p}`))

  return Array.from(candidates)
}

function toAbsoluteUrl(baseUrl: string, maybeRelativeUrl: string) {
  if (!maybeRelativeUrl) return maybeRelativeUrl
  if (/^https?:\/\//i.test(maybeRelativeUrl)) return maybeRelativeUrl
  const parsed = splitUrl(baseUrl)
  if (!parsed) return maybeRelativeUrl
  if (maybeRelativeUrl.startsWith('/')) {
    return `${parsed.origin}${maybeRelativeUrl}`
  }
  const dir = parsed.path.endsWith('/')
    ? parsed.path
    : parsed.path.substring(0, parsed.path.lastIndexOf('/') + 1)
  return `${parsed.origin}${dir}${maybeRelativeUrl}`
}

function splitUrl(raw: string): { origin: string; path: string } | undefined {
  const matched = raw.match(/^(https?:\/\/[^/]+)(\/[^?#]*)?/i)
  if (!matched) return undefined
  return {
    origin: matched[1],
    path: matched[2] || '/'
  }
}

function schemaToJson(schema: any, swagger: any, visited: Set<string> = new Set(), depth: number = 0): any {
  // 防止过深的递归
  if (depth > 10) {
    return { __max_depth_exceeded: true }
  }

  if (!schema) return {}

  if (schema.$ref) {
    const refKey = schema.$ref
    if (visited.has(refKey)) {
      // 检测到循环引用，返回一个占位符
      return { __circular_ref: refKey }
    }
    visited.add(refKey)
    const refSchema = getSchemaByRef(swagger, refKey)
    const result = schemaToJson(refSchema, swagger, visited, depth + 1)
    visited.delete(refKey)
    return result
  }

  if (schema.oneOf?.length) {
    return schemaToJson(schema.oneOf[0], swagger, visited, depth + 1)
  }
  if (schema.anyOf?.length) {
    return schemaToJson(schema.anyOf[0], swagger, visited, depth + 1)
  }
  if (schema.allOf?.length) {
    return schema.allOf.reduce((acc: any, item: any) => {
      const current = schemaToJson(item, swagger, visited, depth + 1)
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        return { ...acc, ...current }
      }
      return acc
    }, {})
  }

  if (schema.type === 'object') {
    const obj: any = {}
    if (schema.description) {
      obj.description = schema.description
      try { obj.description = parseDescription(schema.description) } catch {}
    }
    const properties = schema.properties || {}
    const requiredFields = new Set<string>(schema.required || [])
    for (const key in properties) {
      const fieldValue = schemaToJson(properties[key], swagger, visited, depth + 1)
      obj[key] = requiredFields.has(key) ? withRequiredMeta(fieldValue) : fieldValue
    }
    return obj
  }

  if (schema.type === 'array') {
    const item = schemaToJson(schema.items, swagger, visited, depth + 1)
    if (schema.description) {
      const out: any = {
        items: [item]
      }
      try { out.description = parseDescription(schema.description) } catch {}
      return out
    }
    return [item]
  }

  return toLeafMeta(schema)
}

function toLeafMeta(schema: any) {
  const type = schema?.type || 'any'
  const format = schema?.format ? `${type}(${schema.format})` : type
  const leaf: any = {
    value: sampleValueByType(type),
    type: format
  }

  if (schema?.description) leaf.description = schema.description
  // 解析 description 中可能包含的键值信息（例如 "Desc:...\r\nDefault:0\r\nNullable:False"）
  if (schema?.description) {
    try {
      leaf.description = parseDescription(schema.description)
    } catch {
      // ignore parse errors
    }
  }
  if (schema?.nullable !== undefined) leaf.nullable = !!schema.nullable
  if (schema?.default !== undefined) leaf.default = schema.default
  if (schema?.example !== undefined) leaf.example = schema.example

  return leaf
}

function sampleValueByType(type: string) {
  switch (type) {
    case 'string': return 'string'
    case 'integer': return 0
    case 'number': return 0
    case 'boolean': return true
    default: return null
  }
}

function withRequiredMeta(value: any) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...value, required: true }
  }
  return { value, required: true }
}

function getSchemaByRef(swagger: any, ref: string) {
  const key = ref.replace(/^#\//, '')
  const parts = key.split('/')
  let current = swagger
  for (const part of parts) {
    if (current == null) return undefined
    current = current[part]
  }
  return current
}

function findApis(swagger: any, routeInput: string): Array<{ path: string; method: string }> {
  const route = routeInput.toLowerCase().trim()
  const result: Array<{ path: string; method: string }> = []
  const methods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head']

  Object.keys(swagger.paths || {}).forEach(path => {
    Object.keys(swagger.paths[path] || {}).forEach(method => {
      if (!methods.includes(method.toLowerCase())) return
      const full = `${method.toLowerCase()} ${path.toLowerCase()}`
      if (full.includes(route) || path.toLowerCase().includes(route)) {
        result.push({ path, method })
      }
    })
  })

  return result
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

function buildRequestJson(swagger: any, path: string, method: string) {
  const detail = swagger?.paths?.[path]?.[method] || {}
  const req: any = {}

  const parameters = detail.parameters || []
  for (const p of parameters) {
    const key = p.name || 'field'
    req[key] = withParameterMeta(
      schemaToJson(p.schema || { type: p.type || 'string' }, swagger),
      p
    )
  }

  const requestBody = detail.requestBody?.content || {}
  const jsonContent = requestBody['application/json'] || Object.values(requestBody)[0]
  if (jsonContent?.schema) {
    req.body = schemaToJson(jsonContent.schema, swagger)
  }

  // 确保所有 description 都被解析为结构化字段
  ensureParsedDescriptions(req)

  return req
}

function withParameterMeta(value: any, parameter: any) {
  const meta: any = {}
  if (parameter?.in) meta.in = parameter.in
  if (parameter?.description) meta.description = parameter.description
  if (parameter?.required !== undefined) meta.required = !!parameter.required

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...value, ...meta }
  }
  return { value, ...meta }
}

function buildResponseJson(swagger: any, path: string, method: string) {
  const detail = swagger?.paths?.[path]?.[method] || {}
  const responses = detail.responses || {}
  const preferredStatus = ['200', '201', 'default']
  const status = preferredStatus.find(code => responses[code]) || Object.keys(responses)[0]
  const selected = status ? responses[status] : undefined
  const content = selected?.content || {}
  const jsonContent = content['application/json'] || Object.values(content)[0]

  return {
    status: status || 'unknown',
    body: (() => {
      const b = schemaToJson(jsonContent?.schema, swagger)
      ensureParsedDescriptions(b)
      return b
    })()
  }
}

// 递归扫描生成的 meta/示例对象，将 description 字符串解析成 description
function ensureParsedDescriptions(node: any) {
  if (node == null) return
  if (Array.isArray(node)) {
    for (const item of node) ensureParsedDescriptions(item)
    return
  }
  if (typeof node !== 'object') return

  // 如果当前对象是叶子元数据并且有 description 但没有 __parsedDescription，则解析并绑定
  if (node.description === undefined) {
    if (typeof node.description === 'string') {
      try { node.description = parseDescription(node.description) } catch {}
    }
  }

  for (const k of Object.keys(node)) {
    try {
      ensureParsedDescriptions(node[k])
    } catch {
      // ignore individual child errors
    }
  }
}



function escapeScriptContent(raw: string) {
  return raw
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/<\/script>/gi, '<\\/script>')
}

// 解析字段描述字符串，支持从形如:
// "Desc:未找到审批人时流转类型: 1转移到超级管理员 2自动驳回\r\nDefault:0\r\nNullable:False" 中提取结构化信息
function parseDescription(raw: string) {
  if (!raw) return { text: '' }
  // 将可能的转义换行序列统一为真实换行
  let text = raw.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n')
  text = text.replace(/\r\n/g, '\n')

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const result: any = { text: '', extras: {} }

  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9_\- ]+)\s*:\s*(.*)$/)
    if (m) {
      const key = m[1].trim()
      const val = m[2].trim()
      const lk = key.toLowerCase()
      if (lk === 'desc' || lk === 'description' || lk === '说明') {
        result.text = val
      } else if (lk === 'default') {
        // 尝试解析为 number/boolean，否则当作字符串
        if (/^\d+$/.test(val)) result.default = parseInt(val, 10)
        else if (/^\d+\.\d+$/.test(val)) result.default = parseFloat(val)
        else if (/^(true|false)$/i.test(val)) result.default = /^true$/i.test(val)
        else result.default = val
      } else if (lk === 'nullable') {
        result.nullable = /true/i.test(val) || val === '1'
      } else if (lk === 'example') {
        result.example = val
      } else {
        result.extras[key] = val
      }
    } else {
      // 非 key:value 行，附加到 text
      if (result.text) result.text += '\n' + line
      else result.text = line
    }
  }

  // 如果没有单独的 text，但有原始内容，保留为 text
  if (!result.text) result.text = text
  return result
}

// 从 schemaToJson 生成的结构中提取纯示例值，用于 mock 数据
function extractSample(value: any): any {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) {
    if (value.length === 0) return []
    return value.map(v => extractSample(v))[0]
  }
  if (typeof value === 'object') {
    // 叶子节点通常包含 value/type/description/example/default/nullable/required 等元数据
    const keys = Object.keys(value)
    const leafKeys = ['value', 'type', 'description', 'example', 'default', 'nullable', 'required', 'in', 'name', 'format', 'enum']
    const isLeaf = keys.includes('value') && keys.every(k => leafKeys.includes(k))
    if (isLeaf) {
      return generateSampleByMeta(value)
    }

    const out: any = {}
    for (const k of Object.keys(value)) {
      out[k] = extractSample(value[k])
    }
    return out
  }
  return value
}

function generateSampleByMeta(meta: any): any {
  // prefer explicit example/default when present
  if (!meta) return null
  if (meta.example !== undefined) return meta.example
  if (meta.default !== undefined) return meta.default

  const typeStr: string = (meta.type || 'any').toString()
  const m = typeStr.match(/^([a-zA-Z]+)(?:\(([^)]+)\))?$/)
  const base = m ? m[1].toLowerCase() : 'any'
  const fmt = m && m[2] ? m[2].toLowerCase() : ''

  switch (base) {
    case 'string':
      if (fmt.includes('date') || fmt.includes('date-time') || fmt.includes('datetime')) {
        return new Date(Date.now() - Math.floor(Math.random() * 1000 * 60 * 60 * 24 * 365)).toISOString()
      }
      if (fmt.includes('uuid')) {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0
          const v = c === 'x' ? r : (r & 0x3 | 0x8)
          return v.toString(16)
        })
      }
      if (fmt.includes('email')) {
        return `user${Math.floor(Math.random() * 9000 + 1000)}@example.com`
      }
      // fallback: generate a short alphanumeric string
      return `str_${Math.random().toString(36).slice(2, 10)}`

    case 'integer':
    case 'number':
      return Math.floor(Math.random() * 1000)

    case 'boolean':
      return Math.random() < 0.5

    case 'array':
      // meta.items may exist as meta.items or meta[0] depending on schemaToJson
      const itemMeta = meta.items || (Array.isArray(meta) && meta[0]) || { type: 'string' }
      return [generateSampleByMeta(itemMeta)]

    case 'object':
      // produce object by mapping properties if present
      const obj: any = {}
      if (meta.properties && typeof meta.properties === 'object') {
        for (const k of Object.keys(meta.properties)) {
          obj[k] = extractSample(meta.properties[k])
        }
        return obj
      }
      return {}

    default:
      return null
  }
}

// 构建请求的 mock 数据：将 parameters（除 body 外）与 body 合并为一个对象
function buildRequestMock(req: any) {
  if (!req) return null
  const mock: any = {}
  const params: any = {}
  for (const k of Object.keys(req)) {
    if (k === 'body') continue
    params[k] = extractSample(req[k])
  }
  if (Object.keys(params).length) mock.parameters = params
  if (req.body) mock.body = extractSample(req.body)
  return mock
}

// 构建响应的 mock 数据，resJson 结构为 { status, body }
function buildResponseMock(res: any) {
  if (!res) return null
  return extractSample(res.body)
}

function getDetailHtml(project: ProjectItem, api: ApiItem) {
  const reqText = JSON.stringify(api.reqJson, null, 2)
  const resText = JSON.stringify(api.resJson, null, 2)
  const reqMock = buildRequestMock(api.reqJson)
  const resMock = buildResponseMock(api.resJson)
  const reqMockText = JSON.stringify(reqMock, null, 2)
  const resMockText = JSON.stringify(resMock, null, 2)
  const allText = `${api.method.toUpperCase()} ${api.path}\n\n请求参数:\n${reqText}\n\n响应参数:\n${resText}`

  return `
  <html>
  <body style="font-family:Segoe UI,sans-serif;margin:0;background:#111827;color:#E5E7EB;">
    <div style="padding:14px 16px;border-bottom:1px solid #374151;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
        <h2 style="margin:0;">${api.method.toUpperCase()} ${api.path}</h2>
        <button style="cursor:pointer;background:#2563EB;border:none;border-radius:4px;color:#fff;padding:4px 8px;font-size:12px;" onclick="copyToClipboard(payloads.all, '全部信息')">复制全部</button>
      </div>
      <div style="color:#9CA3AF;font-size:12px;">项目：${escapeHtml(project.title)} | 地址：${escapeHtml(project.url)}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px;">
      <section style="background:#1F2937;border:1px solid #374151;border-radius:8px;padding:12px;">
        <div style="margin:0 0 10px 0;color:#93C5FD;display:flex; justify-content:space-between; align-items:center;">
            <span>Request</span>
            <button style="cursor:pointer;background:none;border:none;color:#93C5FD;font:inherit;" onclick="copyToClipboard(payloads.request, '请求参数')">复制</button>
        </div>
        <pre style="margin:0;white-space:pre-wrap;word-break:break-word;background:#0F172A;border:1px solid #374151;border-radius:6px;padding:10px;max-height:450px;overflow:auto;">${escapeHtml(reqText)}</pre>
        <div style="margin-top:10px;color:#9CA3AF;font-size:12px;display:flex;justify-content:space-between;align-items:center;">
          <span>请求 Mock</span>
          <button style="cursor:pointer;background:none;border:none;color:#93C5FD;font:inherit;" onclick="copyToClipboard(payloads.requestMock, '请求 Mock')">复制 Mock</button>
        </div>
        <pre style="margin:8px 0 0 0;white-space:pre-wrap;word-break:break-word;background:#0B1220;border:1px solid #263244;border-radius:6px;padding:10px;max-height:220px;overflow:auto;color:#D1FAE5;">${escapeHtml(reqMockText)}</pre>
      </section>
      <section style="background:#1F2937;border:1px solid #374151;border-radius:8px;padding:12px;">
        <div style="margin:0 0 10px 0;color:#93C5FD; display:flex; justify-content:space-between; align-items:center;">
            <span>Response</span>
            <button style="cursor:pointer;background:none;border:none;color:#93C5FD;font:inherit;" onclick="copyToClipboard(payloads.response, '响应参数')">复制</button>
        </div>
        <pre style="margin:0;white-space:pre-wrap;word-break:break-word;background:#0F172A;border:1px solid #374151;border-radius:6px;padding:10px;max-height:450px;overflow:auto;">${escapeHtml(resText)}</pre>
        <div style="margin-top:10px;color:#9CA3AF;font-size:12px;display:flex;justify-content:space-between;align-items:center;">
          <span>响应 Mock</span>
          <button style="cursor:pointer;background:none;border:none;color:#93C5FD;font:inherit;" onclick="copyToClipboard(payloads.responseMock, '响应 Mock')">复制 Mock</button>
        </div>
        <pre style="margin:8px 0 0 0;white-space:pre-wrap;word-break:break-word;background:#0B1220;border:1px solid #263244;border-radius:6px;padding:10px;max-height:220px;overflow:auto;color:#FEF3C7;">${escapeHtml(resMockText)}</pre>
      </section>
    </div>
    <div id="copy-toast" style="position:fixed;right:16px;bottom:16px;padding:10px 14px;border-radius:8px;background:#2563EB;color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.35);opacity:0;transform:translateY(8px);transition:opacity .2s ease,transform .2s ease;pointer-events:none;">
      已复制到剪贴板
    </div>
  <script>
    const payloads = {
      request: \`${escapeScriptContent(reqText)}\`,
      response: \`${escapeScriptContent(resText)}\`,
      all: \`${escapeScriptContent(allText)}\`,
      requestMock: \`${escapeScriptContent(reqMockText)}\`,
      responseMock: \`${escapeScriptContent(resMockText)}\`
    };

    let toastTimer;

    function showToast(message) {
      const toast = document.getElementById('copy-toast');
      if (!toast) return;

      toast.textContent = message;
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';

      if (toastTimer) {
        clearTimeout(toastTimer);
      }

      toastTimer = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
      }, 1800);
    }

    async function copyToClipboard(text, type = '内容') {
      try {
        await navigator.clipboard.writeText(text);
        showToast("已复制到剪贴板");
      } catch (error) {
        showToast('复制失败，请手动复制');
      }
    }
  </script>
  </body>
  </html>
  `
}

export function deactivate() { }
