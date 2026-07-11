import * as vscode from 'vscode'
import { fetchWithDebug } from './httpDebug'
import { escapeHtml, normalizeUrl } from './utils'



type PipelineSummary = {
  pipelineId: number
  pipelineName: string
  createAccountId: string
  createTime: number
  runStatus?: string
  hasCheckpoint?: boolean
  envInfo?: EnvDeployMap
}

type DeployEnvKey = 'intranet' | 'pre' | 'prod'

type EnvDeployInfo = {
  branch?: string
  domain?: string
}

type EnvDeployMap = Partial<Record<DeployEnvKey, EnvDeployInfo>>

type PipelineJobAction = {
  type?: string
  disable?: boolean
  name?: string
  title?: string
  params?: Record<string, unknown>
}

type PipelineRunJob = {
  id: number
  name: string
  status: string
  params?: string
  jobSign?: string
  actions?: PipelineJobAction[]
}

type PipelineRunStage = {
  name: string
  stageInfo?: {
    name: string
    status: string
    jobs?: PipelineRunJob[]
  }
}

type PipelineRunDetail = {
  pipelineId: number
  pipelineRunId: number
  status: string
  createTime?: number
  updateTime?: number
  creatorAccountId?: string
  stages?: PipelineRunStage[]
  globalParams?: Array<{ key: string; value: string }>
  sources?: Array<{ name?: string; sign?: string; data?: { branch?: string } }>
}

type PipelineEnvGroup = {
  key: DeployEnvKey
  label: string
  branch?: string
  domain?: string
  stages: PipelineRunStage[]
  status: string
}

type CheckpointPassMode = 'validate' | 'start_job' | 'resume_deploy'

type PipelineCheckpointBlock = {
  stageName: string
  stageStatus: string
  targetEnv: DeployEnvKey
  targetLabel: string
  job?: PipelineRunJob
  actionJob?: PipelineRunJob
  passMode?: CheckpointPassMode
  deployOrderId?: number
  active: boolean
}

type PipelineDeployFlowBlock =
  | { kind: 'env'; group: PipelineEnvGroup }
  | { kind: 'checkpoint'; checkpoint: PipelineCheckpointBlock }

type PipelineDeployLayout = {
  envGroups: PipelineEnvGroup[]
  checkpoints: PipelineCheckpointBlock[]
  flowBlocks: PipelineDeployFlowBlock[]
  envInfo: EnvDeployMap
  flowYaml?: string
}

type PipelineDetailView = {
  pipelineId: number
  pipelineName: string
  envName?: string
  latestRun?: PipelineRunDetail
  envInfo: EnvDeployMap
  layout?: PipelineDeployLayout
}

type PipelineListPageInfo = {
  page: number
  perPage: number
  total: number
  totalPages: number
}

type PipelineListResult = {
  pipelines: Array<{ pipelineId: number; pipelineName: string; createAccountId: string; createTime: number }>
  pageInfo: PipelineListPageInfo
}

const DEFAULT_PIPELINE_PER_PAGE = 30

type YunxiaoPanelContext = {
  flowBaseUrl: string
  token: string
  pipelines: PipelineSummary[]
  page: number
  perPage: number
  total: number
  totalPages: number
  current?: {
    pipelineId: number
    pipelineName: string
    pipelineRunId?: number
  }
}

let pipelinePanel: vscode.WebviewPanel | undefined
let yunxiaoPanelContext: YunxiaoPanelContext | undefined

export async function showPipelineList() {
  const yunxiaoConfig = vscode.workspace.getConfiguration('swaggerHelper.yunxiao')
  const token = yunxiaoConfig.get<string>('token')?.trim() || ''
  const domain = yunxiaoConfig.get<string>('domain')?.trim() || ''
  const organizationId = yunxiaoConfig.get<string>('organizationId')?.trim() || ''
  const pageNum = 1
  const perPageNum = DEFAULT_PIPELINE_PER_PAGE

  if (!token) {
    vscode.window.showErrorMessage('请先在设置中配置 swaggerHelper.yunxiao.token，再重新执行查看流水线。')
    return
  }
  if (!domain) {
    vscode.window.showErrorMessage('请先在设置中配置 swaggerHelper.yunxiao.domain，再重新执行查看流水线。')
    return
  }

  const apiOrigin = buildYunxiaoApiOrigin(domain)
  if (isYunxiaoCenterEdition(domain) && !organizationId) {
    vscode.window.showErrorMessage(
      '中心站必须配置 swaggerHelper.yunxiao.organizationId。请在设置中填写。'
    )
    return
  }

  ensurePipelinePanel()
  updatePipelinePanel('<div style="padding:16px;color:#D1D5DB;">正在加载流水线...</div>')
  pipelinePanel!.title = '云效流水线'
  pipelinePanel!.reveal(vscode.ViewColumn.Beside)

  try {
    const flowBaseUrl = buildYunxiaoFlowBaseUrl(apiOrigin, organizationId)
    const listResult = await fetchPipelineList(flowBaseUrl, token, pageNum, perPageNum)
    yunxiaoPanelContext = {
      flowBaseUrl,
      token,
      page: listResult.pageInfo.page,
      perPage: listResult.pageInfo.perPage,
      total: listResult.pageInfo.total,
      totalPages: listResult.pageInfo.totalPages,
      pipelines: listResult.pipelines
    }
    pipelinePanel!.title = '云效流水线列表'
    updatePipelinePanel(renderPipelineListContent(
      listResult.pipelines,
      listResult.pageInfo.page,
      listResult.pageInfo.perPage,
      undefined,
      listResult.pageInfo
    ))

    // 下面太耗性能 先注释掉  使用点击的方式自行查看
    // enrichPipelineSummaries(yunxiaoPanelContext, pipelines)
    //   .then(() => {
    //     if (!pipelinePanel || !yunxiaoPanelContext) return
    //     updatePipelinePanel(renderPipelineListContent(
    //       yunxiaoPanelContext.pipelines,
    //       yunxiaoPanelContext.page,
    //       yunxiaoPanelContext.perPage
    //     ))
    //   })
    //   .catch(() => {
    //     // 分支信息加载失败不影响列表展示
    //   })
  } catch (error: unknown) {
    updatePipelinePanel(formatPipelineLoadError(error))
  }
}

function ensurePipelinePanel() {
  if (pipelinePanel) return

  pipelinePanel = vscode.window.createWebviewPanel(
    'yunxiaoPipelineList',
    '云效流水线',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  )
  // 获取列表 的html
  pipelinePanel.webview.html = getPipelinePanelShell()
  // 监听面板关闭事件，清理上下文
  pipelinePanel.onDidDispose(() => {
    pipelinePanel = undefined
    yunxiaoPanelContext = undefined
  })
  //  处理html面板接收到的信息  点击事件等
  pipelinePanel.webview.onDidReceiveMessage(async message => {
    await handlePipelinePanelMessage(message)
  })
}

// 根据用户输入的云效域名，构建云效 API 的基础 URL
function buildYunxiaoApiOrigin(rawDomain: string) {
  let normalized = normalizeUrl(rawDomain)
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`
  }

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error(`无法解析云效域名：${rawDomain}`)
  }

  return `${parsed.protocol}//${parsed.host}`
}

// 渲染流水线面板内容
function updatePipelinePanel(content: string) {
  if (!pipelinePanel) return
  pipelinePanel.webview.postMessage({ type: 'render', content })
}

function updatePipelinePanelRow(pipelineId: number, rowHtml: string) {
  if (!pipelinePanel) return
  pipelinePanel.webview.postMessage({ type: 'updateRow', pipelineId, rowHtml })
}


async function loadPipelineListPage(ctx: YunxiaoPanelContext, page: number) {
  if (!pipelinePanel) return
  updatePipelinePanel('<div style="padding:16px;color:#D1D5DB;">正在加载流水线列表...</div>')
  try {
    const listResult = await fetchPipelineList(ctx.flowBaseUrl, ctx.token, page, ctx.perPage)
    ctx.page = listResult.pageInfo.page
    ctx.perPage = listResult.pageInfo.perPage
    ctx.total = listResult.pageInfo.total
    ctx.totalPages = listResult.pageInfo.totalPages
    ctx.pipelines = listResult.pipelines
    pipelinePanel.title = '云效流水线列表'
    updatePipelinePanel(renderPipelineListContent(
      listResult.pipelines,
      listResult.pageInfo.page,
      listResult.pageInfo.perPage,
      undefined,
      listResult.pageInfo
    ))
  } catch (error: unknown) {
    updatePipelinePanel(formatPipelineLoadError(error))
  }
}

async function refreshPipelineList(ctx: YunxiaoPanelContext) {
  await loadPipelineListPage(ctx, ctx.page)
}



