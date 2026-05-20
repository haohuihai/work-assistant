import * as vscode from 'vscode'
import { registerApiTestPage } from './apiTestPage'

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
    this.contextValue = 'api'
    this.tooltip = `${api.method.toUpperCase()} ${api.path}`
    this.command = {
      command: 'swaggerHelper.openApiDetail',
      title: '打开接口详情',
      arguments: [project, api]
    }
    this.iconPath = new vscode.ThemeIcon('symbol-method')
  }
}

type TreeNode = ProjectNode | ApiNode

let detailPanel: vscode.WebviewPanel | undefined

export function activate(context: vscode.ExtensionContext) {
  const provider = new SwaggerTreeProvider(context)
  const workView = vscode.window.createTreeView('swaggerHelper.workView', { treeDataProvider: provider })
  // registerApiTestPage(context)

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
    const project = await buildProjectByUrl(normalized)
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
    const refreshed = await buildProjectByUrl(target.url, target.id, target.title)
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

function normalizeUrl(raw: string) {
  return raw.trim().replace(/\s+/g, '')
}

async function httpGetText(url: string, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
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
    if (schema.description) obj.__description = schema.description
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
      return {
        __type: 'array',
        __description: schema.description,
        items: [item]
      }
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
    body: schemaToJson(jsonContent?.schema, swagger)
  }
}


function escapeHtml(raw: string) {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeScriptContent(raw: string) {
  return raw
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/<\/script>/gi, '<\\/script>')
}

function getDetailHtml(project: ProjectItem, api: ApiItem) {
  const reqText = JSON.stringify(api.reqJson, null, 2)
  const resText = JSON.stringify(api.resJson, null, 2)
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
        <pre style="margin:0;white-space:pre-wrap;word-break:break-word;background:#0F172A;border:1px solid #374151;border-radius:6px;padding:10px;">${escapeHtml(reqText)}</pre>
      </section>
      <section style="background:#1F2937;border:1px solid #374151;border-radius:8px;padding:12px;">
        <div style="margin:0 0 10px 0;color:#93C5FD; display:flex; justify-content:space-between; align-items:center;">
            <span>Response</span>
            <button style="cursor:pointer;background:none;border:none;color:#93C5FD;font:inherit;" onclick="copyToClipboard(payloads.response, '响应参数')">复制</button>
        </div>
        <pre style="margin:0;white-space:pre-wrap;word-break:break-word;background:#0F172A;border:1px solid #374151;border-radius:6px;padding:10px;">${escapeHtml(resText)}</pre>
      </section>
    </div>
    <div id="copy-toast" style="position:fixed;right:16px;bottom:16px;padding:10px 14px;border-radius:8px;background:#2563EB;color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.35);opacity:0;transform:translateY(8px);transition:opacity .2s ease,transform .2s ease;pointer-events:none;">
      已复制到剪贴板
    </div>
  <script>
    const payloads = {
      request: \`${escapeScriptContent(reqText)}\`,
      response: \`${escapeScriptContent(resText)}\`,
      all: \`${escapeScriptContent(allText)}\`
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
