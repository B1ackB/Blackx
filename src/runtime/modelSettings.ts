export interface ModelSettingsView {
	revision: number;
	mode: "fake" | "anthropic";
	baseUrl: string;
	model: string;
	keyConfigured: boolean;
	restartRequired: boolean;
}
export interface ModelSettingsInput {
	revision: number;
	mode: "fake" | "anthropic";
	baseUrl: string;
	model: string;
	apiKey?: string;
	clearKey?: boolean;
}
