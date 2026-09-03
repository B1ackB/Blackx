# 封口袋标准权威与派生规则

状态：Research Baseline
标准状态核对日期：2026-08-26
首个市场范围：中国

本文定义 Blackx Print 如何把行业标准作为权威来源。它不是标准原文的替代品，也不把行业常见做法提升为权威事实。编码具体条款前必须取得合法、完整、版本明确的标准文本，并记录条款位置和适用范围。

## 1. 结论

行业标准可以权威确定：

- 术语、分类和适用范围
- 强制安全要求
- 在适用范围内的技术要求和判定规则
- 取样、试验、检验和标识方法
- 某些分级、允许范围或最低性能要求

行业标准不能仅凭“封口袋”品类名称唯一确定：

- 内容物和预期用途
- 是否直接食品接触、是否蒸煮或无菌灌装
- 是否夹链、热封或采用其他闭合结构
- 客户表达或确认的成品尺寸、数量、保质期和阻隔目标；可先由 Blackx 从 Brief、附件或历史项目提取
- 供应商材料牌号、层间组合和设备生产设定值
- 印刷版式、条码、法定文字和品牌要求

因此 Blackx 采用“少量适用性事实 → 确定性标准路由 → 标准派生要求”的方式。模型可以解释标准和提出方案，但不能选择或改写权威事实。

## 2. 初始标准目录

以下目录只记录标准元数据、状态和路由条件，不复制受版权保护的完整条文。

| 标准 | 2026-08-26 状态 | 路由条件 | 在 Blackx 中的作用 |
| --- | --- | --- | --- |
| `BB/T 0014-2011 夹链自封袋` | 现行 | 已验证为夹链自封结构 | 夹链自封袋的产品标准候选；不得应用到所有封口袋 |
| `GB/T 21302-2007 包装用复合膜、袋通则` | 现行 | 已验证为其适用范围内的复合膜/袋 | 当前通用质量与试验规则候选 |
| `GB/T 21302-2026 包装用塑料复合膜、袋通则` | 已发布，2027-02-01 实施 | 同上，且 `effectiveAt >= 2027-02-01` | 到实施日替代 2007 版；实施前不得作为当前判定依据 |
| `GB/T 10004-2008 包装用塑料复合膜、袋 干法复合、挤出复合` | 现行 | 材料和复合工艺落入其范围 | 对应产品要求候选；修订计划不等于现行标准 |
| `GB/T 15171-2025 包装件密封性能试验方法` | 现行 | 包装件与试验方法适用范围匹配 | 密封性能试验方法，不负责选择袋型或生产封口参数 |
| `QB/T 2358-1998 塑料薄膜包装袋热合强度试验方法` | 现行 | 塑料薄膜袋且需要热合强度试验 | 热合强度试验方法，不等于生产线温度/压力/时间配方 |
| `GB/T 7707-2008 凹版装潢印刷品` | 现行，已有修订计划 | 已验证采用凹版装潢印刷 | 印刷质量规则候选；其他印刷方式需路由到对应标准 |

食品接触时增加：

| 标准 | 路由条件 | 作用 |
| --- | --- | --- |
| `GB 4806.1-2016` | 已验证为食品接触材料及制品 | 通用安全要求 |
| `GB 4806.7-2023` | 已验证为食品接触用塑料材料及制品 | 塑料材料及制品安全要求 |
| `GB 4806.13-2023` | 已验证为食品接触用复合材料及制品 | 复合材料及制品安全要求 |
| `GB 4806.14-2023` | 食品接触材料及制品使用油墨且适用范围匹配 | 油墨安全要求 |

特殊用途按条件增加，而不是设为默认：

- `GB/T 41168-2021`：食品包装用塑料与铝箔蒸煮复合膜、袋。
- `GB/T 18454-2019`：液体食品无菌包装用复合袋。
- `GB/T 40266-2021`：食品包装用氧化物阻隔透明塑料复合膜、袋质量通则。

医疗、危险品、药品、儿童用品、出口市场和其他受监管用途不复用上述通用 Profile，必须增加独立 Standards Profile 和法规审查。

## 3. StandardsRegistry

每条标准记录至少包含：

```text
standardId
title
authority
status: draft | published_not_effective | effective | withdrawn | superseded
publishedAt
effectiveAt
supersedes
scopePredicateVersion
licensedTextRef
sourceUrl
lastCheckedAt
```

Registry 必须保留历史版本。标准更新不能原地覆盖；执行一次 Run 时使用的标准版本进入 `ContextSnapshot`、Artifact Lineage 和 Evaluation Evidence。

