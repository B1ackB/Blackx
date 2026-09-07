export type Language = "zh" | "en";

export const languageNames: Record<Language, string> = {
	zh: "中文",
	en: "English",
};

export const fieldLabels: Record<Language, Record<string, string>> = {
	zh: {},
	en: {
		product_type: "Packaging type",
		quantity: "Quantity",
		dimensions: "Dimensions",
		target_market: "Target market",
		target_delivery: "Target delivery date",
		delivery_location: "Delivery location",
		artwork_status: "Artwork status",
	},
};

export const factStatusText: Record<Language, Record<string, string>> = {
	zh: {},
	en: { suggested: "Suggested", unverified: "Unverified", verified: "Verified", rejected: "Rejected" },
};

export function labelFor(language: Language, key: string, fallback: string): string {
	return fieldLabels[language][key] ?? fallback;
}

export function statusFor(language: Language, key: string, fallback: string): string {
	return factStatusText[language][key] ?? fallback;
}
