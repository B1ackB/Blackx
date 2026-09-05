import type {
	ManufacturingIndustry,
	RequirementBriefV1,
	RequirementFactV1,
} from "./requirementBrief";

export interface RequirementBriefFixture {
	fixtureId: string;
	industry: ManufacturingIndustry;
	input: string;
	expectedApprovalEligible: boolean;
	artifact: RequirementBriefV1;
}

function verified(
	key: string,
	value: RequirementFactV1["value"],
	unit?: string,
): RequirementFactV1 {
	return {
		key,
		version: 1,
		value,
		...(unit ? { unit } : {}),
		status: "verified",
		sourceType: "human_confirmation",
		sourceRef: `confirmation:${key}:v1`,
	};
}

function unverified(fact: RequirementFactV1): RequirementFactV1 {
	return {
		...fact,
		status: "unverified",
		sourceType: "user_input",
		sourceRef: `message:${fact.key}:v1`,
	};
}

const printFacts = [
	verified("product_type", "咖啡豆自立拉链袋"),
	verified("quantity", 10_000, "pcs"),
	verified("dimensions", "160 × 230 + 80 mm"),
	verified("target_market", "香港"),
	verified("target_delivery", "2026-11-30"),
	verified("delivery_location", "Hong Kong"),
	verified("artwork_status", "品牌稿件待提供"),
];

const furnitureFacts = [
	verified("furniture_type", "办公桌"),
	verified("quantity", 20, "sets"),
	verified("dimensions", "1400 × 700 × 750 mm"),
	verified("use_environment", "室内办公室"),
	verified("target_delivery", "2026-12-15"),
	verified("delivery_location", "Hong Kong"),
	verified("installation_required", true),
];

function without(facts: RequirementFactV1[], key: string): RequirementFactV1[] {
	return facts.filter((fact) => fact.key !== key);
}

function replace(
	facts: RequirementFactV1[],
	key: string,
	change: (fact: RequirementFactV1) => RequirementFactV1,
): RequirementFactV1[] {
	return facts.map((fact) => fact.key === key ? change(fact) : fact);
}

function values(
	facts: RequirementFactV1[],
	changes: Record<string, RequirementFactV1["value"]>,
): RequirementFactV1[] {
	return facts.map((fact) => fact.key in changes
		? { ...fact, value: changes[fact.key]! }
		: fact);
}

function brief(input: {
	industry: ManufacturingIndustry;
	title: string;
	goal: string;
	facts: RequirementFactV1[];
	missing?: string[];
	nextAction?: RequirementBriefV1["nextAction"];
}): RequirementBriefV1 {
	return {
		schemaVersion: "requirement-brief.v1",
		industry: input.industry,
		title: input.title,
		customerGoal: input.goal,
		facts: input.facts,
		missingRequiredFacts: input.missing ?? [],
		assumptions: [],
		nextAction: input.nextAction ?? "ready_for_approval",
	};
}

