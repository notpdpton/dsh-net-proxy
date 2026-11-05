# @notpdpton/dsh-net-proxy · 网络代理插件

让 **DSH 自身进程**的出站 HTTP(S) 走代理。

## 解决什么问题

DSH 的模型 API 调用、`web_fetch`、HTTP MCP 服务器都从同一个 Host 进程发出。这些请求
默认直连，用户系统里配的代理未必被继承——尤其是只配了系统代理、或者代理只在某个终端
会话里生效的时候。

本插件做一件事：**把本进程的出站流量交给代理**。

路由即时生效、卸载即还原，不影响系统代理，也不修改用户的其它网络设置。

## 能力

| 能力 | 说明 |
| --- | --- |
| 代理来源 | 自动 / 系统代理 / 自定义 / 环境变量 / 直连，五种取值 |
| 协议 | `http://`、`https://`、`socks5://`（SOCKS5 属实验特性） |
| 认证 | 用户名 + 密码；密码只写入 DSH 凭据库，不写设置文件、不进进程环境变量 |
| 绕过列表 | 自定义跳过地址；`localhost`、`127.0.0.1`、`::1`、`[::1]` 始终直连且不可关闭 |
| 连通测试 | 设置页内置「测试已保存配置」，报告状态码、耗时，以及本次请求实际走的路线 |
| 状态胶囊 | 对话输入框工具栏里、完全权限下拉框右侧的只读指示：现在走不走代理，悬停看来源 |

生效通道是 `node:http.setGlobalProxyFromEnv()`：它同时覆盖 undici 的全局 dispatcher
（`fetch`，即模型 API、`web_fetch`、HTTP MCP）与 `http(s).globalAgent`（自己构造请求的
SDK）。传给它的是一份**合成的环境对象**而不是 `process.env`，所以密码不会进入进程环境，
也不会被它派生的任何子进程继承。

## 安装

本插件是一个**单包插件**：一个包同时带 Host 半边与浏览器半边，没有额外的子包依赖。

### 从 npm 安装

```bash
npm install @notpdpton/dsh-net-proxy
```

安装后在 DSH 的插件页把它加入当前 profile 的 bundle 列表（包名与 `package.json` 的
`name` 一致），重启 DSH 生效。

> 注意：npm 上的 `dsh-net-proxy`（无 scope）是**另一个人维护的另一个插件**，与本仓库无关。
> 本插件的包名带 `@notpdpton/` scope，请勿混用。

### 从源码安装

把仓库链接进 profile，再把它加入 bundle 列表：

```jsonc
// <profile>/package.json
{
  "dependencies": {
    "@notpdpton/dsh-net-proxy": "link:../dsh-net-proxy"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...
        "@notpdpton/dsh-net-proxy"
      ]
    }
  }
}
```

包内自带的 `cordis.patch.yml` 会在加载时插入本插件这一行：

```yaml
- insert:
    - id: dsh-net-proxy
      name: 'dsh-net-proxy'
```

`name` 必须是 `package.json` 的包名——浏览器半边就是靠它从同一个包解析到 `./client` 的。

装好后，配置在 **设置 → 网络代理**。

## 配置

设置保存在 profile 目录下的 `net-proxy.json`，由设置页读写，保存即生效，无需重启。

- **启用代理**：本插件唯一的开关，控制路由是否生效。
- **来源**：`auto` 依次尝试自定义地址、系统代理、环境变量，取第一个可用来源；
  `direct` 是主动覆盖既有代理去直连，与「关闭插件」不是一回事（后者保留原有设置）。
- **绕过列表**：`10.*`、`<local>` 这类 Node 代理匹配器表达不了的写法会被丢弃，并在界面上说明，
  而不是假装生效却仍然走代理。
- **密码**：只进凭据库；设置文件里永远只有用户名，没有密码。

## 目录结构

```
dsh-net-proxy/
├── index.js            Host 半边：策略解析、传输安装、HTTP 路由
├── client.js           浏览器半边：插件自己的设置页（settings.section）
├── cordis.patch.yml    自激活 patch（一行，名字即包名）
├── package.json        包名 @notpdpton/dsh-net-proxy
├── icon.svg            插件卡片图标
├── dsh-plugin.naming.json  公开标识声明
├── locale/             卡片标题与描述（zh / en）
├── docs/
│   └── proxy.md        设计说明：为什么这样实现
└── test/               离线校验脚本
```

## 验证

`test/` 下的脚本全部离线运行，不需要启动 DSH，也没有第三方依赖：

```bash
node test/run.mjs
```

单独跑某一项：

| 脚本 | 验证什么 |
| --- | --- |
| `test/verify-host.mjs` | Host 半边的纯逻辑：设置规范化、绕过列表翻译、代理 URL 解析、持久化、脱敏 |
| `test/verify-route.mjs` | Host 路由的端到端行为：状态、保存、凭据、连通测试，以及请求闸门 |
| `test/verify-client.mjs` | 浏览器半边的注册形状、词典完整性、页面渲染、样式不含硬编码色值 |
| `test/verify-package.mjs` | 清单一致性：package.json、patch、naming 声明、locale 与源码里的常量互相咬合 |
| `test/watch-proxy.mjs` | 起一个会打印每次请求的本地假代理，用于人工联调 |

## 许可

[MIT](LICENSE)
