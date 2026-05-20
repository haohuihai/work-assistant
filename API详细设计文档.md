# Swagger Helper Pro 技术文档（API 详细设计）

## 1. 项目定位

`Swagger Helper Pro` 是一个 Cursor/VSCode 插件，用于：

- 拉取远程 Swagger/OpenAPI 文档；
- 在侧边栏按项目管理接口列表；
- 通过关键词快速检索路由；
- 以可读 JSON 形式查看接口请求/响应结构。

该项目不是传统后端服务，因此“API”分为两层：

1. **插件命令 API（对 IDE 用户开放）**：通过命令面板、视图工具栏、右键菜单触发；
2. **外部文档 API（对远程 Swagger 服务调用）**：通过 HTTP GET 获取 OpenAPI JSON 或 Swagger UI 页面并解析。

---

## 2. 技术栈与模块结构

### 2.1 技术栈

- 运行环境：VS Code Extension Host
- 语言：TypeScript
- 依赖：
  - `vscode`：扩展 API
  - `axios`：HTTP 请求

### 2.2 模块划分（当前版本）

当前核心逻辑集中在 `src/extension.ts`，模块职责可逻辑划分为：

- **激活与命令注册层**：`activate()`
- **视图数据层**：`SwaggerTreeProvider`
- **领域模型层**：`ProjectItem`、`ApiItem`
- **Swagger 解析层**：`loadSwaggerDoc()`、`tryGetSwaggerJson()`、`resolveSwaggerJsonUrlFromHtml()`
- **Schema 转换层**：`schemaToJson()`、`buildRequestJson()`、`buildResponseJson()`
- **展示层**：`openApiDetail()`、`getDetailHtml()`

---

## 3. 数据模型设计

### 3.1 ApiItem

用于描述单个接口条目：

- `path: string`：路由路径，如 `/user/login`
- `method: string`：HTTP 方法（`get/post/...`）
- `reqJson: any`：解析后的请求结构（附带字段元信息）
- `resJson: any`：解析后的响应结构（附带字段元信息）

### 3.2 ProjectItem

用于描述一个 Swagger 项目：

- `id: string`：项目唯一标识
- `title: string`：项目标题（可重命名）
- `url: string`：Swagger 原始入口地址
- `apis: ApiItem[]`：项目下接口清单
- `updatedAt: number`：更新时间戳

### 3.3 本地存储

- 存储键：`swaggerHelper.projects`
- 介质：`context.globalState`
- 内容：`ProjectItem[]`

---

## 4. 插件命令 API 详细设计

> 下文将“命令 ID”视为插件对外 API。

### 4.1 `swaggerHelper.openUI`

- **用途**：打开“添加项目”流程。
- **入口**：命令面板。
- **参数**：无。
- **内部流程**：
  1. 调用 `addProject(provider)`；
  2. 输入 URL，拉取并解析 Swagger；
  3. 写入本地项目列表，刷新树视图。
- **成功结果**：提示“已保存项目：xxx”。
- **异常结果**：提示“拉取失败：...”

### 4.2 `swaggerHelper.addProject`

- **用途**：与 `openUI` 同功能，作为视图工具栏入口。
- **入口**：工作视图标题栏按钮。
- **参数/结果**：同 `openUI`。

### 4.3 `swaggerHelper.searchRequests`

- **用途**：按关键字过滤接口列表。
- **参数**：用户输入关键字（支持 `method + path` 模糊匹配）。
- **匹配规则**：
  - 将接口转为 `"{method} {path}"` 小写字符串；
  - 执行 `includes(keyword)`。
- **结果**：
  - 非空关键字：启用过滤并提示；
  - 空字符串：视为清空过滤。

### 4.4 `swaggerHelper.clearSearch`

- **用途**：清空过滤条件。
- **参数**：无。
- **结果**：恢复显示全部接口并提示“已清空搜索”。

### 4.5 `swaggerHelper.renameProject`