async function handlePipelinePanelMessage(message: { command?: string; pipelineId?: number; jobId?: number; searchValue?: string; page?: number }) {
  if (!pipelinePanel || !yunxiaoPanelContext) {
    vscode.window.showWarningMessage('流水线面板尚未就绪，请稍后重试。')
    return
  }

  try {
    if (message.command === 'viewDetail') {
      const pipelineId = Number(message.pipelineId)
      if (!pipelineId) return
      const pipeline = yunxiaoPanelContext.pipelines.find(item => item.pipelineId === pipelineId)
      const pipelineName = pipeline?.pipelineName || String(pipelineId)
      updatePipelinePanel('<div style="padding:16px;color:#D1D5DB;">正在加载流水线详情...</div>')
      const detail = await loadPipelineDetailView(yunxiaoPanelContext, pipelineId, pipelineName)
      console.log('--------detail', detail)
      yunxiaoPanelContext.current = {
        pipelineId,
        pipelineName: detail.pipelineName,
        pipelineRunId: detail.latestRun?.pipelineRunId
      }
      pipelinePanel.title = `流水线：${detail.pipelineName}`
      updatePipelinePanel(renderPipelineDetailContent(detail))
      return
    }
    if (message.command === 'viewBranch') {
      const pipelineId = Number(message.pipelineId)
      if (!pipelineId) return
      const index = yunxiaoPanelContext.pipelines.findIndex(item => item.pipelineId === pipelineId)
      if (index < 0) return

      updatePipelinePanelRow(pipelineId, renderPipelineListRowLoading(pipelineId))
      try {
        const target = yunxiaoPanelContext.pipelines[index]
        await enrichPipelineSummaries(yunxiaoPanelContext, [target])
        yunxiaoPanelContext.pipelines[index] = {
          ...yunxiaoPanelContext.pipelines[index],
          envInfo: target.envInfo,
          runStatus: target.runStatus,
          hasCheckpoint: target.hasCheckpoint
        }
        if (!pipelinePanel) return
        updatePipelinePanelRow(pipelineId, renderPipelineListRow(yunxiaoPanelContext.pipelines[index]))
      } catch {
        if (pipelinePanel) {
          updatePipelinePanelRow(pipelineId, renderPipelineListRow(yunxiaoPanelContext.pipelines[index]))
        }
        vscode.window.showWarningMessage('加载分支信息失败，请稍后重试。')
      }
      return
    }
    if (message.command === 'backToList') {
      yunxiaoPanelContext.current = undefined
      pipelinePanel.title = '云效流水线列表'
      updatePipelinePanel(renderPipelineListContent(
        yunxiaoPanelContext.pipelines,
        yunxiaoPanelContext.page,
        yunxiaoPanelContext.perPage,
        undefined,
        buildPageInfoFromContext(yunxiaoPanelContext)
      ))
      return
    }

    if (message.command === 'refreshDetail') {
      const current = yunxiaoPanelContext.current
      if (!current) return
      updatePipelinePanel('<div style="padding:16px;color:#D1D5DB;">正在刷新...</div>')
      const detail = await loadPipelineDetailView(yunxiaoPanelContext, current.pipelineId, current.pipelineName)
      yunxiaoPanelContext.current = {
        pipelineId: current.pipelineId,
        pipelineName: detail.pipelineName,
        pipelineRunId: detail.latestRun?.pipelineRunId
      }
      updatePipelinePanel(renderPipelineDetailContent(detail))
      return
    }
    if (message.command === 'refreshList') {
      await refreshPipelineList(yunxiaoPanelContext)
      return
    }

    if (message.command === 'goToPage') {
      const page = Number(message.page)
      if (!Number.isInteger(page) || page < 1) return
      if (yunxiaoPanelContext.totalPages > 0 && page > yunxiaoPanelContext.totalPages) return
      yunxiaoPanelContext.current = undefined
      await loadPipelineListPage(yunxiaoPanelContext, page)
      return
    }

    if (message.command === 'searchById') {
      const raw = String(message.searchValue ?? '').trim()
      const pipelineId = Number(raw)
      if (!raw || !Number.isInteger(pipelineId) || pipelineId <= 0) {
        vscode.window.showWarningMessage('请输入有效的流水线 ID（正整数）。')
        return
      }
      updatePipelinePanel(`<div style="padding:16px;color:#D1D5DB;">正在搜索流水线 ${pipelineId}...</div>`)
      let result = yunxiaoPanelContext.pipelines.find(item => item.pipelineId === pipelineId)
      if (!result) {
        try {
          result = await buildPipelineSummary(yunxiaoPanelContext, pipelineId)
        } catch {
          result = undefined
        }
      }
      pipelinePanel.title = '云效流水线列表'
      updatePipelinePanel(renderPipelineListContent(
        result ? [result] : [],
        yunxiaoPanelContext.page,
        yunxiaoPanelContext.perPage,
        pipelineId
      ))
      return
    }

    if (message.command === 'clearPipelineSearch') {
      pipelinePanel.title = '云效流水线列表'
      updatePipelinePanel(renderPipelineListContent(
        yunxiaoPanelContext.pipelines,
        yunxiaoPanelContext.page,
        yunxiaoPanelContext.perPage,
        undefined,
        buildPageInfoFromContext(yunxiaoPanelContext)
      ))
      return
    }

    if (message.command === 'passCheckpoint' || message.command === 'refuseCheckpoint') {
      const current = yunxiaoPanelContext.current
      const requestedJobId = Number(message.jobId)
      if (!current?.pipelineRunId || !requestedJobId) {
        vscode.window.showWarningMessage('缺少流水线运行信息，请刷新详情后重试。')
        return
      }
      const detail = await loadPipelineDetailView(yunxiaoPanelContext, current.pipelineId, current.pipelineName)
      const matchedCheckpoint = detail.layout?.checkpoints.find(item =>
        item.actionJob?.id === requestedJobId || item.job?.id === requestedJobId
      )
      const passJob = matchedCheckpoint?.actionJob
        || resolveCheckpointActionJobFromRun(
          detail.latestRun?.stages || [],
          requestedJobId,
          detail.layout?.checkpoints,
          detail.layout?.flowYaml
        )
      if (!passJob?.id) {
        vscode.window.showErrorMessage('未找到可操作的卡点/部署任务，请刷新后在云效控制台确认。')
        return
      }

      const confirmLabel = matchedCheckpoint?.passMode === 'start_job'
        ? '开始部署'
        : matchedCheckpoint?.passMode === 'resume_deploy'
          ? '继续部署'
          : '放行'
      const pickedLabel = await vscode.window.showWarningMessage(
        `确认${confirmLabel}，继续执行后续流程？`,
        { modal: true },
        confirmLabel
      )
      if (pickedLabel !== confirmLabel) return

      if (matchedCheckpoint && !matchedCheckpoint.passMode) {
        finalizeCheckpointPassMeta(matchedCheckpoint, detail.layout?.flowYaml || '')
      }

      await executeCheckpointPass(
        yunxiaoPanelContext,
        current.pipelineId,
        current.pipelineRunId,
        matchedCheckpoint,
        passJob,
        detail.layout?.flowYaml
      )
      vscode.window.showInformationMessage(`已${confirmLabel}`)
      updatePipelinePanel('<div style="padding:16px;color:#D1D5DB;">正在刷新...</div>')
      const refreshed = await loadPipelineDetailView(yunxiaoPanelContext, current.pipelineId, current.pipelineName)
      yunxiaoPanelContext.current = {
        pipelineId: current.pipelineId,
        pipelineName: refreshed.pipelineName,
        pipelineRunId: refreshed.latestRun?.pipelineRunId
      }
      updatePipelinePanel(renderPipelineDetailContent(refreshed))
    }
  } catch (error: unknown) {
    const text = error instanceof Error ? error.message : String(error)
    vscode.window.showErrorMessage(`操作失败：${text}`)
    if (yunxiaoPanelContext.current) {
      updatePipelinePanel(`<div style="padding:16px;color:#FCA5A5;">操作失败：${escapeHtml(text)}</div>`)
    }
  }
}

async function yunxiaoRequest(baseUrl: string, token: string, path: string, method: 'GET' | 'POST' | 'PUT' = 'GET') {
  const response = await fetchWithDebug(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-yunxiao-token': token
    }
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  }
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

async function loadPipelineDetailView(ctx: YunxiaoPanelContext, pipelineId: number, pipelineName: string): Promise<PipelineDetailView> {
  // 获取流水线详情
  const pipeline = await yunxiaoRequest(ctx.flowBaseUrl, ctx.token, `/pipelines/${pipelineId}`) as Record<string, unknown> | undefined
  let latestRun: PipelineRunDetail | undefined
  try {
    // 获取最近一次流水线运行信息
    const run = await yunxiaoRequest(
      ctx.flowBaseUrl,
      ctx.token,
      `/pipelines/${pipelineId}/runs/latestPipelineRun`
    ) as Record<string, unknown> | undefined
    if (run && run.pipelineRunId != null) {
      const pipelineRunId = Number(run.pipelineRunId)
      try {
        // 获取流水线运行实例
        const fullRun = await yunxiaoRequest(
          ctx.flowBaseUrl,
          ctx.token,
          `/pipelines/${pipelineId}/runs/${pipelineRunId}`
        ) as Record<string, unknown> | undefined
        latestRun = normalizePipelineRun(fullRun || run)
      } catch {
        latestRun = normalizePipelineRun(run)
      }
    }
  } catch {
    latestRun = undefined
  }

  const envInfo = extractEnvDeployInfo(pipeline, latestRun)
  const flowYaml = getPipelineFlowYaml(pipeline)
  return {
    pipelineId,
    pipelineName: String(pipeline?.name || pipelineName),
    envName: typeof pipeline?.envName === 'string' ? pipeline.envName : undefined,
    latestRun,
    envInfo,
    layout: latestRun ? buildDeployLayout(latestRun.stages || [], envInfo, flowYaml) : undefined
  }
}

async function enrichPipelineSummaries(ctx: YunxiaoPanelContext, pipelines: PipelineSummary[]) {
  await Promise.all(pipelines.map(async item => {
    try {
      const pipeline = await yunxiaoRequest(ctx.flowBaseUrl, ctx.token, `/pipelines/${item.pipelineId}`) as Record<string, unknown> | undefined

      item.envInfo = extractEnvDeployInfo(pipeline)
      const run = await yunxiaoRequest(
        ctx.flowBaseUrl,
        ctx.token,
        `/pipelines/${item.pipelineId}/runs/latestPipelineRun`
      ) as Record<string, unknown> | undefined
      console.log("run", run)
      if (!run?.pipelineRunId) return
      item.runStatus = String(run.status || '')
      const normalized = normalizePipelineRun(run)
      item.envInfo = extractEnvDeployInfo(pipeline, normalized)
      item.hasCheckpoint = runHasPendingCheckpoint(normalized.stages || [])
      if (item.hasCheckpoint) {
        try {
          const fullRun = await yunxiaoRequest(
            ctx.flowBaseUrl,
            ctx.token,
            `/pipelines/${item.pipelineId}/runs/${Number(run.pipelineRunId)}`
          ) as Record<string, unknown> | undefined
          if (fullRun) {
            const detailed = normalizePipelineRun(fullRun)
            item.envInfo = extractEnvDeployInfo(pipeline, detailed)
            item.hasCheckpoint = runHasPendingCheckpoint(detailed.stages || [])
          }
        } catch {
          // keep summary run result
        }
      }
    } catch {
      // ignore per-pipeline status errors
    }
  }))
}

