# dsh-phone-butler

**把一台真实的 Android 手机，变成 agent 可以查看和打理的一台设备 —— 全部走 adb，不需要 root。**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that puts a real
Android phone within reach of the agent: free up storage, find what is eating the disk, measure
directories, clear an app cache without touching its data, uninstall, screenshot.

```
phone_status   is a phone reachable, and what is it
phone_scan     read-only: cleanup survey · per-app data sizes · caches · usage · big files
phone_fs       ls / du on /sdcard
phone_act      the only writer: clear-cache · rm · uninstall   (each gated by confirm=true)
phone_shot     screenshot to a local file
```

Plus one bundled skill, `phone-butler`: the capability map, the connection recipes and the five
traps that produced wrong answers.

---

## 为什么值得存在

「手机空间满了」这件事，通常被三个互相矛盾的印象搅在一起：文件管理器说能清，系统设置说
腾不出空间，而真正的元凶躺在一个看不见的目录里。

这个插件做两件具体的事：

1. **把可清理的与不可清理的分开说。** `/sdcard` 全层（**含每个 App 的 `Android/data` 与
   `Android/obb`**）可读写；`/data/data` 未 root 一律碰不到 —— 那是聊天数据库住的地方。
   把这两层混为一谈，是大多数"手机管家"话术的来源。
2. **让那层碰不到的东西至少可以被度量。** `phone_scan kind=apps` 解析
   `dumpsys diskstats` 的并列数组，**未 root 也能列出每个 App 的私有数据大小**（它同时覆盖
   `/data/data` 与外部 `Android/data`）。所以"到底是哪个 App 吃掉了手机"有了确定答案，
   而不是靠猜。

## 安装

在 DSH 里，用官方的 bundle 安装姿势指向本目录（或它的克隆）：

```
plugin_manager  action: install_bundle  target: <本目录绝对路径>
```

它需要 `adb`：在 `PATH` 里，或用 `DSH_PHONE_ADB` 指向具体可执行文件，或放在 Android SDK
的常规位置。可选配置（在 profile 的 `cordis.patch.yml` 里覆盖）：

```yaml
- id: dsh-phone-butler
  config:
    adbPath: 'C:\platform-tools\adb.exe'
    timeoutMs: 240000
```

## 安全立场（这是设计里最要紧的部分）

- **读永远不改动任何东西。**
- **写必须显式 `confirm: true`**；否则工具**什么都不执行**，只返回它本来会执行的计划 ——
  把计划摆给用户看、得到同意，再发一次。
- **`rm` 只接受 `/sdcard` 之下的路径**，其它一律拒绝（含测试断言）。
- **扫描默认不列文件名。** 一份来自某人 Download 文件夹的文件清单默认是隐私；`names: true`
  是一次明确的索要。
- **Android 没有回收站。** `rm` 就是最终结果。

## 能力边界（实测，不是推测）

| 层 | 能否触达 | 说明 |
|---|---|---|
| `/sdcard/**` | **可以，读写皆可** | 含每个 App 的 `Android/data`、`Android/obb` |
| `/data/data/<pkg>` | **不可以** | 未 root `Permission denied`；`run-as` 拒绝非 debuggable 包 |
| 每个 App 的数据**大小** | **可以** | `dumpsys diskstats`（覆盖私有层） |
| 只清缓存 | **可以** | `pm clear --cache-only <pkg>`，数据保留 |
| 清空 App 数据 | 技术上可以，但会毁数据 | 本插件**故意不暴露** |

## 连接手机（最容易踩空的一段）

有两条互相独立的通道，行为完全不同：

| 通道 | 绑在哪 | 离开 Wi-Fi 还活着吗 |
|---|---|---|
| **无线调试**（Android 11+） | **WLAN**（开关原文：「连接到 WLAN 后启用调试模式」） | **不活** —— 关掉 Wi-Fi，adbd 就不再监听 |
| **`adb tcpip 5555`** | adbd 进程本身，监听 `0.0.0.0:5555` | **活着** —— 远程能力就靠这个 |