- **用途**：修改项目标题。
- **调用上下文**：项目节点右键/内联菜单。
- **输入**：`ProjectNode`（由 UI 上下文传入）。
- **规则**：
  - 空标题不生效；
  - 仅更新匹配 `project.id` 的目标项。

### 4.6 `swaggerHelper.refreshProject`

- **用途**：根据原 URL 重新拉取文档并刷新接口快照。
- **调用上下文**：项目节点右键/内联菜单。
- **输入**：`ProjectNode`。
- **流程**：
  1. 依据 `project.id` 定位项目；
  2. 调用 `buildProjectByUrl(target.url, target.id, target.title)`；
  3. 覆盖旧数据并刷新视图。

### 4.7 `swaggerHelper.openApiDetail`

- **用途**：打开接口详情 Webview。
- **输入**：
  - `project: ProjectItem`
  - `api: ApiItem`
- **输出**：右侧详情面板，展示 Request/Response JSON。

### 4.8 `swaggerHelper.lookupRoute`

- **用途**：一次性按路由查找接口并展示详情（不落库存储）。
- **交互输入**：
  1. Swagger 地址；
  2. 路由关键字。
- **流程**：
  1. `loadSwaggerDoc(url)` 拉取文档；
  2. `findApis(swagger, routeInput)` 检索匹配项；
  3. 单结果直接展示，多结果通过 `pickApi()` 选择；
  4. 调用 `buildRequestJson`/`buildResponseJson` 构建详情；
  5. `openApiDetail()` 打开页面。

---

## 5. 外部 HTTP API（Swagger 文档源）设计

## 5.1 请求方式

- HTTP Method：`GET`
- 请求客户端：`axios`
- 超时：`12000ms`

### 5.2 地址解析策略（`loadSwaggerDoc`）

按优先级三段式回退：

1. **直接 JSON 解析**
   - 假设输入就是 `/v2/api-docs`、`/v3/api-docs` 等；
   - 条件：响应对象包含 `openapi` 或 `swagger` 且包含 `paths`。

2. **HTML 页面反向解析**
   - 当输入为 `index.html`/`swagger-ui.html` 时，先拉 HTML；
   - 用正则提取 `url`/`swaggerUrl`/`?url=` 参数；
   - 转换为绝对地址后再次尝试 JSON 拉取。

3. **默认候选路径兜底**
   - 全局候选：
     - `/v3/api-docs`
     - `/v2/api-docs`
     - `/swagger/v1/swagger.json`
     - `/openapi.json`
   - 局部候选：在输入 URL 的同级目录拼接上述路径。

若都失败，抛错：`无法从该地址解析 Swagger 文档`。

### 5.3 URL 处理规则

- `normalizeUrl(raw)`：去空格与空白字符；
- `splitUrl(raw)`：拆分 `origin` 与 `path`；
- `toAbsoluteUrl(baseUrl, maybeRelativeUrl)`：
  - 若已是 `http(s)` 绝对地址，原样返回；
  - 若是 `/xxx`，拼 `origin + path`；
  - 若是相对路径，拼到当前目录。

---

## 6. Schema 到 JSON 示例化设计

### 6.1 目标

把 OpenAPI schema 转换为可读 JSON，便于接口阅读与联调前置分析，并保留字段元信息（类型、必填、描述、示例等）。

### 6.2 规则矩阵（`schemaToJson`）

- `$ref`：递归解析引用（`#/components/schemas/...`）
- `oneOf/anyOf`：取第一个分支
- `allOf`：对象字段合并
- `object`：
  - 遍历 `properties`
  - 对 `required` 字段打 `required: true`
  - 若对象本身有描述，写入 `__description`
- `array`：
  - 常规返回 `[itemSchema]`
  - 有描述时返回带 `__type: "array"` 的结构化对象
- 叶子字段：
  - 生成 `value`（类型默认值）
  - 生成 `type`（含 format）
  - 可附带 `description/nullable/default/example`

