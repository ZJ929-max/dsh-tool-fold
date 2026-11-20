# dsh-tool-fold

把用不到的工具收成「一行名字 + 一句话」，需要时 `load` 回来。

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的插件。每个工具 schema 都是每一步请求都要付的常驻成本；实测一台机器上 65 个工具里有 38 个在整场会话里一次都没被调用，却占掉 **55.8%** 的工具 schema 字节。

这个插件把这些工具从「完整 JSON Schema」降级成 `tool_fold` 里的一行清单。

## 它解决什么

| | 折叠前 | 折叠后 |
|---|---:|---:|
| 可见工具 | 71 | 39 |
| schema 字节 | 67,939 | ≈43,000（含计量口径见下） |

实测一段真实配置：折叠 32 个工具，省 **24,359 字节 ≈ 7,612 token**。

## 安装

```bash
dsh plugin --profile <profile> add git+https://github.com/ZJ929-max/dsh-tool-fold.git
```

或把它作为本地目录安装：

```bash
dsh plugin --profile <profile> add /path/to/dsh-tool-fold
```

## 使用

```
tool_fold({action:"list"})                 # 看折叠了什么，每条一句描述
tool_fold({action:"load", name:"subagent"}) # 取回一个，下一轮可直接调用
tool_fold({action:"status"})                # 折叠数 / 省下字节 / 估算 token
```

## 配置

行配置（`cordis.patch.yml`）优先，其次读 `~/.dsh/tool-fold.json`：

```yaml
- insert:
    - id: tool-fold
      name: dsh-tool-fold
      config:
        enabled: true
        fold: []        # 留空 = 用内置默认名单
        keep: []        # 从默认名单里豁免
```

`enabled: false` 完全关闭，工具恢复原状。

## 三条重要的边界

1. **只在会话第一步定型一次。** 工具清单排在请求最前面，中途增删会让整个前缀缓存作废。折叠是「开局就省」，不是「随时修剪」。
2. **只用 deny 过滤，不用 allow。** 写错一个名字的后果是「少显示一个」，不是「全没了」。
3. **恢复入口永不折叠。** `tool_fold` 自己以及 `pwsh`/`read`/`write`/`edit`/`grep` 等基础工具写死在保护名单里；`status` 会自检「已折叠且不可恢复」的集合，正常必须为空。

## 已知限制

- 只对**全局注册**的工具生效。由 agent preset 直接注册在会话作用域里的工具不受 `ctx.tools.restrict()` 影响（DSH 的机制如此：限制只作用于「继承来的」工具）。
- `load` 的调用方会话优先取自执行上下文；两个会话并发跑时会话归属可能退回到「最近一次请求的会话」。
- 折叠清单在插件加载时拍快照，之后才注册的工具不受影响。

## 许可

MPL-2.0。见 [LICENSE](LICENSE)。
