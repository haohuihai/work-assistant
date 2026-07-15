import * as vscode from 'vscode'
import { buildRequestMock, buildResponseMock } from './swaggerDoc'
import type { ApiItem, ProjectItem } from './swaggerTypes'
import { escapeHtml } from './utils'

let detailPanel: vscode.WebviewPanel | undefined

export function openApiDetail(project: ProjectItem, api: ApiItem) {
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
