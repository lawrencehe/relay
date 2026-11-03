# paseo-relay-node

自建的 [Paseo](https://github.com/getpaseo/paseo) 中继服务器，Node.js 实现，与官方中继协议兼容。

Paseo 守护进程（跑在你的开发机上）和客户端（手机 / 网页 app）不在同一网络时，双方都主动连到这个中继，由它转发 WebSocket 帧。**流量是守护进程与客户端之间端到端加密的**，中继只按 `serverId` / `connectionId` 转发密文，不持有任何密钥，也不落盘任何数据。

```
手机/网页 app ──wss──▶ relay.example.com:443 ◀──wss── Paseo 守护进程（开发机）
                         Caddy(自动 HTTPS) → relay.mjs(:8080)
```

## 来源

官方 npm 包 `@getpaseo/relay` 只附带 Cloudflare Durable Objects 版本（`cloudflare-adapter`）。`relay.mjs` 是它的逐段移植：协议、通知时机、帧缓存（每连接最多 200 帧）、控制连接卡死检测（10s 提醒 + 5s 强制重连）全部保持一致，只把 Cloudflare 运行时接口换成 `node:http` + [`ws`](https://github.com/websockets/ws)，另加每 30s 一次协议层 ping 清理半开连接。

对应上游版本：`@getpaseo/relay` **v0.11.2**。Paseo 升级后如果中继协议有变化，需要对照新版 `packages/relay/src/cloudflare-adapter.ts` 同步修改。

## 快速部署（Docker）

前提：

- 一台有公网 IP 的 Linux 机器，装好 Docker + Compose 插件，本机能 `ssh <主机>` 登录；
- 域名 A 记录指向这台机器；
- 安全组/防火墙放行 **443**（TCP，可选 UDP）。80 端口可开可不开，Caddy 会用 TLS-ALPN 方式在 443 上申请 Let's Encrypt 证书。

```bash
git clone git@github.com:lawrencehe/relay.git && cd relay
./deploy.sh <ssh主机> relay.example.com     # 首次部署，写入远程 .env
./deploy.sh <ssh主机>                       # 之后更新代码，沿用远程 .env
```

脚本会把文件同步到远程 `~/paseo-relay/`，执行 `docker compose up -d --build`，最后检查 `https://<域名>/health`。

也可以在目标机器上手动部署：

```bash
cp .env.example .env    # 填 RELAY_DOMAIN
docker compose up -d --build
```

两个容器都设置了 `restart: unless-stopped`，机器重启后自动恢复。证书存放在 `caddy_data` 卷里，Caddy 会自动续期。

## 配置 Paseo 守护进程

编辑开发机上的 `~/.paseo/config.json`：

```json
{
  "daemon": {
    "relay": {
      "enabled": true,
      "endpoint": "relay.example.com:443",
      "publicEndpoint": "relay.example.com:443",
      "useTls": true,
      "publicUseTls": true
    }
  }
}
```

然后重启守护进程，执行 `paseo daemon pair --relay` 生成配对二维码/链接，让客户端扫码配对。

- 中继地址写在配对信息里。**换机器时保持域名不变、只改 DNS**，守护进程会自动重连，客户端不用重新配对。
- 换了域名或端口，就要改上面的配置、重启守护进程，并让所有客户端重新配对。
- 守护进程日志在 `~/.paseo/daemon.log`，连接成功时会出现 `relay_control_connected` / `relay_data_connected`。

## 运维

```bash
ssh <主机> 'cd ~/paseo-relay && docker compose logs -f relay'   # 中继日志
ssh <主机> 'cd ~/paseo-relay && docker compose logs caddy'      # 证书 / HTTPS 问题
curl https://relay.example.com/health    # {"status":"ok","sessions":N,"sockets":M}
```

日志解读：

- `v2:server(control) connected`：守护进程上线（每台守护进程一条）；
- `v2:client(conn_x) connected` → `v2:server(data:conn_x) connected`：一次客户端会话建立；
- 守护进程刚上线时，中继停机期间客户端留下的旧连接会被守护进程以 `4001: Hello timeout` 关闭，属于正常清理。

## 不用 Docker 直接运行

```bash
npm ci --omit=dev
PORT=8080 HOST=127.0.0.1 node relay.mjs
```

前面需要自己配一层 TLS 反向代理（Caddy / Nginx），并且要支持 WebSocket upgrade。

## 协议摘要

入口：`GET /ws?serverId=<id>&role=server|client&v=2[&connectionId=<id>]`

| 连接 | 参数 | 说明 |
|---|---|---|
| 控制连接 | `role=server`，不带 connectionId | 每个 serverId 只保留一条；接入时收到 `{"type":"sync","connectionIds":[…]}` |
| 客户端连接 | `role=client`（可带 connectionId，不带则由中继分配） | 接入后中继向控制连接发 `{"type":"connected","connectionId"}` |
| 数据连接 | `role=server&connectionId=…` | 守护进程收到 connected 后建立；与对应客户端连接双向转发，期间缓存的帧会先补发 |

客户端最后一条连接断开时，中继关闭对应数据连接（1001），并向控制连接发 `disconnected`。数据连接断开时，中继关闭对应客户端连接（1012），客户端会自动重连。另外兼容 `v=1` 旧协议。

## 开发

```bash
npm install
npm test     # 启动临时中继，模拟守护进程 + 客户端做协议测试
```

## 其他选择

- 官方托管中继 `relay.paseo.sh`：Paseo 的默认中继，不需要自建。
- 官方 Elixir 实现 [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay)（Apache-2.0）：支持分布式集群，功能更完整，但仍在快速开发中。

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。本项目包含从 Paseo（Copyright (c) 2025-present Mohamed Boudra，Apache-2.0）移植的代码。
