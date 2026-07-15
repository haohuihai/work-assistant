import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fetchWithDebug } from './httpDebug';

const execFileAsync = promisify(execFile);

const MAX_DIFF_CHARS = 80_000;
const DEFAULT_QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_QWEN_MODEL = 'qwen-plus';

type AiReviewResult = {
  pass: boolean;
  summary: string;
  detail: string;
};

type AiReviewPayload = {
  pass?: boolean;
  summary?: string;
  blockers?: string[];
  warnings?: string[];
  typos?: string[];
};

export function activateGitReview(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('swaggerHelper.aiCheckAndCommit', aiCheckAndCommit),
    vscode.commands.registerCommand('swaggerHelper.installCommitGuardHook', installCommitGuardHook)
  );
}

async function aiCheckAndCommit() {
  const repo = await getSelectedGitRepository();
  if (!repo) {
    vscode.window.showWarningMessage('没有找到当前 Git 仓库');
    return;
  }

  const repoRoot = repo.rootUri.fsPath;
  const message = repo.inputBox.value?.trim();

  if (!message) {
    vscode.window.showWarningMessage('请先填写 commit message');
    return;
  }

  const stagedDiff = await git(repoRoot, ['diff', '--cached', '--unified=0']);

  if (!stagedDiff.trim()) {
    vscode.window.showWarningMessage('没有 staged 的改动，请先 stage 文件');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: '正在进行 AI 提交前校验...',
      cancellable: false
    },
    async () => {
      const result = await runAiReview(stagedDiff);

      if (!result.pass) {
        const choice = await vscode.window.showErrorMessage(
          `AI 校验未通过：${result.summary}`,
          '查看详情',
          '仍然提交'
        );

        if (choice === '查看详情') {
          const doc = await vscode.workspace.openTextDocument({
            language: 'markdown',
            content: result.detail
          });
          await vscode.window.showTextDocument(doc);
          return;
        }

        if (choice !== '仍然提交') {
          return;
        }
      } else {
        vscode.window.showInformationMessage(`AI 校验通过：${result.summary}`);
      }

      await repo.commit(message, { noVerify: false });
      vscode.window.showInformationMessage('提交完成');
    }
  );
}

async function getSelectedGitRepository(): Promise<any | undefined> {
  const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
  const gitApi = gitExtension?.getAPI(1);

  if (!gitApi?.repositories?.length) {
    return undefined;
  }

  return gitApi.repositories.find((r: any) => r.ui?.selected) ?? gitApi.repositories[0];
}