export const requirementBriefFixtures: RequirementBriefFixture[] = [
	{
		fixtureId: "print-coffee-pouch-ready",
		industry: "print",
		input: "香港市场咖啡豆自立袋，1 万个，尺寸 160 × 230 + 80 mm，11 月底交付，稿件稍后提供。",
		expectedApprovalEligible: true,
		artifact: brief({
			industry: "print",
			title: "咖啡豆自立袋需求单",
			goal: "形成可交给包装工程师评估的已确认需求",
			facts: printFacts,
		}),
	},
	{
		fixtureId: "print-cosmetic-carton-missing-dimensions",
		industry: "print",
		input: "5000 个香港市场护肤品折叠纸盒，尺寸还没有确定，12 月交付。",
		expectedApprovalEligible: false,
		artifact: brief({
			industry: "print",
			title: "护肤品折叠纸盒需求单",
			goal: "确认报价和结构设计所需输入",
			facts: without(values(printFacts, {
				product_type: "护肤品折叠纸盒",
				quantity: 5_000,
				target_delivery: "2026-12-15",
			}), "dimensions"),
			missing: ["dimensions"],
			nextAction: "clarify",
		}),
	},
	{
		fixtureId: "print-label-unverified-market",
		industry: "print",
		input: "先做一批产品标签，市场可能是香港，请整理需求。",
		expectedApprovalEligible: false,
		artifact: brief({
			industry: "print",
			title: "产品标签需求单",
			goal: "冻结标签项目输入",
			facts: replace(values(printFacts, {
				product_type: "产品标签",
				quantity: 20_000,
				dimensions: "80 × 50 mm",
			}), "target_market", unverified),
			nextAction: "confirm_facts",
		}),
	},
	{
		fixtureId: "print-booklet-ready",
		industry: "print",
		input: "企业培训手册 2000 本，A4 成品，香港交货，全部需求已确认。",
		expectedApprovalEligible: true,
		artifact: brief({
			industry: "print",
			title: "企业培训手册需求单",
			goal: "交付印刷工程和报价评估",
			facts: values(printFacts, {
				product_type: "企业培训手册",
				quantity: 2_000,
				dimensions: "A4",
				artwork_status: "定稿已提供",
			}),
		}),
	},
	{
		fixtureId: "print-poster-missing-artwork",
		industry: "print",
		input: "门店海报需要月底前到货，但还没有确认稿件状态。",
		expectedApprovalEligible: false,
		artifact: brief({
			industry: "print",
			title: "门店海报需求单",
			goal: "确认海报生产输入",
			facts: without(values(printFacts, {
				product_type: "门店海报",
				quantity: 100,
				dimensions: "A1",
				target_delivery: "2026-09-30",
			}), "artwork_status"),
			missing: ["artwork_status"],
			nextAction: "clarify",
		}),
	},
	{
		fixtureId: "furniture-office-desk-ready",
		industry: "furniture",
		input: "办公室需要 20 套 1400mm 办公桌，香港交货并安装，12 月中完成。",
		expectedApprovalEligible: true,
		artifact: brief({
			industry: "furniture",
			title: "办公室桌具需求单",
			goal: "形成可交给设计和报价人员的已确认需求",
			facts: furnitureFacts,
		}),
	},
	{
		fixtureId: "furniture-wardrobe-missing-installation",
		industry: "furniture",
		input: "酒店房间定制衣柜，安装责任还没确定。",
		expectedApprovalEligible: false,
		artifact: brief({
			industry: "furniture",
			title: "酒店衣柜需求单",
			goal: "识别设计与安装交接条件",
			facts: without(values(furnitureFacts, {
				furniture_type: "酒店房间衣柜",
				quantity: 50,
				dimensions: "1800 × 600 × 2400 mm",
				use_environment: "酒店客房室内",
			}), "installation_required"),
			missing: ["installation_required"],
			nextAction: "clarify",
		}),
	},
	{
		fixtureId: "furniture-retail-shelf-unverified-quantity",
		industry: "furniture",
		input: "新门店需要陈列架，数量大约 20 套，请先整理。",
		expectedApprovalEligible: false,
		artifact: brief({
			industry: "furniture",
			title: "门店陈列架需求单",
			goal: "冻结门店陈列架采购需求",
			facts: replace(values(furnitureFacts, {
				furniture_type: "门店陈列架",
				quantity: 20,
				dimensions: "900 × 450 × 2100 mm",
				use_environment: "室内零售门店",
			}), "quantity", unverified),
			nextAction: "confirm_facts",
		}),
	},
	{
		fixtureId: "furniture-meeting-table-ready",
		industry: "furniture",
		input: "两张会议桌，室内使用，尺寸、交期、送装地点均已确认。",
		expectedApprovalEligible: true,
		artifact: brief({
			industry: "furniture",
			title: "会议桌需求单",
			goal: "进入设计与报价阶段",
			facts: values(furnitureFacts, {
				furniture_type: "会议桌",
				quantity: 2,
				dimensions: "2800 × 1200 × 750 mm",
				installation_required: false,
			}),
		}),
	},
	{
		fixtureId: "furniture-reception-missing-location",
		industry: "furniture",
		input: "定制接待台一套，具体送货地点待客户确认。",
		expectedApprovalEligible: false,
		artifact: brief({
			industry: "furniture",
			title: "接待台需求单",
			goal: "补齐现场和物流输入",
			facts: without(values(furnitureFacts, {
				furniture_type: "定制接待台",
				quantity: 1,
				dimensions: "2400 × 700 × 1100 mm",
			}), "delivery_location"),
			missing: ["delivery_location"],
			nextAction: "clarify",
		}),
	},
];
