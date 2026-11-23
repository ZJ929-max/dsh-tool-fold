# 版本策略

## 为什么归零

`0.1 → 0.2 → 0.3` 是在原型阶段按提交涨出来的，读起来像已经做了大半。版本号是给**别人**判断兼容性的信号，不是进度条。所以换名字（`dsh-tool-fold` → **`dsh-lazy-tools`**）、按新方案从 `0.0.1` 重新起算：旧号留在旧名下，不篡改历史，也不假装继承。

## 编号格式

```
0.0.<checkpoint>-re<candidate>
     ↑ 里程碑          ↑ 候选序号
```

- **checkpoint（0.0.N）**：一个可以交给别人装的里程碑。只有打 checkpoint 才会涨 N。
- **candidate（-reX）**：同一里程碑下的候选版本，随便涨，不承诺任何东西。原型期的日常改动都落在这一层。
- **去掉 `-reX` 的 `0.0.N`**：这个 checkpoint 自己用下来是稳的。

## 四条规则

1. **日常只涨 `-reX`。** 提交不升版本，改动写进 `CHANGELOG.md` 的 `## Unreleased`。
2. **checkpoint 才涨 N。** 进整合包、或明确说「这版可以给别人试」时才做，一次 = 一个 N。
3. **`0.1.0` 留给「外人真在跑」。** 在那之前不出现 `0.1`；`0.2`、`0.3` 同理，不许再回到那种涨法。
4. **`1.0.0` 只在 API 冻结之后。** 在那之前任何「稳定版」的说法都不成立。

## 怎么发

```bash
node scripts/release.mjs            # 升候选：0.0.1-re1 → 0.0.1-re2（若当前是 0.0.1 则开 0.0.2-re1）
node scripts/release.mjs --final    # 收尾：去掉 -reN，把 Unreleased 落成该 checkpoint 的说明
node scripts/release.mjs --dry-run  # 只看结果
```

脚本会改 `package.json`、改 `CHANGELOG.md`、自动提交，并打印整合包需要的那行钉点（含完整 commit 与 blob 链接）。
