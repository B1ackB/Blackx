# M2 合成用户验证样例

日期：2026-09-05
状态：Synthetic Proxy Validation Only

## 证据声明

以下角色、公司、对话和判断均为产品负责人授权编写的合成样例，没有真实印刷、包装或家具从业者参与，不是用户访谈、可用性测试或付费意愿证据。

这些样例复用 `requirementBriefFixtures` 和 `npm run eval:m2` 的正式 Product Worker 链路，用于检查 Requirement Brief 是否能正确区分：可审批、缺少字段、字段值待确认。它们只能关闭 M2 的工程与合成验证范围，不能证明产品已经减少真实企业返工。

## 样例 1：咖啡豆自立袋，可进入审批

- 合成角色：香港包装厂售前跟单
- 对应 Fixture：`print-coffee-pouch-ready`
- 客户原始对话：

  > 我们要做一万个 250g 咖啡豆自立拉链袋，袋子尺寸 160 × 230 + 80 mm。香港仓交货，最迟 2026 年 11 月 30 日到。品牌稿还没上传，但“稿件待提供”这个状态已经确认。

- 期望 Fact：`product_type`、`quantity`、`dimensions`、`target_market`、`target_delivery`、`delivery_location`、`artwork_status` 全部有明确来源并经人工确认。
- 期望动作：生成 `requirement-brief.v1`，Evaluation 通过并允许审批。
- 关键边界：`artwork_status=稿件待提供` 被确认，只代表需求状态已确认，不代表稿件或印前文件已经生产就绪。
- 合成结论：可以交给包装工程师继续评估，但不能直接生成生产文件。

## 样例 2：护肤品折叠纸盒，缺少尺寸

- 合成角色：彩盒厂业务员
- 对应 Fixture：`print-cosmetic-carton-missing-dimensions`
- 客户原始对话：

  > 香港上市的护肤品折叠纸盒，先做 5000 个，12 月中旬送到香港。设计稿正在整理，盒子尺寸要等产品样品确认。

- 已知 Fact：品类、数量、目标市场、交期、交付地点和稿件状态。
- 阻断项：`dimensions`。
- 期望动作：只追问成品尺寸或产品实物尺寸，不重复询问已经明确的信息；进入 `needs_input`，不得创建 Approval。
- 合成结论：不能交给结构设计或正式报价，补齐并确认尺寸后才生成新 Artifact Version。

## 样例 3：产品标签，目标市场不确定

- 合成角色：标签厂客户经理
- 对应 Fixture：`print-label-unverified-market`
- 客户原始对话：

  > 80 × 50 mm 的产品标签先做两万张，送香港办公室，11 月底要。产品可能先在香港卖，也可能新加坡一起用，市场还没有最终决定。

- 已知 Fact：标签类型、数量、尺寸、交期、交付地点和稿件状态。
- 待确认项：`target_market` 只能保持 `unverified`。
- 期望动作：Artifact 的下一步为 `confirm_facts`；模型不得把“可能是香港”提升为 Verified。
- 合成结论：内部结构一致，但不能进入版本审批。

## 样例 4：办公室桌具，完整送装需求

- 合成角色：定制办公家具销售
- 对应 Fixture：`furniture-office-desk-ready`
- 客户原始对话：

  > 新办公室需要 20 套办公桌，每张 1400 × 700 × 750 mm，室内使用。2026 年 12 月 15 日前送到香港办公室，由供应商负责安装。以上都已确认。

- 期望 Fact：`furniture_type`、`quantity`、`dimensions`、`use_environment`、`target_delivery`、`delivery_location`、`installation_required` 全部 Verified。
- 期望动作：生成 Artifact，Evaluation 允许审批，批准 Artifact v1 后通过 Stage Gate。
- 合成结论：可以交给设计与报价人员；材料、五金和承重仍属于后续工程阶段。

## 样例 5：酒店衣柜，安装责任不清楚

- 合成角色：酒店家具项目跟单
- 对应 Fixture：`furniture-wardrobe-missing-installation`
- 客户原始对话：

  > 50 套酒店客房衣柜，单套约 1800 × 600 × 2400 mm，12 月送香港项目现场。柜子在室内使用，但现场安装由总包还是家具供应商负责还没决定。

- 已知 Fact：家具类型、数量、尺寸、使用环境、交期和地点。
- 阻断项：`installation_required`。
- 期望动作：只确认安装责任；进入 `needs_input`，不创建 Approval。
- 合成结论：不能作为完整送装范围交给报价，避免漏算安装和现场协调成本。

## 样例 6：门店陈列架，数量只是估算

- 合成角色：零售家具业务员
- 对应 Fixture：`furniture-retail-shelf-unverified-quantity`
- 客户原始对话：

  > 新门店要一批 900 × 450 × 2100 mm 的室内陈列架，大概 20 套，香港交货，不需要现场安装。数量要等门店平面图最后确认。

- 已知 Fact：家具类型、尺寸、使用环境、交期、地点和安装要求。
- 待确认项：`quantity=20` 可以提取，但必须保持 `unverified`。
- 期望动作：下一步为 `confirm_facts`；用户确认数量或录入新版本后才能进入 Approval。
- 合成结论：可以作为候选需求摘要，不能作为已冻结采购数量。

## 合成验收结果

| 检查项 | 结果 |
| --- | --- |
| Print / Furniture 使用同一 Product Worker | 通过 |
| 完整需求进入版本绑定 Approval | 通过 |
| 缺失字段进入 `needs_input` | 通过 |
| 模糊字段保持 `unverified` | 通过 |
| 模型不能创造 Verified Fact | 通过 |
| Artifact、Evaluation、Queue 和 Event 可追溯 | 通过 |
| 跨 Run 指标可查询 | 通过 |
| 真实目标用户可用性 | 未验证 |
| 真实工作节省时间或减少返工 | 未验证 |
| 真实用户付费或持续使用意愿 | 未验证 |

## 后续补验条件

在对外试点、宣称产品价值或启动 RSI 之前，至少需要一名 Print/Packaging 售前和一名 Furniture 售前分别完成三条脱敏任务。补验只替换本文件的合成判断，不改变已经冻结的安全、事实、Artifact、Evaluation 和 Approval Contract；如果真实用户认为 Requirement Brief 不能交给下一岗位，应重新打开 M2 Product Validation，而不是调整指标掩盖问题。
