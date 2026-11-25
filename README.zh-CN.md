# opencode-preview

在 OpenCode 终端界面里直接查看任意文件。

```
/preview <路径>     展示一个文件
/preview            先选文件，再展示
```

`/show` 和 `/view` 是 `/preview` 的别名。

- **图片**：PNG / JPEG / GIF / WebP / BMP / TIFF / AVIF / ICO，用终端原生图形协议
  （kitty / sixel）绘制，两者都没有时退化为彩色方块。
- **PDF**：在运行 TUI 的机器上逐页栅格化成 PNG，支持翻页与缩放。首页会按终端尺寸选择分辨率
  （约 50–70 dpi，两页文档约 0.1s）；想要更清晰按 `+` 提高。标题栏会显示该页渲染耗时。
- **文本**：内置 vim 风格编辑器（`NORMAL` / `INSERT` / `VISUAL`），tree-sitter 高亮，
  `:w` 通过 OpenCode 服务端写回。
- **其它文件**：只读十六进制 dump。

所有读取都走 OpenCode 服务端的文件 API，因此 TUI 连远程服务器时同样可用；写入
（`:w`）也走服务端。

## 安装

把插件目录加入 `opencode.json` 的 `plugins`（全局或项目级）：

```json
{
  "plugins": ["/path/to/opencode-preview"]
}
```

OpenCode 会加载包的服务端部分（`./index.ts`，空的）和 TUI 部分（`./tui.ts`）。
服务端部分不能省：TUI 只会加载“服务端已激活”的插件的 `tui` 入口。

## 用法

`/preview <路径>` 会在会话右侧面板里打开查看器（终端过窄时自动全屏）；在首页调用则
以全屏页面打开。

- 路径相对会话目录解析，也支持 `~` 与绝对路径。
- 如果 `路径` 是**目录**，选择器直接从该目录开始。
- 不带参数的 `/preview` 从会话目录开始，只列**当前一层**（一次 `ls`），所以立刻弹出；
  需要全局模糊搜索时选 “Search project…”。
- 会话目录**之外**的路径走不了服务端的文件 API，因此在 TUI 与本机同机时直接读/写磁盘。
  云盘 / FUSE 挂载（rclone、gvfs 等）首次读取可能要好几秒：面板会显示当前步骤和计时，
  读到的内容会按 路径+大小+mtime 缓存在内存里，重新打开几乎是瞬时的。
- 命令面板里的 **Preview file** 命令等价，且在模型正在回复时也能用；斜杠命令在回复中途会被宿主拒绝
  （“this prompt cannot be queued”）。

### 查看器按键

| 按键 | 文本 | 图片 / PDF |
| --- | --- | --- |
| `q` / `Esc` | 关闭（有改动时会拦住） | 关闭 |
| `f` | — | 全屏切换 |
| `j` / `k`、`↓` / `↑` | 下 / 上 | 下一页 / 上一页 |
| `PgDn` / `PgUp`、`Space`（媒体） | 整页 | 下一页 / 上一页 |
| `Ctrl+d` / `Ctrl+u` | 半页 | — |
| `Ctrl+f` / `Ctrl+b` | 整页 | — |
| `+` / `-` / `z` | — | 放大 / 缩小（dpi 越高越清晰、上传量越大） |

### vim 编辑器

| 分类 | 按键 |
| --- | --- |
| 模式 | `i` `a` `I` `A` `o` `O`、`Esc`；`v` / `V` 可视模式 |
| 移动 | `h j k l`（方向键同理）、`0 ^ $`（`Home`/`End`）、`w b e W B E`、`gg G`、`{ }`、`H M L`、`f t F T ; ,`、`%`、`PgUp`/`PgDn` |
| 计数 | `3j`、`2dd`、`4x`…… |
| 编辑 | `x X r s S C D dd dw d$ d0 dG dj dk`、`cc cw`、`J`、`~`、`>>` `<<`、`p P u Ctrl+r .` |
| 行号跳转 | `:{n}` |
| 搜索 | `/pattern`、`?pattern`、`n`、`N`、`*`、`#` |
| 命令行 | `:w`、`:w <路径>`、`:q`、`:q!`、`:wq`、`:e <路径>`、`:e!` |
| 寄存器 | `"a` … `"z`、`"+` / `"*`（yank 时写 OSC 52 剪贴板） |

文本按宿主主题用 tree-sitter 高亮；未知类型保持纯文本。

### 依赖

- OpenCode v2（按 2.4.x 开发与测试）。
- 看 PDF 需要至少一个栅格化工具：`pdftoppm`（poppler-utils）、`mutool`
  （mupdf-tools）、`gs`（ghostscript），按此优先级选择；都没有时查看器会提示安装。
- 看图片建议使用支持图形协议的终端：`kitty`、`ghostty`、`wezterm`、`foot` 等用
  kitty 协议，`xterm`/`mlterm` 用 sixel；其它终端退化为彩色方块。

## 限制

- 文本编辑是有意做小的 vim 子集：不支持宏（`q`）、`:s` 替换、折叠、搜索高亮，
  `.` 只重复到插入文本级别，tree-sitter 重新解析是防抖的（非增量）。
- 有 `pdfinfo` 时用它取页数，否则靠逐页试探判断最后一页。
- 二进制文件只做十六进制展示，不会写回。

## 开发

```sh
npm install
npm run typecheck     # tsc
npm test              # bun test（引擎、工具函数、以及真实渲染器的集成测试）
npm run test:unit     # 纯逻辑模块用 node 测试跑
```

vim 引擎（`vim/engine.ts`）不依赖渲染器，用内存 buffer 单测；`vim/buffer.ts` 负责
适配 OpenTUI 的 `EditBuffer`。

## 许可

GPL-3.0-only。与 OpenCode 官方无关。