所以想让不在同一网络的手机可达：先在同一个 Wi-Fi 下执行**一次** `adb tcpip 5555`；此后手机
一直听着 5555，任何能路由到它地址的人（例如经过 Tailscale 这类 VPN）都能
`adb connect <手机地址>:5555` 连上。手机重启后失效，需要重做。

找无线调试端口：`adb mdns services` 会直接打印 `IP:端口`。

## 五个会产出错误结论的坑

1. **`find /sdcard` 静默返回空。** `/sdcard` 是符号链接
   （`/sdcard → /storage/self/primary → /storage/emulated/0`），toybox 的 `find` 默认不跟随。
   结果是一份空列表和退出码 0 —— 与"这台手机很干净"完全无法区分。
   **必须 `find -H /sdcard`。** 有一次"没有大文件、没有空目录"的报告就是这么来的，
   而那台手机两样都有几千个。
2. **别把带双引号的命令经 PowerShell 递给 `adb shell`。** 引号会被吃掉，管道错位，
   得到一个静默的空结果。用 argv 数组传参。
3. **推到手机上的脚本必须是 LF 换行。** CRLF 会让 shell 报 `id\r: inaccessible or not found`。
4. **全黑的截图是锁屏，不是抓取失败** —— 比文件大小（约 18 KB 黑屏 vs 几 MB 有内容），
   或查 `dumpsys power`。
5. **别从截图里读路径。** OCR 会混淆 `l`/`1`、`I`/`1`。问设备：`pm path <包名>`。

## 它不是什么（以及为什么不往那边走）

有人会问：既然能看屏幕、能读传感器清单、能注入点击，为什么不把它做成「手机的感知器官」？

我们认真评估过，**结论是不做**。理由放在这里，因为后来的人一定会再问一遍：

| 想法 | 为什么不做 |
|---|---|
| 调相机「以固定采样率看世界」 | `adb shell` 没有 CAMERA 权限，唯一路径是截「相机在前台时的屏幕」—— 那不是采样，是**偷看屏幕**；而且无法验证这一帧真是相机画面，最坏会混进通知栏、私聊弹窗、验证码。 |
| 读传感器数值 | Android 12+ 对 shell 主动遮蔽（`[value masked]`）。能拿到的是**清单**与**事件时间戳**，拿不到读数。 |
| 失联自动求援 | adb 是「桌面端主动连手机」。**唯一需要它的时刻，它必然不在线。** |
| 代做「需要本人承诺」的事 | 见下。 |

**一条判据**（评估过所有候选之后，最好用的那一句）：

> **操作结束后，用户还能不能说「这是我做的、我理解的」？**
> **能就做，不能就别做。**

完整的评估记录 —— 实测边界表、「假成功」七陷阱、L0~L3 分级授权模型、以及两个真正值得做的方向 ——
在 [`docs/design-notes.md`](docs/design-notes.md)。

## 一条共存提醒

如果同一台电脑上有多个 agent，它们**共用同一个 adb server**。`adb kill-server` 会把所有人
一起断掉；只断自己那条，用 `adb disconnect <地址>`。

## 开发

```
node test/selftest.mjs            # 离线断言（纯函数 + 引擎安全语义 + 注册形状）
node test/selftest.mjs --device   # 另跑一轮真实的只读调用
```

`lib/adb.js` 是纯 Node，不从 DSH 导入任何东西 —— 所以引擎可以脱离 harness 直接测试。
`lib/entry.js` 同样零 DSH 导入：一个装在 profile 之外的 `link:` 插件无法解析
`@deepseek-ai/*`，一次这样的 import 就会让整个入口加载失败。

## License

MIT © 2026 Void-LifeStream

---

*实测环境：REDMI K90 Pro Max（第五代骁龙 8 至尊版）/ Xiaomi HyperOS 4.0.2.0（Android 17）/ 无 root 的 adb shell。
下面的每一条限制都是在这台机器上量出来的，不是推断 —— 换机型可能不同，尤其「注入是否被静默忽略」与「传感器数值是否被遮蔽」这两条。*