### 6.3 请求结构构建（`buildRequestJson`）

组合两个来源：

1. `parameters`（query/path/header/cookie）
   - 字段名使用 `p.name`
   - 元信息补充 `in/description/required`
2. `requestBody.content`
   - 优先 `application/json`
   - 其次取第一个 content 类型
   - 最终写入 `req.body`

### 6.4 响应结构构建（`buildResponseJson`）

- 状态码优先级：`200` > `201` > `default` > 首个可用
- `content` 优先 `application/json`，否则首个类型
- 输出结构：
  - `status`
  - `body`（经 `schemaToJson` 转换）

---

## 7. 视图与交互设计

### 7.1 TreeView 结构

- 根节点：项目（`ProjectNode`）
- 子节点：接口（`ApiNode`）
- 节点图标：
  - 项目：`folder-library`
  - 接口：`symbol-method`

### 7.2 搜索过滤

- 过滤状态保存在 `SwaggerTreeProvider.keyword`
- 仅影响项目下接口子节点，不影响项目节点可见性

### 7.3 详情页 Webview

- 单例面板复用（`detailPanel`）
- 点击不同接口时仅更新标题与 HTML 内容，避免重复开面板
- 脚本禁用（`enableScripts: false`），降低安全风险

---

## 8. 异常与边界处理

- 网络错误、超时：统一由调用层 catch 并弹窗提示
- 文档非 OpenAPI/Swagger 格式：按“解析失败”处理
- 用户取消输入框：直接 return，不报错
- 路由检索无匹配：`showWarningMessage`
- 多匹配路由：`QuickPick` 选择
- 项目节点不存在（并发/状态漂移）：安全 return

---

## 9. 性能与可维护性说明

- 当前为单文件实现，功能集中，便于快速迭代；
- 每次刷新会重建目标项目接口快照，复杂度约 `O(paths * methods)`；
- 搜索在内存中执行，速度取决于当前项目接口数量；
- 建议后续拆分目录：
  - `services/swagger.ts`
  - `services/schema.ts`
  - `ui/treeProvider.ts`
  - `ui/detailWebview.ts`
  - `commands/*.ts`

---

## 10. 对外“使用 API”示例（用户操作视角）

### 场景 A：添加并查看项目

1. 执行命令 `Swagger: 添加项目`
2. 输入 Swagger 地址（支持 UI 页面或 JSON 地址）
3. 侧边栏展示项目和路由列表
4. 点击接口节点打开详情（Request/Response）

### 场景 B：快速按路由定位

1. 执行命令 `Swagger: Lookup Route JSON`
2. 输入 Swagger 地址
3. 输入路由关键词（例如 `/user/login` 或 `post /user`）
4. 若多项命中，选择目标接口
5. 打开详情页面查看 JSON 结构

---

## 11. 版本与兼容性

- 当前版本：`0.0.2`
- VS Code Engine：`^1.80.0`
- TypeScript：`^5.0.0`

---

## 12. 后续扩展建议（API 设计层面）

- 增加鉴权支持（Bearer Token/Basic Auth）用于私有文档拉取；
- 支持导出接口详情为 Markdown/JSON 文件；
- 支持按 tag、operationId 分组展示；
- 增加请求示例生成策略（结合 `example/examples` 优先级）；
- 引入 OpenAPI 3.1 特性处理（`jsonSchemaDialect` 等）。


# 测试数据
"swaggerHelperApiTest": [
        {
          "id": "swaggerHelper.apiTestPage",
          "name": "API 测试",
          "type": "webview"
        },
        {
          "id": "swaggerHelper.apiTestTreeView",
          "name": "createTreeView"
        },
        {
          "id": "swaggerHelper.apiTestDataView",
          "name": "registerTreeDataProvider"
        }
      ]


      ,
        {
          "id": "swaggerHelperApiTest",
          "title": "API测试",
          "icon": "resources/work.svg"
        }