function normalizePipelineRun(raw: Record<string, unknown>): PipelineRunDetail {
  const stages = Array.isArray(raw.stages) ? raw.stages.map(item => {
    const stage = item as Record<string, unknown>
    const stageInfo = stage.stageInfo as Record<string, unknown> | undefined
    const jobs = Array.isArray(stageInfo?.jobs)
      ? stageInfo!.jobs.map(jobItem => normalizePipelineRunJob(jobItem as Record<string, unknown>))
      : []
    return {
      name: String(stage.name || stageInfo?.name || '未命名阶段'),
      stageInfo: stageInfo ? {
        name: String(stageInfo.name || stage.name || '未命名阶段'),
        status: String(stageInfo.status || 'UNKNOWN'),
        jobs
      } : undefined
    }
  }) : []

  return {
    pipelineId: Number(raw.pipelineId || 0),
    pipelineRunId: Number(raw.pipelineRunId || 0),
    status: String(raw.status || 'UNKNOWN'),
    createTime: typeof raw.createTime === 'number' ? raw.createTime : undefined,
    updateTime: typeof raw.updateTime === 'number' ? raw.updateTime : undefined,
    creatorAccountId: typeof raw.creatorAccountId === 'string' ? raw.creatorAccountId : undefined,
    stages,
    globalParams: Array.isArray(raw.globalParams)
      ? raw.globalParams.map(item => {
        const param = item as Record<string, unknown>
        return {
          key: String(param.key || ''),
          value: String(param.value ?? '')
        }
      })
      : undefined,
    sources: Array.isArray(raw.sources)
      ? raw.sources.map(item => {
        const source = item as Record<string, unknown>
        const data = source.data as Record<string, unknown> | undefined
        return {
          name: typeof source.name === 'string' ? source.name : undefined,
          sign: typeof source.sign === 'string' ? source.sign : undefined,
          data: data && typeof data.branch === 'string' ? { branch: data.branch } : undefined
        }
      })
      : undefined
  }
}

function normalizePipelineRunJob(raw: Record<string, unknown>): PipelineRunJob {
  const actions = Array.isArray(raw.actions)
    ? raw.actions.map(actionItem => {
      const action = actionItem as Record<string, unknown>
      return {
        type: typeof action.type === 'string' ? action.type : undefined,
        disable: action.disable === true,
        name: typeof action.name === 'string' ? action.name : undefined,
        title: typeof action.title === 'string' ? action.title : undefined,
        params: action.params && typeof action.params === 'object'
          ? action.params as Record<string, unknown>
          : undefined
      }
    })
    : []

  return {
    id: parsePipelineJobId(raw),
    name: String(raw.name || '未命名任务'),
    status: String(raw.status || 'UNKNOWN'),
    params: typeof raw.params === 'string' ? raw.params : undefined,
    jobSign: typeof raw.jobSign === 'string' ? raw.jobSign : undefined,
    actions
  }
}