## 4. StandardsRouter

Router 只消费 `verified` 的适用性事实：

```text
marketRegion
intendedUse
contentsCategory
foodContact: none | indirect | direct
materialFamily
constructionMethod
closureFeature
printingProcess
fillingProcess
thermalProcess
sterilityRequirement
barrierRequirement
effectiveAt
```

其中 `barrierRequirement` 必须来自保质期/内容物要求、企业规范或测试目标，不得由模型从品类名猜测。

Router 输出版本化的 `ApplicableStandardsProfile`：

```text
profileId
profileVersion
inputFactVersions
selectedStandards[]
rejectedStandardsWithReasons[]
effectiveAt
unresolvedApplicabilityFacts[]
```

输入不足时 Router 必须返回 `incomplete`，不得选择“最常见”标准作为生产依据。

## 5. 标准派生 Fact

标准规则可以把 Fact 标记为 `verified`，但必须同时满足：

1. 标准状态在 `effectiveAt` 时有效。
2. 适用范围由全部 `verified` 输入事实确定性匹配。
3. 规则来自合法取得的完整标准文本，并记录标准号、版本、条款和解析器版本。
4. 派生过程由确定性程序完成，不由模型自由改写。
5. 标准只规定范围或试验方法时，不把某个具体材料、尺寸或设备参数伪装成标准结论。

建议的 Lineage：

```text
sourceType: standard
sourceRef: <standard-id>@<version>#<clause>
derivationRuleId
derivationRuleVersion
inputFactVersions
verifiedBy: standards-rule-engine
```

## 6. 生产参数边界

标准中的试验条件与工厂生产设定是不同概念。热封温度、压力、停留时间、线速、张力、熟化条件、油墨/胶黏剂配方等，通常还取决于材料牌号、层结构、设备、内容物、供应商工艺窗口和验证结果。

Blackx 可以从标准生成：

- 必须验证的性能项目
- 试验方法与取样计划
- 允许范围或最低要求（标准明确规定时）
- 生产参数验证任务和证据清单

Blackx 不得仅由标准名称生成最终生产设定。最终设定必须由供应商工艺数据、设备能力档案、MES/历史验证工单、企业标准、试产/实验结果或专业人员确认，并形成版本化 Fact 与 Evaluation Evidence。这些数据应通过 Print Domain Port/Adapter 获取；没有连接器时请求工厂上传或确认，不把普通客户填表作为默认路径。

## 7. 更新与失效

- 每次构建 Standards Registry 时校验标准状态和实施日期。
- `GB/T 21302-2026` 在 2027-02-01 前保持 `published_not_effective`；到期后通过事件启用并标记依赖 2007 版的未完成 Artifact 为 `stale`。
- 标准被替代不自动重写历史交付物；新 Run 和重新验证使用 `effectiveAt` 对应版本。
- 标准全文、解释材料和内部规则必须记录许可证、来源和版本，不把不明来源 PDF 当作权威文本。

## 8. 权威来源索引

- [BB/T 0014-2011 夹链自封袋](https://std.samr.gov.cn/hb/search/stdHBDetailed?id=8B1827F1FB50BB19E05397BE0A0AB44A)
- [GB/T 21302-2007 包装用复合膜、袋通则](https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=6FBB98BC118CD1A0C694498E20DF6061)
- [GB/T 21302-2026 发布与实施状态](https://wx.sacinfo.org.cn/std/queryAll)
- [GB/T 10004-2008 状态](https://std.samr.gov.cn/gb/search/gbDetailedCNF?id=71F772D7C5AFD3A7E05397BE0A0AB82A)
- [GB/T 15171-2025 包装件密封性能试验方法](https://std.samr.gov.cn/gb/search/gbDetailed?id=3B46A026CC74469CE06397BE0A0AEEB8)
- [QB/T 2358-1998 塑料薄膜包装袋热合强度试验方法](https://std.samr.gov.cn/hb/search/stdHBDetailedCNF?id=8B1827F1971BBB19E05397BE0A0AB44A)
- [GB/T 7707-2008 凹版装潢印刷品](https://std.samr.gov.cn/gb/search/gbDetailed?id=71F772D75A4ED3A7E05397BE0A0AB82A)
- [国家卫健委食品安全标准目录](https://www.nhc.gov.cn/sps/c100087/202403/cfd1d0e9cec34359ba89686427d87403.shtml)
- [GB 4806.7/9/11/13/14-2023 发布公告](https://www.nhc.gov.cn/sps/c100088/202309/4ad44d9d1b0647f8b46ea443ce935309.shtml)
