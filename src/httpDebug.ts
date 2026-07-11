import * as vscode from 'vscode'

const OUTPUT_CHANNEL_NAME = '工作助手 HTTP'
const MAX_BODY_LENGTH = 2000

let outputChannel: vscode.OutputChannel | undefined

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME)
  }
  return outputChannel
}

export function isHttpDebugEnabled(): boolean {
  return vscode.workspace.getConfiguration('swaggerHelper').get<boolean>('debugHttp', false)
}

function maskHeaderValue(key: string, value: string): string {
  const lower = key.toLowerCase()
  if (lower === 'x-yunxiao-token' || lower === 'authorization') {
    if (value.length <= 8) {
      return '***'
    }
    return `${value.slice(0, 4)}...${value.slice(-4)}`
  }
  return value
}

function formatHeaders(headers?: HeadersInit): string {
  if (!headers) {
    return '  (no headers)'
  }

  const entries: Array<[string, string]> = []
  if (headers instanceof Headers) {
    headers.forEach((value, key) => entries.push([key, maskHeaderValue(key, value)]))
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      entries.push([key, maskHeaderValue(key, value)])
    }
  } else {
    for (const [key, value] of Object.entries(headers)) {
      entries.push([key, maskHeaderValue(key, String(value))])
    }
  }

  if (entries.length === 0) {
    return '  (no headers)'
  }
  return entries.map(([key, value]) => `  ${key}: ${value}`).join('\n')
}

function truncateBody(body: string): string {
  if (body.length <= MAX_BODY_LENGTH) {
    return body
  }
  return `${body.slice(0, MAX_BODY_LENGTH)}\n... [truncated, ${body.length} chars total]`
}

export async function fetchWithDebug(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET'
  const started = Date.now()

  if (isHttpDebugEnabled()) {
    const output = getOutputChannel()
    output.appendLine(`\n>>> ${method} ${url}`)
    output.appendLine(formatHeaders(init?.headers))
    output.show(true)
  }

  const response = await fetch(url, init)

  if (isHttpDebugEnabled()) {
    const clone = response.clone()
    let bodyText = ''
    try {
      bodyText = await clone.text()
    } catch (error) {
      bodyText = `[failed to read body: ${error instanceof Error ? error.message : String(error)}]`
    }

    const output = getOutputChannel()
    output.appendLine(`<<< ${response.status} ${response.statusText} (${Date.now() - started}ms)`)
    output.appendLine(truncateBody(bodyText || '(empty)'))
  }

  return response
}