function parsePipelineJobId(raw: Record<string, unknown>) {
  const value = raw.id ?? raw.jobId
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

// 构建单条流水线摘要（不批量请求）
async function buildPipelineSummary(ctx: YunxiaoPanelContext, pipelineId: number): Promise<PipelineSummary> {
  const pipeline = await yunxiaoRequest(ctx.flowBaseUrl, ctx.token, `/pipelines/${pipelineId}`) as Record<string, unknown> | undefined

  let runStatus: string | undefined
  let hasCheckpoint = false
  let normalizedRun: PipelineRunDetail | undefined

  try {
    const latest = await yunxiaoRequest(ctx.flowBaseUrl, ctx.token, `/pipelines/${pipelineId}/runs/latestPipelineRun`) as Record<string, unknown> | undefined
    console.log("latest", latest)
    if (latest && latest.pipelineRunId != null) {
      try {
        const full = await yunxiaoRequest(ctx.flowBaseUrl, ctx.token, `/pipelines/${pipelineId}/runs/${Number(latest.pipelineRunId)}`) as Record<string, unknown> | undefined
        normalizedRun = normalizePipelineRun(full || latest)
      } catch {
        normalizedRun = normalizePipelineRun(latest)
      }
    }
  } catch {
    normalizedRun = undefined
  }

  if (normalizedRun) {
    runStatus = normalizedRun.status
    hasCheckpoint = runHasPendingCheckpoint(normalizedRun.stages || [])
  }

  const envInfo = extractEnvDeployInfo(pipeline, normalizedRun)

  return {
    pipelineId,
    pipelineName: String(pipeline?.name || `#${pipelineId}`),
    createAccountId: typeof pipeline?.createAccountId === 'string' ? pipeline.createAccountId : (typeof pipeline?.creatorAccountId === 'string' ? (pipeline as any).creatorAccountId : ''),
    createTime: typeof pipeline?.createTime === 'number' ? pipeline.createTime : 0,
    runStatus,
    hasCheckpoint,
    envInfo
  }
}

// 刷新单条流水线摘要并更新上下文中的 pipelines 数组
async function refreshSinglePipelineSummary(ctx: YunxiaoPanelContext | undefined, pipelineId: number) {
  if (!ctx) throw new Error('Panel context not ready')
  const summary = await buildPipelineSummary(ctx, pipelineId)
  const idx = ctx.pipelines.findIndex(p => p.pipelineId === pipelineId)
  if (idx >= 0) {
    ctx.pipelines[idx] = summary
  } else {
    ctx.pipelines.push(summary)
  }
}

function envLabel(key: DeployEnvKey) {
  return ({ intranet: '内网', pre: '预发', prod: '正式' } as const)[key]
}

function getStageName(stage: PipelineRunStage) {
  return stage.stageInfo?.name || stage.name || '未命名阶段'
}

function isDeployLikeName(name: string) {
  return /构建|部署|build|deploy|cdn|编译|打包|发布/i.test(name)
}

function isCheckpointStageName(name: string) {
  if (/卡点|人工卡点|人工审批|人工审核|手动审批|发布审批|上线审批|人工确认|确认发布|门禁/.test(name)) return true
  if (/转正式|至正式|发正式|直发|特殊直发/.test(name) && !isDeployLikeName(name)) return true
  return false
}

function inferEnvFromStageName(name: string): DeployEnvKey | undefined {
  if (/内网/.test(name)) return 'intranet'
  if (/外网|预发/.test(name)) return 'pre'
  if (/正式/.test(name)) return 'prod'
  return undefined
}

type StagePartitionContext = {
  envKind?: DeployEnvKey
  previousEnv?: DeployEnvKey
}

function classifyStage(name: string): DeployEnvKey | 'checkpoint' | 'other' {
  if (isCheckpointStageName(name)) return 'checkpoint'
  const inferred = inferEnvFromStageName(name)
  if (inferred) return inferred
  return 'other'
}

function resolveStageKind(stage: PipelineRunStage): DeployEnvKey | 'checkpoint' | 'other' {
  const name = getStageName(stage)
  if (isCheckpointStageName(name)) return 'checkpoint'

  const jobs = stage.stageInfo?.jobs || []
  const envHint = inferEnvFromStageName(name)
  const checkpointJobs = jobs.filter(job => isManualCheckpointJob(job, { envKind: envHint }))
  const deployJobs = jobs.filter(job => !isManualCheckpointJob(job, { envKind: envHint }) && isDeployLikeName(job.name))

  // 仅有卡点任务、无构建/部署任务时，即使阶段名含「预发/正式」也视为卡点
  if (checkpointJobs.length && !deployJobs.length) return 'checkpoint'

  if (/内网/.test(name)) return 'intranet'
  if (/外网/.test(name) && isDeployLikeName(name)) return 'pre'
  if (/预发/.test(name)) return 'pre'
  if (/正式/.test(name)) return 'prod'
  return 'other'
}

function stageHasPendingCheckpoint(stage: PipelineRunStage, previousEnv?: DeployEnvKey) {
  const name = getStageName(stage)
  const kind = resolveStageKind(stage)
  const envKind = (kind === 'intranet' || kind === 'pre' || kind === 'prod') ? kind : inferEnvFromStageName(name)
  const context: StagePartitionContext = { envKind, previousEnv }

  if (kind === 'checkpoint') {
    return (stage.stageInfo?.jobs || []).some(job => isCheckpointPendingJob(job))
  }
  if ((stage.stageInfo?.status || '').toUpperCase() === 'SWITCH_MANUAL') {
    return (stage.stageInfo?.jobs || []).some(job => job.status.toUpperCase() !== 'SKIP')
  }
  return partitionStageJobs(stage, context).checkpointJobs.some(job => isCheckpointPendingJob(job))
}

function runHasPendingCheckpoint(stages: PipelineRunStage[]) {
  let previousEnv: DeployEnvKey | undefined
  for (const stage of stages) {
    if (stageHasPendingCheckpoint(stage, previousEnv)) return true
    const kind = resolveStageKind(stage)
    if (kind === 'intranet' || kind === 'pre' || kind === 'prod') {
      previousEnv = kind
    }
  }
  return false
}

function getPipelineFlowYaml(pipeline: Record<string, unknown> | undefined) {
  const config = pipeline?.pipelineConfig as Record<string, unknown> | undefined
  return typeof config?.flow === 'string' ? config.flow : ''
}

function envKeywords(): Array<[DeployEnvKey, string[]]> {
  return [
    ['intranet', ['内网', 'intranet', 'dev', 'develop']],
    ['pre', ['预发', '外网', 'pre', 'staging', 'uat', 'master_bug']],
    ['prod', ['正式', 'prod', 'production', 'master']],
  ]
}

function matchEnvFromText(text: string): DeployEnvKey | undefined {
  const lower = text.toLowerCase()
  if (/内网|intranet|\bdev\b|develop/.test(lower)) return 'intranet'
  if (/预发|外网|\bpre\b|staging|uat|master_bug/.test(lower)) return 'pre'
  if (/正式|\bprod\b|production|\bmaster\b/.test(lower) && !/master_bug/.test(lower)) return 'prod'
  return undefined
}

function isDomainValue(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (/^https?:\/\//i.test(trimmed)) return true
  return /^[\w.-]+\.[a-z]{2,}(?:[/:].*)?$/i.test(trimmed)
}

function normalizeDomainValue(value: string) {
  return value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

function classifyParamKind(key: string, value: string): 'branch' {
  const combined = `${key}${value}`.toLowerCase()
  if (/branch|分支|ref|gitref/.test(combined)) {
    return 'branch'
  }
  return 'branch'
}

function ensureEnvInfo(map: EnvDeployMap, env: DeployEnvKey): EnvDeployInfo {
  if (!map[env]) map[env] = {}
  return map[env]!
}

function setEnvField(map: EnvDeployMap, env: DeployEnvKey, kind: 'branch' , value: string) {
  const trimmed =  value.trim()
  if (!trimmed) return
  const info = ensureEnvInfo(map, env)
  info.branch = trimmed
}

function applyEnvParam(map: EnvDeployMap, env: DeployEnvKey, key: string, value: string) {
  setEnvField(map, env, classifyParamKind(key, value), value)
}

function mergeEnvDeployMap(...maps: EnvDeployMap[]): EnvDeployMap {
  const result: EnvDeployMap = {}
  for (const map of maps) {
    for (const key of ['intranet', 'pre', 'prod'] as DeployEnvKey[]) {
      const src = map[key]
      if (!src) continue
      const dst = ensureEnvInfo(result, key)
      if (src.branch) dst.branch = src.branch
    }
  }
  return result
}

function extractEnvDeployFromYaml(flow: string): EnvDeployMap {
  const map: EnvDeployMap = {}
  if (!flow) return map

  for (const [env, keywords] of envKeywords()) {
    for (const kw of keywords) {
      const branchPatterns = [
        new RegExp(`${kw}[\\s\\S]{0,900}?branch['"\\s]*[:=]\\s*['"]?([^'"\\n]+)`, 'i'),
        new RegExp(`name:\\s*[^\\n]*${kw}[\\s\\S]{0,500}?branch:\\s*['"]?([^'"\\n]+)`, 'i'),
      ]
    
      for (const pattern of branchPatterns) {
        const matched = flow.match(pattern)
        if (matched?.[1]) {
          setEnvField(map, env, 'branch', matched[1])
          break
        }
      }
     
    }
  }
  return map
}

function extractEnvDeployFromParams(run?: PipelineRunDetail): EnvDeployMap {
  const map: EnvDeployMap = {}
  if (!run?.globalParams) return map

  for (const param of run.globalParams) {
    const value = param.value.trim()
    if (!value) continue
    const env = matchEnvFromText(param.key)
    if (env) {
      applyEnvParam(map, env, param.key, value)
      continue
    }
    if (/branch|分支/i.test(param.key)) {
      const branchEnv = matchEnvFromText(param.key)
      if (branchEnv) setEnvField(map, branchEnv, 'branch', value)
    }
  }
  return map
}

function extractEnvDeployFromRunStages(stages: PipelineRunStage[]): EnvDeployMap {
  const map: EnvDeployMap = {}
  const branchKeys = ['branch', 'BRANCH', 'branchName', 'BRANCH_NAME', 'gitBranch', 'gitRef']

  for (const stage of stages) {
    const env = classifyStage(getStageName(stage))
    if (env === 'other' || env === 'checkpoint') continue
    for (const job of stage.stageInfo?.jobs || []) {
      if (!job.params) continue
      try {
        const params = JSON.parse(job.params) as Record<string, unknown>
        for (const key of branchKeys) {
          const value = params[key]
          if (typeof value === 'string' && value.trim()) {
            setEnvField(map, env, 'branch', value)
          }
        }
        for (const [key, rawValue] of Object.entries(params)) {
          if (typeof rawValue !== 'string' || !rawValue.trim()) continue
          const matchedEnv = matchEnvFromText(key) || env
          if (/branch|分支/i.test(key)) setEnvField(map, matchedEnv, 'branch', rawValue)
        }
      } catch {
        const branchMatch = job.params.match(/branch["']?\s*[:=]\s*["']?([^"'\\n]+)/i)
        if (branchMatch?.[1]) setEnvField(map, env, 'branch', branchMatch[1])
      }
    }
  }
  return map
}

function extractEnvDeployInfo(pipeline?: Record<string, unknown>, run?: PipelineRunDetail): EnvDeployMap {
  const flow = getPipelineFlowYaml(pipeline)
  const map = mergeEnvDeployMap(
    extractEnvDeployFromYaml(flow),
    extractEnvDeployFromParams(run),
    extractEnvDeployFromRunStages(run?.stages || [])
  )

  const defaults: EnvDeployMap = {}
  if (!map.intranet?.branch && /develop/.test(flow)) {
    setEnvField(defaults, 'intranet', 'branch', 'develop')
  }
  if (!map.pre?.branch && /master_bug/.test(flow)) {
    setEnvField(defaults, 'pre', 'branch', 'master_bug')
  }
  if (!map.prod?.branch && /\bmaster\b/.test(flow) && !/master_bug/.test(flow)) {
    setEnvField(defaults, 'prod', 'branch', 'master')
  }

  const defaultBranch = run?.sources?.find(item => item.data?.branch)?.data?.branch
  if (defaultBranch && !map.intranet?.branch) {
    setEnvField(defaults, 'intranet', 'branch', defaultBranch)
  }

  return mergeEnvDeployMap(map, defaults)
}

function aggregateStageStatus(stages: PipelineRunStage[]) {
  const statuses = stages.map(stage => (stage.stageInfo?.status || 'UNKNOWN').toUpperCase())
  if (statuses.some(status => status === 'FAIL' || status === 'FAILED')) return 'FAIL'
  if (statuses.some(status => status === 'RUNNING' || status === 'WAITING' || status === 'SWITCH_MANUAL')) return 'RUNNING'
  if (statuses.every(status => status === 'SUCCESS')) return 'SUCCESS'
  if (statuses.some(status => status === 'SUCCESS')) return 'RUNNING'
  return statuses[0] || 'INIT'
}

function inferCheckpointTarget(stageName: string, previousEnv?: DeployEnvKey) {
  if (/正式|至正式|转正式|发正式|直发/.test(stageName)) return { key: 'prod' as DeployEnvKey, label: '正式' }
  if (/预发/.test(stageName)) return { key: 'pre' as DeployEnvKey, label: '预发' }
  if (/内网/.test(stageName)) return { key: 'pre' as DeployEnvKey, label: '预发' }
  if (previousEnv === 'intranet') return { key: 'pre' as DeployEnvKey, label: '预发' }
  if (previousEnv === 'pre') return { key: 'prod' as DeployEnvKey, label: '正式' }
  return { key: 'pre' as DeployEnvKey, label: '预发' }
}

function inferJobTargetEnv(job: PipelineRunJob, stage?: PipelineRunStage): DeployEnvKey | undefined {
  const text = [job.name, job.jobSign || '', stage ? getStageName(stage) : ''].join(' ')
  if (/deployprod|正式环境|正式部署|至正式|转正式|发正式/i.test(text)) return 'prod'
  if (/deploypre|预发环境|预发部署|外网环境|外网部署/i.test(text)) return 'pre'
  if (/deployintranet|内网环境|内网部署/i.test(text)) return 'intranet'
  return inferEnvFromStageName(text)
}

function isCheckpointJobCompleted(job: PipelineRunJob) {
  const status = job.status.toUpperCase()
  return status === 'SUCCESS' || status === 'SKIP' || status === 'CANCELED'
}

function jobMatchesCheckpointEnv(job: PipelineRunJob, stage: PipelineRunStage | undefined, targetEnv: DeployEnvKey) {
  const jobEnv = inferJobTargetEnv(job, stage)
  if (jobEnv) return jobEnv === targetEnv
  if (stage) return inferCheckpointTarget(getStageName(stage)).key === targetEnv
  return false
}

function isActionJobCandidate(job: PipelineRunJob, stage: PipelineRunStage | undefined, flowYaml: string) {
  if (!isJobAwaitingManualPass(job, flowYaml) && !isManualDeployAwaiting(job)) return false
  return hasValidateAction(job)
    || isNamedManualValidateJob(job)
    || isDeployEntryGateJob(job, undefined, stage)
    || isVmDeployDrivenManual(job, flowYaml)
    || canStartJobAction(job)
    || hasStartJobAction(job)
}

function findCheckpointJob(stage: PipelineRunStage) {
  const jobs = stage.stageInfo?.jobs || []
  return jobs.find(job => isCheckpointPendingJob(job) && job.status.toUpperCase() !== 'SKIP')
    || jobs.find(job => isManualCheckpointJob(job) && job.status.toUpperCase() !== 'SKIP')
    || jobs.find(job => job.status.toUpperCase() !== 'SKIP')
}

function pushCheckpointBlock(
  checkpoints: PipelineCheckpointBlock[],
  flowBlocks: PipelineDeployFlowBlock[],
  stage: PipelineRunStage,
  job: PipelineRunJob | undefined,
  currentEnv: DeployEnvKey | undefined,
  stageName?: string
) {
  const label = stageName || getStageName(stage)
  const target = inferCheckpointTarget(label, currentEnv)
  const checkpoint: PipelineCheckpointBlock = {
    stageName: label,
    stageStatus: stage.stageInfo?.status || job?.status || 'UNKNOWN',
    targetEnv: target.key,
    targetLabel: target.label,
    job,
    active: !!(job && isCheckpointPendingJob(job))
  }
  checkpoints.push(checkpoint)
  flowBlocks.push({ kind: 'checkpoint', checkpoint })
}

function buildDeployLayout(stages: PipelineRunStage[], envInfo: EnvDeployMap, flowYaml = ''): PipelineDeployLayout {
  const envGroups: PipelineEnvGroup[] = []
  const checkpoints: PipelineCheckpointBlock[] = []
  const flowBlocks: PipelineDeployFlowBlock[] = []
  let currentEnv: DeployEnvKey | undefined
  let currentGroup: PipelineEnvGroup | undefined

  const flushCurrentGroup = () => {
    if (!currentGroup) return
    envGroups.push(currentGroup)
    flowBlocks.push({ kind: 'env', group: currentGroup })
    currentGroup = undefined
  }

  const appendEnvStage = (stage: PipelineRunStage, jobs: PipelineRunJob[]) => {
    if (!jobs.length) return
    currentGroup!.stages.push({
      ...stage,
      name: getStageName(stage),
      stageInfo: stage.stageInfo ? { ...stage.stageInfo, jobs } : undefined
    })
    currentGroup!.status = aggregateStageStatus(currentGroup!.stages)
  }

  for (const stage of stages) {
    const kind = resolveStageKind(stage)
    if (kind === 'checkpoint') {
      flushCurrentGroup()
      const job = findCheckpointJob(stage)
      pushCheckpointBlock(checkpoints, flowBlocks, stage, job, currentEnv)
      continue
    }

    if (kind === 'intranet' || kind === 'pre' || kind === 'prod') {
      const previousEnv = currentEnv
      currentEnv = kind
      const partitionContext: StagePartitionContext = { envKind: kind, previousEnv }
      const { deployJobs, checkpointJobs } = partitionStageJobs(stage, partitionContext)
      const orderedJobs = stage.stageInfo?.jobs || []
      const firstCheckpointIdx = orderedJobs.findIndex(job => isManualCheckpointJob(job, partitionContext))
      const firstDeployIdx = orderedJobs.findIndex(job => !isManualCheckpointJob(job, partitionContext))
      const checkpointFirst = checkpointJobs.length > 0 && deployJobs.length > 0
        && firstCheckpointIdx >= 0
        && (firstDeployIdx < 0 || firstCheckpointIdx < firstDeployIdx)

      if (checkpointFirst) {
        flushCurrentGroup()
        for (const job of checkpointJobs) {
          const label = isDeployLikeName(job.name) ? '人工卡点' : (job.name || getStageName(stage))
          pushCheckpointBlock(checkpoints, flowBlocks, stage, job, previousEnv, label)
        }
      }

      if (deployJobs.length) {
        if (!currentGroup || currentGroup.key !== kind) {
          flushCurrentGroup()
          currentGroup = {
            key: kind,
            label: envLabel(kind),
            branch: envInfo[kind]?.branch,
            stages: [],
            status: 'INIT'
          }
        }
        appendEnvStage(stage, deployJobs)
      }

      if (!checkpointFirst && checkpointJobs.length) {
        flushCurrentGroup()
        for (const job of checkpointJobs) {
          if (isDeployLikeName(job.name) && !hasValidateAction(job) && !/标准|人工|审批|卡点/.test(job.name)) {
            const hasReal = checkpointJobs.some(item => item !== job && (hasValidateAction(item) || !isDeployLikeName(item.name)))
            if (hasReal) continue
          }
          const label = isDeployLikeName(job.name) ? '人工卡点' : (job.name || getStageName(stage))
          pushCheckpointBlock(checkpoints, flowBlocks, stage, job, previousEnv, label)
        }
      }
      continue
    }

    // 外网构建等未直接匹配环境的阶段
    const inferredEnv = inferEnvFromStageName(getStageName(stage))
    const otherContext: StagePartitionContext = { envKind: inferredEnv, previousEnv: currentEnv }
    const { deployJobs, checkpointJobs } = partitionStageJobs(stage, otherContext)
    if (checkpointJobs.length) {
      flushCurrentGroup()
      for (const job of checkpointJobs) {
        pushCheckpointBlock(checkpoints, flowBlocks, stage, job, currentEnv, job.name || getStageName(stage))
      }
    }
    if (deployJobs.length && inferredEnv) {
      if (!currentGroup || currentGroup.key !== inferredEnv) {
        flushCurrentGroup()
        currentEnv = inferredEnv
        currentGroup = {
          key: inferredEnv,
          label: envLabel(inferredEnv),
          branch: envInfo[inferredEnv]?.branch,
          stages: [],
          status: 'INIT'
        }
      }
      appendEnvStage(stage, deployJobs)
    }
  }

  flushCurrentGroup()
  linkCheckpointActionJobs(stages, checkpoints, flowYaml)
  return { envGroups, checkpoints, flowBlocks, envInfo, flowYaml }
}

function renderBranchTag(branch?: string) {
  if (!branch) return ''
  return `<code class="branch-tag">${escapeHtml(branch)}</code>`
}

function renderEnvCell(info?: EnvDeployInfo) {
  if (!info?.branch) {
    return '<span class="branch-empty">-</span>'
  }
  const lines: string[] = []
  if (info.branch) {
    lines.push(`<div class="env-cell-line"><span class="env-cell-label"></span>${renderBranchTag(info.branch)}</div>`)
  }
  return `<div class="env-cell">${lines.join('')}</div>`
}

function renderEnvDeployHeader(envInfo: EnvDeployMap) {
  const cells = (['intranet', 'pre', 'prod'] as DeployEnvKey[]).map(key => `
    <div class="env-branch-item env-${key}">
      <span class="env-branch-label">${envLabel(key)}</span>
      ${renderEnvCell(envInfo[key])}
    </div>`).join('')

  return `<div class="env-branch-bar">${cells}</div>`
}

function isCheckpointPendingJob(job: PipelineRunJob) {
  const status = job.status.toUpperCase()
  if (status === 'SWITCH_MANUAL' || status === 'WAITING') return true
  return isActiveManualCheckpoint(job)
}

async function executeCheckpointPass(
  ctx: YunxiaoPanelContext,
  pipelineId: number,
  pipelineRunId: number,
  checkpoint: PipelineCheckpointBlock | undefined,
  job: PipelineRunJob,
  flowYaml = ''
) {
  const jobId = encodeURIComponent(String(job.id))
  const passMode = checkpoint?.passMode || resolveCheckpointPassMode(job, flowYaml)

  if (passMode === 'start_job') {
    await yunxiaoRequest(
      ctx.flowBaseUrl,
      ctx.token,
      `/pipelines/${pipelineId}/pipelineRuns/${pipelineRunId}/jobs/${jobId}/start`,
      'POST'
    )
    return
  }

  if (passMode === 'resume_deploy') {
    const deployOrderId = checkpoint?.deployOrderId || getDeployOrderIdFromJob(job)
    if (!deployOrderId) {
      throw new Error('未找到部署单 ID，无法继续部署。请在云效部署详情中确认。')
    }
    await yunxiaoRequest(
      ctx.flowBaseUrl,
      ctx.token,
      `/pipelines/${pipelineId}/deploy/${deployOrderId}/resume`,
      'PUT'
    )
    return
  }

  await yunxiaoRequest(
    ctx.flowBaseUrl,
    ctx.token,
    `/pipelines/${pipelineId}/pipelineRuns/${pipelineRunId}/jobs/${jobId}/pass`,
    'POST'
  )
}

function isValidateActionType(type?: string) {
  if (!type) return false
  const normalized = type.toLowerCase()
  return normalized.includes('passpipelinevalidate') || normalized.includes('refusepipelinevalidate')
}

function hasValidateAction(job: PipelineRunJob) {
  return (job.actions || []).some(action => isValidateActionType(action.type))
}

function canPassCheckpoint(job: PipelineRunJob) {
  return (job.actions || []).some(action => {
    const type = (action.type || '').toLowerCase()
    return type.includes('passpipelinevalidate') && action.disable !== true
  })
}

function canRefuseCheckpoint(job: PipelineRunJob) {
  return (job.actions || []).some(action => {
    const type = (action.type || '').toLowerCase()
    return type.includes('refusepipelinevalidate') && action.disable !== true
  })
}

function isActiveManualCheckpoint(job: PipelineRunJob) {
  const status = job.status.toUpperCase()
  if (status === 'WAITING') {
    return hasValidateAction(job) || canPassCheckpoint(job) || canRefuseCheckpoint(job)
  }
  return canPassCheckpoint(job) || canRefuseCheckpoint(job)
}

function isManualValidateJobParams(params?: string) {
  if (!params) return false
  try {
    const text = JSON.stringify(JSON.parse(params)).toLowerCase()
    return /manualvalidate|manual.?validate|人工卡点|pipelinevalidate|validateplugin|manualcheck|vmdeploy/i.test(text)
  } catch {
    return /manualvalidate|人工卡点|pipelinevalidate/i.test(params)
  }
}

function isDeployEntryGateJob(job: PipelineRunJob, context?: StagePartitionContext, stage?: PipelineRunStage) {
  const status = job.status.toUpperCase()
  if (status !== 'SWITCH_MANUAL' && status !== 'WAITING') return false
  if (!isDeployLikeName(job.name)) return false
  if (stage && (stage.stageInfo?.jobs || []).some(other =>
    other !== job
    && other.status.toUpperCase() !== 'SKIP'
    && !isDeployLikeName(other.name)
    && isCheckpointPendingJob(other)
  )) {
    return false
  }
  if (context?.envKind === 'prod' && context?.previousEnv === 'pre') return true
  if (context?.envKind === 'pre' && context?.previousEnv === 'intranet') return true
  return false
}

function isManualCheckpointJob(job: PipelineRunJob, context?: StagePartitionContext, stage?: PipelineRunStage) {
  const status = job.status.toUpperCase()
  if (status === 'SKIP') return false
  if (hasValidateAction(job) || canPassCheckpoint(job) || canRefuseCheckpoint(job)) return true
  if (isManualValidateJobParams(job.params) && (status === 'SWITCH_MANUAL' || status === 'WAITING' || status === 'RUNNING')) {
    return true
  }
  if (isDeployEntryGateJob(job, context, stage)) return true
  if (status === 'SWITCH_MANUAL' || status === 'WAITING') {
    return /标准|人工|审批|卡点|直发|validate|gate|确认/i.test(job.name)
  }
  return false
}

function partitionStageJobs(stage: PipelineRunStage, context?: StagePartitionContext) {
  const jobs = stage.stageInfo?.jobs || []
  const deployJobs: PipelineRunJob[] = []
  const checkpointJobs: PipelineRunJob[] = []
  for (const job of jobs) {
    if (isManualCheckpointJob(job, context, stage)) checkpointJobs.push(job)
    else deployJobs.push(job)
  }
  return { deployJobs, checkpointJobs }
}

function isNamedManualValidateJob(job: PipelineRunJob) {
  return /标准卡点|人工卡点|人工审批|manual/i.test(job.name) || isManualValidateJobParams(job.params)
}

function isJobAwaitingManualPass(job: PipelineRunJob, flowYaml = '') {
  const status = job.status.toUpperCase()
  if (status === 'SKIP' || status === 'SUCCESS') return false
  if (hasValidateAction(job)) {
    return status === 'SWITCH_MANUAL' || status === 'WAITING' || status === 'RUNNING' || status === 'INIT'
  }
  if (isVmDeployDrivenManual(job, flowYaml)) {
    return isManualDeployAwaiting(job)
  }
  return isNamedManualValidateJob(job) && (status === 'SWITCH_MANUAL' || status === 'WAITING')
}

function collectManualValidateJobs(stages: PipelineRunStage[]) {
  const jobs: PipelineRunJob[] = []
  for (const stage of stages) {
    for (const job of stage.stageInfo?.jobs || []) {
      if (job.status.toUpperCase() === 'SKIP') continue
      if (hasValidateAction(job)) jobs.push(job)
    }
  }
  return jobs
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isJobDrivenManualInYaml(flowYaml: string, jobName: string) {
  if (!flowYaml || !jobName) return false
  const escaped = escapeRegExp(jobName)
  return new RegExp(`name:\\s*${escaped}[\\s\\S]{0,800}?driven:\\s*manual`, 'i').test(flowYaml)
    || new RegExp(`driven:\\s*manual[\\s\\S]{0,800}?name:\\s*${escaped}`, 'i').test(flowYaml)
}

function isJobVmDeployInYaml(flowYaml: string, jobName: string) {
  if (!flowYaml || !jobName) return false
  const escaped = escapeRegExp(jobName)
  return new RegExp(`name:\\s*${escaped}[\\s\\S]{0,800}?component:\\s*VMDeploy`, 'i').test(flowYaml)
    || new RegExp(`component:\\s*VMDeploy[\\s\\S]{0,800}?name:\\s*${escaped}`, 'i').test(flowYaml)
}

function isVmDeployJob(job: PipelineRunJob, flowYaml: string) {
  if (isJobVmDeployInYaml(flowYaml, job.name)) return true
  if (!job.params) return false
  return /vmdeploy|machinegroup|pausestrategy|pausetype|firstbatchpause|artifactdownloadpath/i.test(job.params)
}

function hasStartJobAction(job: PipelineRunJob) {
  return (job.actions || []).some(action => {
    const type = (action.type || '').toLowerCase()
    return type.includes('startpipelinejobrun') || type.includes('executepipelinejobrun')
  })
}

function canStartJobAction(job: PipelineRunJob) {
  return (job.actions || []).some(action => {
    const type = (action.type || '').toLowerCase()
    return (type.includes('startpipelinejobrun') || type.includes('executepipelinejobrun')) && action.disable !== true
  })
}

function getDeployOrderIdFromJob(job: PipelineRunJob) {
  for (const action of job.actions || []) {
    const type = (action.type || '').toLowerCase()
    if (!type.includes('getvmdeployorder') || !action.params) continue
    const id = action.params.deployOrderId
    if (typeof id === 'number' && Number.isFinite(id)) return id
    if (typeof id === 'string' && id.trim()) {
      const parsed = Number(id)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  if (!job.params) return undefined
  try {
    const parsed = JSON.parse(job.params) as Record<string, unknown>
    const id = parsed.deployOrderId
    if (typeof id === 'number' && Number.isFinite(id)) return id
    if (typeof id === 'string' && id.trim()) {
      const num = Number(id)
      if (Number.isFinite(num)) return num
    }
  } catch {
    const matched = job.params.match(/deployOrderId["']?\s*[:=]\s*["']?(\d+)/i)
    if (matched?.[1]) return Number(matched[1])
  }
  return undefined
}

function isVmDeployDrivenManual(job: PipelineRunJob, flowYaml: string) {
  if (!isVmDeployJob(job, flowYaml)) return false
  if (isJobDrivenManualInYaml(flowYaml, job.name)) return true
  if (hasStartJobAction(job)) return true
  const status = job.status.toUpperCase()
  return status === 'WAITING' || status === 'INIT' || status === 'SWITCH_MANUAL'
}

function isManualDeployAwaiting(job: PipelineRunJob) {
  const status = job.status.toUpperCase()
  return status === 'WAITING' || status === 'INIT' || status === 'SWITCH_MANUAL'
    || status === 'PAUSE' || status === 'PAUSED' || status === 'RUNNING'
}

function resolveCheckpointPassMode(job: PipelineRunJob, flowYaml: string): CheckpointPassMode {
  const deployOrderId = getDeployOrderIdFromJob(job)
  const status = job.status.toUpperCase()
  if (deployOrderId && (status === 'RUNNING' || status === 'PAUSE' || status === 'PAUSED')) {
    return 'resume_deploy'
  }
  if (canPassCheckpoint(job) || (hasValidateAction(job) && !isVmDeployDrivenManual(job, flowYaml))) {
    return 'validate'
  }
  if (isVmDeployDrivenManual(job, flowYaml) || canStartJobAction(job) || hasStartJobAction(job)) {
    return 'start_job'
  }
  return 'validate'
}

function finalizeCheckpointPassMeta(checkpoint: PipelineCheckpointBlock, flowYaml: string) {
  if (checkpoint.job && isCheckpointJobCompleted(checkpoint.job)) {
    checkpoint.active = false
    checkpoint.actionJob = undefined
    checkpoint.passMode = undefined
    checkpoint.deployOrderId = undefined
    return
  }

  const job = checkpoint.actionJob
  if (!job) {
    checkpoint.active = false
    checkpoint.passMode = undefined
    checkpoint.deployOrderId = undefined
    return
  }

  checkpoint.passMode = resolveCheckpointPassMode(job, flowYaml)
  checkpoint.deployOrderId = getDeployOrderIdFromJob(job)

  const passMode = checkpoint.passMode
  if (passMode === 'start_job' || passMode === 'resume_deploy') {
    checkpoint.active = isManualDeployAwaiting(job)
  } else if (checkpoint.job && isCheckpointPendingJob(checkpoint.job)) {
    checkpoint.active = true
  } else {
    checkpoint.active = canPassCheckpoint(job)
      || (hasValidateAction(job) && isJobAwaitingManualPass(job, flowYaml))
      || (isNamedManualValidateJob(job) && isJobAwaitingManualPass(job, flowYaml))
  }
}

function collectAllPassCandidateJobs(stages: PipelineRunStage[], flowYaml = '') {
  const result: PipelineRunJob[] = []
  const seen = new Set<number>()
  for (const stage of stages) {
    for (const job of stage.stageInfo?.jobs || []) {
      if (job.status.toUpperCase() === 'SKIP') continue
      if (!isJobAwaitingManualPass(job, flowYaml) && !isManualDeployAwaiting(job)) continue
      if (!hasValidateAction(job) && !isNamedManualValidateJob(job) && !isDeployEntryGateJob(job, undefined, stage)
        && !isVmDeployDrivenManual(job, flowYaml)) {
        continue
      }
      if (seen.has(job.id)) continue
      seen.add(job.id)
      result.push(job)
    }
  }
  return result
}

function findActionJobForCheckpoint(
  stages: PipelineRunStage[],
  checkpoint: PipelineCheckpointBlock,
  used: Set<number>,
  flowYaml = ''
) {
  const candidates: Array<{ job: PipelineRunJob; stage: PipelineRunStage }> = []
  for (const stage of stages) {
    for (const job of stage.stageInfo?.jobs || []) {
      if (used.has(job.id) || job.status.toUpperCase() === 'SKIP') continue
      if (!jobMatchesCheckpointEnv(job, stage, checkpoint.targetEnv)) continue
      if (!isActionJobCandidate(job, stage, flowYaml)) continue
      candidates.push({ job, stage })
    }
  }

  const pick = (predicate: (item: { job: PipelineRunJob; stage: PipelineRunStage }) => boolean) =>
    candidates.find(predicate)?.job

  return pick(item => hasValidateAction(item.job) && isJobAwaitingManualPass(item.job, flowYaml))
    || pick(item => isVmDeployDrivenManual(item.job, flowYaml) && isManualDeployAwaiting(item.job))
    || pick(item => isNamedManualValidateJob(item.job) && isJobAwaitingManualPass(item.job, flowYaml))
    || pick(item => isDeployEntryGateJob(item.job, undefined, item.stage))
    || candidates[0]?.job
}

function linkCheckpointActionJobs(stages: PipelineRunStage[], checkpoints: PipelineCheckpointBlock[], flowYaml = '') {
  const used = new Set<number>()

  for (const checkpoint of checkpoints) {
    checkpoint.actionJob = undefined

    if (checkpoint.job && isCheckpointJobCompleted(checkpoint.job)) {
      finalizeCheckpointPassMeta(checkpoint, flowYaml)
      continue
    }

    const matched = findActionJobForCheckpoint(stages, checkpoint, used, flowYaml)
    if (matched) {
      checkpoint.actionJob = matched
      used.add(matched.id)
    } else if (checkpoint.job && isCheckpointPendingJob(checkpoint.job)) {
      checkpoint.actionJob = checkpoint.job
      used.add(checkpoint.job.id)
    }

    finalizeCheckpointPassMeta(checkpoint, flowYaml)
  }
}

function resolveCheckpointActionJobFromRun(
  stages: PipelineRunStage[],
  requestedJobId: number,
  checkpoints?: PipelineCheckpointBlock[],
  flowYaml = ''
): PipelineRunJob | undefined {
  const matchedBlock = checkpoints?.find(item =>
    item.actionJob?.id === requestedJobId || item.job?.id === requestedJobId
  )
  if (matchedBlock?.actionJob?.id) {
    return matchedBlock.actionJob
  }

  for (const job of collectManualValidateJobs(stages)) {
    if (job.id === requestedJobId && isJobAwaitingManualPass(job, flowYaml)) return job
  }

  for (const job of collectAllPassCandidateJobs(stages, flowYaml)) {
    if (job.id === requestedJobId) return job
  }

  if (matchedBlock?.job) {
    return matchedBlock.job
  }

  return undefined
}



function renderPipelineStatusBadge(status: string) {
  const normalized = status.toUpperCase()
  const colorMap: Record<string, { bg: string; fg: string }> = {
    SUCCESS: { bg: '#064E3B', fg: '#6EE7B7' },
    RUNNING: { bg: '#78350F', fg: '#FCD34D' },
    FAIL: { bg: '#7F1D1D', fg: '#FCA5A5' },
    FAILED: { bg: '#7F1D1D', fg: '#FCA5A5' },
    WAITING: { bg: '#1E3A8A', fg: '#93C5FD' },
    CANCELED: { bg: '#374151', fg: '#D1D5DB' }
  }
  const colors = colorMap[normalized] || { bg: '#374151', fg: '#E5E7EB' }
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${colors.bg};color:${colors.fg};font-size:12px;">${escapeHtml(status)}</span>`
}

function renderPipelineListRowLoading(pipelineId: number) {
  return `
    <tr class="pipeline-row pipeline-row-loading" data-pipeline-id="${pipelineId}">
      <td colspan="7" style="color:#9CA3AF;">正在加载分支信息...</td>
    </tr>`
}

function renderPipelineListRow(item: PipelineSummary) {
  const envInfo = item.envInfo || {}
  const waiting = item.hasCheckpoint
  const rowClass = waiting ? 'pipeline-row pipeline-row-waiting' : 'pipeline-row'
  const statusBadge = item.runStatus
    ? renderPipelineStatusBadge(item.runStatus)
    : '<span style="color:#6B7280;">-</span>'
  let actionHint = waiting
    ? '<span class="badge-waiting">待审批</span>'
    : '<span type="button" class="btn-link" data-action="view-detail" data-pipeline-id="' + item.pipelineId + '">查看详情</span>'
  actionHint += '<span type="button" class="btn-link" data-action="view-branch" data-pipeline-id="' + item.pipelineId + '">查看分支</span>'
  return `
    <tr class="${rowClass}" data-action="view-detail" data-pipeline-id="${item.pipelineId}">
      <td>${escapeHtml(String(item.pipelineId))}</td>
      <td><span class="link-text">${escapeHtml(item.pipelineName)}</span></td>
      <td>${statusBadge}</td>
      <td>${renderEnvCell(envInfo.intranet)}</td>
      <td>${renderEnvCell(envInfo.pre)}</td>
      <td>${renderEnvCell(envInfo.prod)}</td>
      <td>${actionHint}</td>
    </tr>`
}

function renderPipelineSearchBar(searchId?: number) {
  const clearButton = searchId != null
    ? '<button type="button" class="btn-secondary" data-action="clear-search">清除搜索</button>'
    : ''
  return `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
      <input id="pipeline-search-input" class="search-input" type="text"
        placeholder="输入流水线 ID，回车搜索" value="${searchId ?? ''}" />
      <button type="button" class="btn-link" style="margin-left:0;" data-action="search-by-id">搜索</button>
      ${clearButton}
    </div>`
}

function buildPageInfoFromContext(ctx: YunxiaoPanelContext): PipelineListPageInfo {
  return {
    page: ctx.page,
    perPage: ctx.perPage,
    total: ctx.total,
    totalPages: ctx.totalPages
  }
}

function renderPipelineListPagination(pageInfo: PipelineListPageInfo, itemCount: number) {
  const { page, perPage, total, totalPages } = pageInfo
  const hasPrev = page > 1
  const hasNext = totalPages > 0
    ? page < totalPages
    : itemCount >= perPage
  const totalLabel = total > 0 ? String(total) : '未知'
  const totalPagesLabel = totalPages > 0 ? String(totalPages) : '?'

  return `
    <div class="pagination-bar">
      <button type="button" class="btn-secondary" data-action="page-prev" data-page="${page - 1}"${hasPrev ? '' : ' disabled'}>上一页</button>
      <span class="pagination-info">第 ${page} / ${totalPagesLabel} 页，共 ${totalLabel} 条，每页 ${perPage} 条</span>
      <button type="button" class="btn-secondary" data-action="page-next" data-page="${page + 1}"${hasNext ? '' : ' disabled'}>下一页</button>
    </div>`
}

function renderPipelineListContent(
  pipelines: PipelineSummary[],
  page: number,
  perPage: number,
  searchId?: number,
  pageInfo?: PipelineListPageInfo
) {
  if ((!pipelines || pipelines.length === 0) && searchId == null) {
    return '<div style="padding:16px;color:#D1D5DB;">未查询到流水线，请检查组织 ID / token / 网络是否正确。</div>'
  }

  const resolvedPageInfo: PipelineListPageInfo = pageInfo || {
    page,
    perPage,
    total: pipelines.length,
    totalPages: pipelines.length < perPage ? page : 0
  }

  const hint = searchId != null
    ? `搜索结果：流水线 ID ${searchId}，共 ${pipelines.length} 条。`
    : '橙色高亮行为待审批人工卡点，点击可进入操作。'

  const tableBody = pipelines.length === 0
    ? `<div style="padding:24px;text-align:center;color:#9CA3AF;border:1px solid #334155;border-radius:10px;background:#0F172A;">未找到 ID 为 ${searchId} 的流水线，请检查 ID 是否正确。</div>`
    : `
      <div style="overflow:auto;border:1px solid #334155;border-radius:10px;background:#0F172A;">
        <table style="width:100%;border-collapse:collapse;min-width:920px;color:#E5E7EB;font-size:13px;">
          <thead>
            <tr style="background:#111827;color:#CBD5E1;text-align:left;">
              <th style="padding:12px 16px;border-bottom:1px solid #1F2937;">流水线 ID</th>
              <th style="padding:12px 16px;border-bottom:1px solid #1F2937;">流水线名称</th>
              <th style="padding:12px 16px;border-bottom:1px solid #1F2937;">运行状态</th>
              <th style="padding:12px 16px;border-bottom:1px solid #1F2937;">内网<br/><span style="font-weight:400;color:#6B7280;font-size:11px;">分支</span></th>
              <th style="padding:12px 16px;border-bottom:1px solid #1F2937;">预发<br/><span style="font-weight:400;color:#6B7280;font-size:11px;">分支</span></th>
              <th style="padding:12px 16px;border-bottom:1px solid #1F2937;">正式<br/><span style="font-weight:400;color:#6B7280;font-size:11px;">分支</span></th>
              <th style="padding:12px 16px;border-bottom:1px solid #1F2937;">操作</th>
            </tr>
          </thead>
          <tbody id="sym-pipelines">${pipelines.map(item => renderPipelineListRow(item)).join('')}</tbody>
        </table>
      </div>`

  return `
    <div style="padding:16px;">
      <h2 style="margin:0 0 12px 0;color:#fff;">云效流水线列表</h2>
      ${renderPipelineSearchBar(searchId)}
      <div style="margin-bottom:16px;color:#9CA3AF;font-size:13px; display:flex; justify-content:space-between;align-items:center;">
        <div>${hint}</div>
        <button data-action="refresh-list">刷新</button>
      </div>
      ${tableBody}
      ${searchId == null ? renderPipelineListPagination(resolvedPageInfo, pipelines.length) : ''}
    </div>`
}

function renderEnvStageRows(stages: PipelineRunStage[]) {
  return stages.map(stage => {
    const jobs = stage.stageInfo?.jobs || []
    const jobHtml = jobs.length
      ? jobs.map(job => `
          <div class="env-job-item">
            <span>${escapeHtml(job.name)}</span>
            ${renderPipelineStatusBadge(job.status)}
          </div>`).join('')
      : '<div class="env-job-item"><span style="color:#6B7280;">暂无任务</span></div>'

    return `
      <div class="env-stage-item">
        <div class="env-stage-head">
          <strong>${escapeHtml(stage.name)}</strong>
          ${renderPipelineStatusBadge(stage.stageInfo?.status || 'UNKNOWN')}
        </div>
        <div class="env-job-list">${jobHtml}</div>
      </div>`
  }).join('')
}

function resolveCheckpointButtonLabel(
  checkpoint: PipelineCheckpointBlock,
  passMode: CheckpointPassMode | undefined,
  actionJob?: PipelineRunJob
) {
  const actionEnv = actionJob ? inferJobTargetEnv(actionJob) : undefined
  const targetLabel = actionEnv ? envLabel(actionEnv) : checkpoint.targetLabel
  if (passMode === 'start_job') return `开始部署 → ${targetLabel}`
  if (passMode === 'resume_deploy') return `继续部署 → ${targetLabel}`
  return `放行 → ${targetLabel}`
}

function renderCheckpointBlock(checkpoint: PipelineCheckpointBlock) {
  const actionJob = checkpoint.actionJob
  const passMode = checkpoint.passMode || (actionJob ? 'validate' : undefined)
  const buttonLabel = resolveCheckpointButtonLabel(checkpoint, passMode, actionJob)

  const canPassValidate = actionJob && canPassCheckpoint(actionJob)
  const canStart = actionJob && (
    (passMode === 'start_job' && isManualDeployAwaiting(actionJob))
    || (passMode === 'resume_deploy' && isManualDeployAwaiting(actionJob))
    || canStartJobAction(actionJob)
  )
  const hasValidateButDisabled = actionJob && passMode === 'validate' && hasValidateAction(actionJob) && !canPassValidate
  const canTryPass = actionJob && passMode === 'validate' && !hasValidateAction(actionJob) && isNamedManualValidateJob(actionJob)
  
  const buttonHtml = checkpoint.active && actionJob && (canPassValidate || canStart || canTryPass)
    ? `<button type="button" class="btn-release" data-action="pass-checkpoint" data-job-id="${actionJob.id}">${escapeHtml(buttonLabel)}</button>`
    : checkpoint.active && hasValidateButDisabled
      ? '<span class="checkpoint-hint">等待审批（当前账号可能无权限）</span>'
      : checkpoint.active
        ? `<span class="checkpoint-hint">检测到待操作节点${actionJob ? `（${escapeHtml(actionJob.name)}#${actionJob.id}）` : ''}，请刷新后重试</span>`
        : '<span class="checkpoint-hint checkpoint-done">卡点已处理</span>'

  return `
    <div class="checkpoint-block ${checkpoint.active ? 'checkpoint-block-active' : ''}">
      <div class="checkpoint-title">
        <span class="checkpoint-icon">⏸</span>
        <span>${escapeHtml(checkpoint.stageName)}</span>
        ${renderPipelineStatusBadge(checkpoint.stageStatus)}
      </div>
      <div class="checkpoint-action">${buttonHtml}</div>
    </div>`
}

function renderPipelineDetailContent(detail: PipelineDetailView) {
  console.log('--------renderPipel1ineDetailContent', detail)
  const run = detail.latestRun
  const layout = detail.layout
  const envInfo = detail.envInfo || {}

  let runSection = '<div style="padding:12px 0;color:#9CA3AF;">暂无运行记录。</div>'
  if (run && layout) {
    console.log('--------layout', layout.flowBlocks)
    const envBlocks = layout.flowBlocks.map(block => {
      if (block.kind === 'checkpoint') {
        return renderCheckpointBlock(block.checkpoint)
      }
      const group = block.group
      return `
        <section class="env-block env-block-${group.key}">
          <div class="env-block-header">
            <div class="env-block-title">
              <span class="env-block-name">${escapeHtml(group.label)}</span>
              ${renderEnvCell({ branch: group.branch || envInfo[group.key]?.branch })}
            </div>
            ${renderPipelineStatusBadge(group.status)}
          </div>
          <div class="env-block-body">${renderEnvStageRows(group.stages)}</div>
        </section>`
    })

    runSection = `
      <div class="run-panel">
        <div class="run-panel-header">
          <h3>最近运行 #${run.pipelineRunId}</h3>
          ${renderPipelineStatusBadge(run.status)}
        </div>
        ${renderEnvDeployHeader(envInfo)}
        <div class="deploy-flow">${envBlocks.join('')}</div>
      </div>`
  } else if (run) {
    runSection = `
      <div class="run-panel">
        <div class="run-panel-header">
          <h3>最近运行 #${run.pipelineRunId}</h3>
          ${renderPipelineStatusBadge(run.status)}
        </div>
        ${renderEnvDeployHeader(envInfo)}
        <div style="padding:12px 0;color:#9CA3AF;">未能识别部署环境分组，请检查阶段命名是否包含「内网 / 预发 / 正式 / 卡点」。</div>
      </div>`
  }

  return `
    <div style="padding:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;">
        <div>
          <button type="button" class="btn-secondary" data-action="back-list">← 返回列表</button>
          <button type="button" class="btn-secondary" style="margin-left:8px;" data-action="refresh-detail">刷新</button>
        </div>
      </div>
      <h2 style="margin:0 0 12px 0;color:#fff;">${escapeHtml(detail.pipelineName)}</h2>
      <div style="margin-bottom:12px;color:#9CA3AF;font-size:13px;">流水线 ID：${detail.pipelineId}${detail.envName ? ` · ${escapeHtml(detail.envName)}` : ''}</div>
      ${runSection}
    </div>`
}

function getPipelinePanelShell() {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
      body { font-family: Segoe UI, sans-serif; margin: 0; background: #0B1220; color: #E5E7EB; }
      .pipeline-row { cursor: pointer; transition: background .15s ease; }
      .pipeline-row:hover { background: #1E293B; }
      .pipeline-row-waiting { background: rgba(245, 158, 11, 0.12); border-left: 3px solid #F59E0B; cursor: pointer; }
      .pipeline-row-waiting:hover { background: rgba(245, 158, 11, 0.2); }
      .pipeline-row td { padding: 12px 16px; border-bottom: 1px solid #1F2937; }
      .badge-waiting { display: inline-block; padding: 3px 10px; border-radius: 999px; background: #78350F; color: #FCD34D; font-size: 12px; font-weight: 600; }
      .link-text { color: #93C5FD; }
      .branch-tag { display: inline-block; padding: 2px 8px; border-radius: 6px; background: #1E293B; color: #A5F3FC; font-size: 12px; }
      .branch-empty { color: #6B7280; }
      .env-cell { display: flex; flex-direction: column; gap: 4px; min-width: 120px; }
      .env-cell-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .env-cell-label { color: #6B7280; font-size: 11px; min-width: 28px; }
      button { cursor: pointer; border: none; border-radius: 6px; font-size: 12px; padding: 6px 10px; }
      .btn-link { background: #2563EB; color: #fff;margin-left: 6px; cursor: pointer; font-size: 12px; padding: 4px 10px; border-radius: 6px; }
      .btn-secondary { background: #334155; color: #E5E7EB; }
      .btn-release { background: linear-gradient(135deg, #059669, #10B981); color: #fff; padding: 10px 18px; font-size: 14px; font-weight: 600; box-shadow: 0 8px 24px rgba(16, 185, 129, 0.25); }
      .run-panel { margin-top: 8px; padding: 16px; border: 1px solid #334155; border-radius: 12px; background: #0F172A; }
      .run-panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
      .run-panel-header h3 { margin: 0; color: #fff; font-size: 16px; }
      .env-branch-bar { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 16px; }
      .env-branch-item { padding: 10px 12px; border-radius: 10px; background: #111827; border: 1px solid #1F2937; text-align: center; }
      .env-branch-label { display: block; color: #9CA3AF; font-size: 12px; margin-bottom: 6px; }
      .env-intranet { border-color: rgba(59, 130, 246, 0.35); }
      .env-pre { border-color: rgba(245, 158, 11, 0.35); }
      .env-prod { border-color: rgba(239, 68, 68, 0.35); }
      .deploy-flow { display: flex; flex-direction: column; gap: 12px; }
      .env-block { border-radius: 12px; overflow: hidden; border: 1px solid #334155; background: #111827; }
      .env-block-intranet { border-left: 4px solid #3B82F6; }
      .env-block-pre { border-left: 4px solid #F59E0B; }
      .env-block-prod { border-left: 4px solid #EF4444; }
      .env-block-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: rgba(255,255,255,0.02); border-bottom: 1px solid #1F2937; }
      .env-block-title { display: flex; align-items: center; gap: 10px; }
      .env-block-name { font-size: 16px; font-weight: 700; color: #fff; }
      .env-block-body { padding: 12px 16px; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
      .env-stage-item { padding: 10px 12px; border-radius: 8px; background: #0B1220; border: 1px solid #1F2937; }
      .env-stage-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
      .env-job-list { display: flex; flex-direction: column; gap: 6px; }
      .env-job-item { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; color: #CBD5E1; }
      .checkpoint-block { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 16px; border-radius: 12px; border: 1px dashed #475569; background: rgba(15, 23, 42, 0.8); }
      .checkpoint-block-active { border-color: #F59E0B; background: rgba(245, 158, 11, 0.08); box-shadow: inset 0 0 0 1px rgba(245, 158, 11, 0.15); }
      .checkpoint-title { display: flex; align-items: center; gap: 10px; color: #FCD34D; font-weight: 600; }
      .checkpoint-icon { font-size: 16px; }
      .checkpoint-hint { color: #9CA3AF; font-size: 12px; }
      .checkpoint-done { color: #6B7280; }
      button:disabled { opacity: .6; cursor: not-allowed; }
      .search-input { width: 220px; padding: 6px 10px; border-radius: 6px; border: 1px solid #334155; background: #0F172A; color: #E5E7EB; font-size: 13px; outline: none; }
      .search-input:focus { border-color: #2563EB; }
      .search-input::placeholder { color: #6B7280; }
      .pagination-bar { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 16px; padding-top: 16px; border-top: 1px solid #1F2937; }
      .pagination-info { color: #9CA3AF; font-size: 13px; min-width: 220px; text-align: center; }
    </style>
  </head>
  <body>
    <div id="app"><div style="padding:16px;color:#D1D5DB;">正在加载流水线...</div></div>
    <script>
      (function () {
        const vscode = acquireVsCodeApi();
        const app = document.getElementById('app');

        function replacePipelineRow(pipelineId, rowHtml) {
          const tbody = document.getElementById('sym-pipelines');
          if (!tbody) return;
          const row = tbody.querySelector('tr[data-pipeline-id="' + pipelineId + '"]');
          if (!row) return;
          const template = document.createElement('template');
          template.innerHTML = rowHtml.trim();
          const nextRow = template.content.firstElementChild;
          if (!nextRow) return;
          row.replaceWith(nextRow);
        }

        window.addEventListener('message', function (event) {
          const message = event.data;
          if (!message) return;
          if (message.type === 'render' && app) {
            app.innerHTML = message.content;
            return;
          }
          if (message.type === 'updateRow' && message.pipelineId && message.rowHtml) {
            replacePipelineRow(message.pipelineId, message.rowHtml);
          }
        });

        function submitPipelineSearch() {
          const input = document.getElementById('pipeline-search-input');
          const value = input ? input.value.trim() : '';
          if (!value) return;
          vscode.postMessage({ command: 'searchById', searchValue: value });
        }

        document.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' && event.target && event.target.id === 'pipeline-search-input') {
            submitPipelineSearch();
          }
        });

        function findActionTarget(start) {
          let node = start;
          while (node && node !== document.body) {
            if (node.dataset && node.dataset.action) return node;
            node = node.parentElement;
          }
          return null;
        }

        document.addEventListener('click', function (event) {
          const target = findActionTarget(event.target);
          if (!target) return;

          const action = target.dataset.action;
          if (action === 'view-detail') {
            const pipelineId = Number(target.dataset.pipelineId);
            if (!pipelineId) return;
            vscode.postMessage({ command: 'viewDetail', pipelineId });
            return;
          }
          if (action === 'view-branch') {
            const pipelineId = Number(target.dataset.pipelineId);
            if (!pipelineId) return;
            vscode.postMessage({ command: 'viewBranch', pipelineId });
            return;
          }
          if (action === 'back-list') {
            vscode.postMessage({ command: 'backToList' });
            return;
          }
          if (action === 'refresh-detail') {
            vscode.postMessage({ command: 'refreshDetail' });
            return;
          }
          if (action === 'refresh-list') {
            vscode.postMessage({ command: 'refreshList' });
            return;
          }
          if (action === 'page-prev' || action === 'page-next') {
            if (target.disabled) return;
            const page = Number(target.dataset.page);
            if (!page || page < 1) return;
            vscode.postMessage({ command: 'goToPage', page: page });
            return;
          }
          if (action === 'search-by-id') {
            submitPipelineSearch();
            return;
          }
          if (action === 'clear-search') {
            vscode.postMessage({ command: 'clearPipelineSearch' });
            return;
          }
          if (action === 'pass-checkpoint') {
            const jobId = Number(target.dataset.jobId);
            if (!jobId) return;
            vscode.postMessage({ command: 'passCheckpoint', jobId });
          }
        });
      })();
    </script>
  </body>
  </html>`
}




function isYunxiaoCenterEdition(rawDomain: string) {
  return normalizeUrl(rawDomain).toLowerCase().includes('openapi-rdc.aliyuncs.com')
}

function buildYunxiaoFlowBaseUrl(apiOrigin: string, organizationId?: string) {
  if (organizationId) {
    return `${apiOrigin}/oapi/v1/flow/organizations/${encodeURIComponent(organizationId)}`
  }
  return `${apiOrigin}/oapi/v1/flow`
}


function parsePipelineListPageInfo(
  response: Response,
  page: number,
  perPage: number,
  itemCount: number
): PipelineListPageInfo {
  const headerPage = Number(response.headers.get('x-page'))
  const headerPerPage = Number(response.headers.get('x-per-page'))
  const headerTotal = Number(response.headers.get('x-total'))
  const headerTotalPages = Number(response.headers.get('x-total-pages'))

  const resolvedPage = Number.isFinite(headerPage) && headerPage > 0 ? headerPage : page
  const resolvedPerPage = Number.isFinite(headerPerPage) && headerPerPage > 0 ? headerPerPage : perPage
  const resolvedTotal = Number.isFinite(headerTotal) && headerTotal >= 0 ? headerTotal : 0
  const resolvedTotalPages = Number.isFinite(headerTotalPages) && headerTotalPages > 0
    ? headerTotalPages
    : (itemCount < resolvedPerPage ? resolvedPage : 0)

  return {
    page: resolvedPage,
    perPage: resolvedPerPage,
    total: resolvedTotal,
    totalPages: resolvedTotalPages
  }
}

async function fetchPipelineList(baseUrl: string, token: string, page: number, perPage: number): Promise<PipelineListResult> {
  const url = `${baseUrl}/pipelines?page=${page}&perPage=${perPage}`
  const response = await fetchWithDebug(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-yunxiao-token': token
    }
  })
  if (!response.ok) {
    const body = await response.text()
    if (response.status === 404) {
      throw new Error(
        `HTTP 404: ${body}\n\n` +
        '常见原因：\n' +
        '1. 中心站（openapi-rdc.aliyuncs.com）必须配置 organizationId；\n' +
        '2. Region 站请使用组织专属域名（如 https://your-org.devops.aliyuncs.com）；\n' +
        '3. token 权限不足或已过期。'
      )
    }
    throw new Error(`HTTP ${response.status}: ${body}`)
  }
  const pipelines = await response.json() as Array<{ pipelineId: number; pipelineName: string; createAccountId: string; createTime: number }>
  return {
    pipelines,
    pageInfo: parsePipelineListPageInfo(response, page, perPage, pipelines.length)
  }
}

function formatPipelineLoadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return `加载失败：${escapeHtml(message).replace(/\n/g, '<br/>')}`
}
