import { DEFAULT_SETTINGS, MODULE_NAME } from './constants.js';

/** Allowed ranges for numeric settings. */
export const NUMBER_LIMITS = {
    contextChars: [0, 2000],
    maxVariants: [1, 5],
    maxBatchTokens: [200, 20000],
    maxTermsPerBatch: [1, 200],
    maxConcurrency: [1, 8],
    maxRetries: [0, 5],
    responseTokens: [256, 65536],
    requestTimeout: [0, 3600],
    temperature: [0, 2],
    lbcResponseTokens: [512, 131072],
    lbcRequestTimeout: [0, 3600],
    lbcTemperature: [0, 2],
    lbcExpandMessages: [0, 200],
};

/** Tagged-template translation through SillyTavern's i18n (resolved at call time, after locales load). */
export const t = (strings, ...values) => SillyTavern.getContext().t(strings, ...values);

export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    extensionSettings[MODULE_NAME] ??= {};
    const settings = extensionSettings[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(settings, key)) settings[key] = structuredClone(value);
    }
    return settings;
}

export function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

/**
 * @param {string} key
 * @param {unknown} value
 */
export function clampSetting(key, value) {
    const [min, max] = NUMBER_LIMITS[key] ?? [-Infinity, Infinity];
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_SETTINGS[key];
    return Math.min(max, Math.max(min, number));
}
