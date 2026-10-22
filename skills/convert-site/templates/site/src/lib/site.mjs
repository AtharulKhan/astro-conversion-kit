// Site-wide constants. The build stays noindex until a release build sets PUBLIC_INDEXABLE=true.
export const INDEXABLE = process.env.PUBLIC_INDEXABLE === 'true';
export const PROPOSALS_ON = process.env.PROPOSALS === 'on';
export const SITE_NAME = {{SITE_NAME_JS}};
export const ORIGIN = {{ORIGIN_JS}};
