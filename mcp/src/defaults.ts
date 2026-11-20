declare const HOLDOUT_BUILD_DATA: string | null;
declare const HOLDOUT_BUILD_SITE: string | null;

export const DEFAULT_DATA: string | null = typeof HOLDOUT_BUILD_DATA === "undefined" ? null : HOLDOUT_BUILD_DATA;
export const DEFAULT_SITE: string | null = typeof HOLDOUT_BUILD_SITE === "undefined" ? null : HOLDOUT_BUILD_SITE;
