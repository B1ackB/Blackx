import { AgentCoreError, type AgentSkill } from "./contracts";

export class SkillRegistry {
	private readonly skills = new Map<string, AgentSkill>();

	constructor(skills: readonly AgentSkill[] = []) {
		for (const skill of skills) this.register(skill);
	}

	register(skill: AgentSkill): void {
		if (!skill.name.trim() || !skill.version.trim() || !skill.instructions.trim()) {
			throw new Error("Skill name, version, and instructions are required");
		}
		if (this.skills.has(skill.name)) throw new Error(`Skill already registered: ${skill.name}`);
		this.skills.set(skill.name, { ...skill });
	}

	resolve(names: readonly string[]): AgentSkill[] {
		return names.map((name) => {
			const skill = this.skills.get(name);
			if (!skill) throw new AgentCoreError("context_failure", `Unknown skill: ${name}`, false);
			return { ...skill };
		});
	}
}
