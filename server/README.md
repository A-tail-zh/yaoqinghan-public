# 邀请函后端与管理后台

本项目使用 Node.js、Express、MySQL 和独立的 Vue 3 + Element Plus 管理后台。H5 已接入公开配置、素材和回执接口，手机预览使用运行电脑的局域网地址与 H5 服务端口。

## 本机启动

使用 MySQL 8，按 `server/.env.example` 配置实际地址、端口、数据库和专用用户。真实连接配置仅保存在本机 `server/.env`。管理员账号由 `ADMIN_USERNAME` 配置，凭据由本机私密保管。

首次安装先将 `.env.example` 复制为 `.env`，创建数据库与专用用户并填写连接信息。下面的命令在本机生成随机管理员密码、密码哈希及会话密钥；将哈希和密钥写入 `.env`，明文密码只存入本机密码管理器。仓库不附带可登录的默认密码。

```powershell
node --input-type=module -e 'import { randomBytes, scryptSync } from "node:crypto"; const password = randomBytes(24).toString("base64url"); const salt = randomBytes(16).toString("hex"); console.log("ADMIN_PASSWORD=" + password); console.log("ADMIN_PASSWORD_HASH=" + salt + ":" + scryptSync(password, salt, 64).toString("hex")); console.log("SESSION_SECRET=" + randomBytes(32).toString("hex"));'
```

```powershell
cd server
npm.cmd ci
npm.cmd run migrate
npm.cmd start
```

管理后台打开 `http://127.0.0.1:3080/admin/`，健康检查为 `/api/health`。

```powershell
cd admin
npm.cmd ci
npm.cmd run build
```

后台开发使用 `npm.cmd run dev`，端口 5189，`/api` 代理到 3080。后台保存、上传和发布通过同源请求访问 API。生产反向代理的实际 HTTPS origin 必须添加到 `ALLOWED_ORIGINS`。

`server/migrations/001_initial.sql` 创建活动、素材、回执和会话表。`npm run migrate` 可重复执行并保留已有数据。当前首版只有这一个迁移，后续 schema 变更应增加独立迁移。

新建数据库后生成通用文字草稿，图片与 BGM 初始为空。登录后台后编辑内容，按需上传有使用及传播授权的素材，再保存并发布。无需导入任何本地原稿。迁移使用 `INSERT IGNORE`，不会覆盖已有活动。实际发布时间与有效期以数据库记录为准，后续发布保留首次发布计算的截止时间。

## 公开接口

统一失败响应为 `{ "error": { "code": "...", "message": "..." } }`。接口和素材均设置 `Cache-Control: no-store`。限流响应为 HTTP 429。日期为 UTC ISO 字符串，前端按北京时间展示。回执 ID 作为字符串处理。

### GET /api/public/invitation

200 返回如下结构。素材 URL 都是同源路径。下例使用文字槽，图片槽结构为 `{ "type": "image", "imageUrl": "/api/public/invitation/assets/素材UUID", "alt": "描述" }`。

```json
{
  "firstPublishedAt": "2026-11-13T08:00:00.000Z",
  "expiresAt": "2027-11-13T08:00:00.000Z",
  "content": {
    "invitation": {
      "brand": {"type": "text", "text": "活动邀请"},
      "title": {"type": "text", "text": "邀请函"},
      "greeting": {"type": "text", "text": "诚挚邀请您莅临"},
      "details": {"type": "text", "text": "活动时间与地点"},
      "backgroundImageUrl": null,
      "leftDoorImageUrl": null,
      "rightDoorImageUrl": null,
      "sealImageUrl": null
    },
    "displayPages": [
      {"id": "agenda", "title": "活动安排", "body": "", "imageUrl": null},
      {"id": "about", "title": "活动介绍", "body": "", "imageUrl": null}
    ],
    "venue": {"title": "活动地点", "name": "酒店名称", "address": "酒店地址", "imageUrl": null},
    "rsvp": {"title": "出席回执", "nameLabel": "姓名", "phoneLabel": "手机号", "partySizeLabel": "出行人数", "submitLabel": "提交"},
    "bgmUrl": null
  }
}
```

未发布返回 `404 INVITATION_NOT_PUBLISHED`，到期返回 `410 INVITATION_EXPIRED`。异常时 H5 应显示重试提示，避免继续显示旧活动内容。

### POST /api/public/invitation/rsvps

请求 `Content-Type: application/json`，并使用 `Idempotency-Key: UUID`。

```json
{"name":"张三","phone":"13800000000","partySize":2}
```

姓名去首尾空格后 1–100 字。电话允许国际前缀、空格、括号及短横线，入库去掉分隔符，数字部分 6–20 位。人数是含本人的正整数，数据库技术范围 1–4294967295。手机号允许多次提交，唯一性由提交键控制。

事务内检查活动开放状态，再写入 MySQL，提交成功返回 `201 {"id":"1"}`。开放期间同键同内容重试返回 `200` 和原 ID，同键不同内容返回 `409 IDEMPOTENCY_CONFLICT`。字段或提交键错误返回 `422 INVALID_RSVP`。到期返回 `410`。数据库异常返回 5xx。

前端提交前把手填人数转成数字，生成一次 `crypto.randomUUID()` 并在请求结果不明确时保留。重试相同内容沿用该键。用户改了内容应生成新键。提交中禁用按钮，失败保留输入，仅收到上述成功响应后弹出“期待您的莅临”。

### GET /api/public/invitation/assets/:id

只允许访问当前发布快照引用的素材，未引用返回 404，到期返回 410。支持音频 Range 请求。草稿素材不公开。