async function installCommitGuardHook() {
  const repo = await getSelectedGitRepository();

  if (!repo) {
    vscode.window.showWarningMessage('没有找到当前 Git 仓库');
    return;
  }

  const repoRoot = repo.rootUri.fsPath;
  const hooksDir = path.join(repoRoot, '.githooks');
  const hookFile = path.join(hooksDir, 'pre-commit');

  const guardScriptPath =
    'C:/Users/admin/plugins/commit-code-guard/scripts/commit_guard_scan.py';

  const hookContent = `#!/bin/sh

REPO_ROOT="$(git rev-parse --show-toplevel)"

python "${guardScriptPath}" --repo "$REPO_ROOT" --staged
SCAN_STATUS=$?

git diff --cached --check
DIFF_CHECK_STATUS=$?

if [ "$SCAN_STATUS" -ne 0 ] || [ "$DIFF_CHECK_STATUS" -ne 0 ]; then
  echo ""
  echo "Commit Code Guard failed."
  echo "Please fix blockers before committing."
  echo "If you intentionally want to bypass this check, use:"
  echo "  git commit --no-verify"
  exit 1
fi

exit 0
`;

  try {
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(hookFile, hookContent, 'utf8');

    // Windows 下 chmod 不是必须，但在 macOS/Linux 下需要可执行权限。
    if (process.platform !== 'win32') {
      await fs.chmod(hookFile, 0o755);
    }

    await git(repoRoot, ['config', 'core.hooksPath', '.githooks']);

    vscode.window.showInformationMessage(
      'Commit Code Guard Hook 已安装，之后提交前会自动校验。'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`安装 Commit Guard Hook 失败：${message}`);
  }
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function runAiReview(diff: string): Promise<AiReviewResult> {
  const truncatedDiff =
    diff.length > MAX_DIFF_CHARS
      ? `${diff.slice(0, MAX_DIFF_CHARS)}\n\n...[diff truncated]...`
      : diff;

  const prompt = `你是代码提交前审查助手。请审查下方 staged diff，重点检查：
1. 是否存在假数据、mock 数据、placeholder
2. 是否阻断程序执行
3. 是否有明显语法错误
4. 是否有错别字
5. 是否有可疑代码块

只返回一个 JSON 对象，不要 Markdown 代码块，不要其他解释。格式：
{"pass":true,"summary":"一句话摘要","blockers":[],"warnings":[],"typos":[]}

规则：
- 发现会阻断合并/运行的问题（假数据提交、语法错误、明显 bug）时 pass=false，并写入 blockers
- 仅有风格或低风险问题时 pass=true，写入 warnings
- typos 列出错别字

diff:
${truncatedDiff}`;

  try {
    const raw = await askQwen(prompt);
    return parseAiReviewResponse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      pass: false,
      summary: `AI 调用失败：${message}`,
      detail: `AI 调用失败：${message}\n\n请在设置中配置 swaggerHelper.qwen.apiKey（阿里云百炼 API Key）。`
    };
  }
}

function getQwenConfig() {
  const config = vscode.workspace.getConfiguration('swaggerHelper.qwen');
  const apiKey = (config.get<string>('apiKey') || '').trim();
  const baseUrl = (config.get<string>('baseUrl') || DEFAULT_QWEN_BASE_URL).trim().replace(/\/+$/, '');
  const model = (config.get<string>('model') || DEFAULT_QWEN_MODEL).trim();
  return { apiKey, baseUrl, model };
}

async function askQwen(prompt: string): Promise<string> {
  const { apiKey, baseUrl, model } = getQwenConfig();
  if (!apiKey) {
    throw new Error('未配置千问 API Key，请填写设置项 swaggerHelper.qwen.apiKey');
  }

  const response = await fetchWithDebug(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: '你是严谨的代码提交前审查助手，只输出合法 JSON，不要输出 Markdown 或其他说明。'
        },
        { role: 'user', content: prompt }
      ]
    })
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`千问 API HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
  }

  let data: any;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`千问 API 返回非 JSON：${bodyText.slice(0, 500)}`);
  }

  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(`千问 API 返回内容为空：${bodyText.slice(0, 500)}`);
  }

  return text;
}

function parseAiReviewResponse(raw: string): AiReviewResult {
  const payload = extractJsonObject(raw) as AiReviewPayload | undefined;

  if (!payload || typeof payload.pass !== 'boolean') {
    return {
      pass: false,
      summary: 'AI 返回格式无效',
      detail: raw
    };
  }

  const blockers = Array.isArray(payload.blockers) ? payload.blockers : [];
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  const typos = Array.isArray(payload.typos) ? payload.typos : [];
  const pass = payload.pass && blockers.length === 0;
  const summary = payload.summary?.trim() || (pass ? '未发现阻断项' : '存在阻断项');

  const detailParts = [
    `## 结论\n${pass ? '通过' : '未通过'} — ${summary}`,
    blockers.length ? `## Blockers\n${blockers.map(i => `- ${i}`).join('\n')}` : '',
    warnings.length ? `## Warnings\n${warnings.map(i => `- ${i}`).join('\n')}` : '',
    typos.length ? `## Typos\n${typos.map(i => `- ${i}`).join('\n')}` : '',
    `## Raw\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``
  ].filter(Boolean);

  return {
    pass,
    summary,
    detail: detailParts.join('\n\n')
  };
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // ignore
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // ignore
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // ignore
    }
  }

  return undefined;
}
