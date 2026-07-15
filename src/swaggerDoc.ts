import { fetchWithDebug } from './httpDebug'
import { normalizeUrl } from './utils'
import type { ApiItem, ProjectItem } from './swaggerTypes'

export async function buildProjectByUrl(url: string, id?: string, title?: string): Promise<ProjectItem> {
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

export async function loadSwaggerDoc(inputUrl: string) {
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

export function findApis(swagger: any, routeInput: string): Array<{ path: string; method: string }> {
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

export function buildRequestJson(swagger: any, path: string, method: string) {
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

export function buildResponseJson(swagger: any, path: string, method: string) {
  const detail = swagger?.paths?.[path]?.[method] || {}
  const responses = detail.responses || {}
  console.log('responses----------------', responses)
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

export function buildRequestMock(req: any) {
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

export function buildResponseMock(res: any) {
  if (!res) return null
  return extractSample(res.body)
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

  console.log('schema++++++++++++++++', schema)

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

    case 'array': {
      // meta.items may exist as meta.items or meta[0] depending on schemaToJson
      const itemMeta = meta.items || (Array.isArray(meta) && meta[0]) || { type: 'string' }
      return [generateSampleByMeta(itemMeta)]
    }

    case 'object': {
      // produce object by mapping properties if present
      const obj: any = {}
      if (meta.properties && typeof meta.properties === 'object') {
        for (const k of Object.keys(meta.properties)) {
          obj[k] = extractSample(meta.properties[k])
        }
        return obj
      }
      return {}
    }

    default:
      return null
  }
}