## 管理接口

使用 HttpOnly、SameSite=Strict 会话 Cookie，8 小时有效。会话存 MySQL。每个管理接口检查登录状态，写操作还验证 Origin。生产 HTTPS 设置 `COOKIE_SECURE=true`，反代单层时设置 `TRUST_PROXY=1` 并由代理覆盖转发头。登录失败限流，回执提交按 IP 限流。

| 方法和路径 | 请求及响应 |
| --- | --- |
| POST /api/admin/session | `{username,password}`，成功返回 `{username}` |
| GET /api/admin/session | 返回 `{username}`，未登录 401 |
| DELETE /api/admin/session | 退出，返回 204 |
| GET /api/admin/invitation/draft | 返回 `{revision,content,firstPublishedAt,expiresAt}` |
| PUT /api/admin/invitation/draft | `{revision,content}`，保存并返回新版本草稿 |
| POST /api/admin/invitation/publish | `{revision}`，发布并返回草稿及发布时间 |
| POST /api/admin/assets | multipart 字段 `file`，201 返回 `{id,kind,previewUrl}` |
| GET /api/admin/assets/:id | 认证预览，到期后仍可用 |
| GET /api/admin/rsvps?limit=50&beforeId=123 | `{items:[{id,name,phone,partySize,createdAt}],nextCursor}` |

回执列表支持 `keyword`（姓名或手机号包含关键词）、`minPartySize`、`maxPartySize`、`dateFrom`、`dateTo` 筛选。日期为 `YYYY-MM-DD`，按北京时间包含起止两天。筛选更改后从第一页读取，后续翻页沿用同一组筛选。

响应同时包含字符串字段 `totalPartySize`（全部回执人数合计）、`filteredPartySize`（所有符合筛选条件的回执人数合计）及 `filteredRecords`（符合条件的回执条数）。统计覆盖完整结果，不受分页游标影响。全部人数包含每条回执填报的本人及同行人员。

草稿中素材存 ID。公开字段 `*ImageUrl` 对应管理端 `*ImageId`，`imageUrl` 对应 `imageId`，`bgmUrl` 对应 `bgmId`。图片文字槽使用 `{type:'image',assetId,alt}`。空图片使用 `null`。后台客户端类型定义见 `admin/src/api.ts`。

保存或发布过期版本返回 `409 DRAFT_CONFLICT`，前端提示重新载入。发布检查所有引用素材的类型和磁盘文件。上传支持 JPEG、PNG、WebP（10 MiB）和 MP3（20 MiB），服务端识别文件内容。替换生成新素材 ID，旧发布快照保持可读至再次发布。首版保留旧素材，便于恢复。

展示页按数组顺序渲染，最多 30 页，每页标题最多 100 字、正文最多 3000 字。固定邀请页在前，地点和回执在后。内容作为纯文本呈现，禁止直接插入 HTML。

首次发布按数据库时间写入起点和北京时间日历周年截止时间，2 月 29 日对应次年 2 月 28 日同一时刻。再次发布保留原起止时间。达到截止时间时，公开读取、公开素材、回执提交和重新发布均被拒绝。后台仍可登录、查看历史回执和草稿。

## H5 接入与部署

1. 在 Vite 中将 `/api` 代理到 `http://127.0.0.1:3080`。公开 GET 和回执 POST 使用上述相对路径。
2. 用公开配置驱动四个邀请槽位、装饰图片、展示页顺序、地点信息、回执文案和 BGM。地点 `imageUrl:null` 显示文字占位区域，换图时重置旧的加载失败状态。
3. 表单保存成功后再打开确认弹窗。区分输入错误、提交中、失败和保存成功。
4. 开门点击后尝试播放 BGM，并提供手动启停。手机拒绝自动播放时允许用户再次点击。
5. 根据 `expiresAt` 设置页面到期状态，在恢复可见时重新读取接口。到期后停止音频、清除活动内容、禁止提交。
6. 接入完成并构建后，设置 `H5_DIST_DIR` 为 H5 的绝对构建目录。Express 将对 H5 HTML 和静态文件统一检查发布和到期状态。公开域名整站代理到 Express，后台路径为 `/admin/`。原分享 URL 可沿用。不要另设绕过此检查的 H5 静态站点。

本地 H5 可通过 5188 端口 Vite 服务访问，`/api` 代理到 3080。发布前公开接口返回未发布状态。生产统一托管时需配置 `H5_DIST_DIR`。

生产部署需设置稳定域名、HTTPS、实际 Origin 和持久化 `MEDIA_DIR`。数据库和媒体目录须共同备份，部署时保留 `.env` 与媒体文件。运行进程应由宿主机服务管理器接管。

## 验证命令

```powershell
cd server
npm.cmd test
node --env-file=.env.test --test integration.test.js
cd '..\admin'
npm.cmd run build
```

真实数据库测试使用独立 `invitation_h5_test`，测试会清理这个测试库的测试表。业务库 `invitation_h5` 保留现有内容。普通 `npm test` 默认不运行数据库集成测试。测试密码文件 `.env.test` 仅本机使用。

联调需观察成功提交对应一条数据库记录，超时重试和并发同键保持一条，非法数据和到期提交零新增，管理员分页查看历史回执。还需用手机实际验证新图、追加页、BGM 与成功弹窗。

集成测试在运行时生成纯色测试图片，不读取活动原稿、品牌素材或本机媒体。真机浏览器、真实音乐播放、压力测试和公网 HTTPS 部署应在实际部署环境单独验收。
