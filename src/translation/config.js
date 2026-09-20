/** Translation settings are separate from reading preferences; never include an API key. */
export const TRANSLATION_KEY = 'ezr:translation:config';
export const LANGUAGES = Object.freeze([
  ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', '英语'], ['ja', '日语'],
  ['ko', '韩语'], ['fr', '法语'], ['de', '德语'], ['es', '西班牙语'],
  ['ru', '俄语'], ['pt', '葡萄牙语'], ['it', '意大利语'], ['ar', '阿拉伯语'],
]);
export const MODELS = Object.freeze(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat']);
export const ENGLISH_LEVELS = Object.freeze([
  ['A1', 'A1 · 入门'], ['A2', 'A2 · 基础'], ['B1', 'B1 · 中级'],
  ['B2', 'B2 · 中高级'], ['C1', 'C1 · 高级'], ['C2', 'C2 · 熟练'],
]);
export const TRANSLATION_DEFAULTS = Object.freeze({ enabled: true, source: 'auto', target: 'zh-CN', model: 'deepseek-flash',
  provider: 'free', preload: false, explanations: true, wordCards: true, autoSave: false, level: 'B1' });
export const MAX_SELECTION = 2000;
export const MAX_CONTEXT = 12000;

export function normalizeTranslation(raw = {}) {
  const valid = code => LANGUAGES.some(([value]) => code === value);
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    source: raw.source === 'auto' || valid(raw.source) ? raw.source : 'auto',
    target: valid(raw.target) ? raw.target : 'zh-CN',
    model: MODELS.includes(raw.model) ? raw.model : 'deepseek-flash',
    provider: raw.provider === 'deepseek' ? 'deepseek' : 'free',
    preload: raw.preload === true,
    explanations: typeof raw.explanations === 'boolean' ? raw.explanations : true,
    wordCards: typeof raw.wordCards === 'boolean' ? raw.wordCards : true,
    autoSave: raw.autoSave === true,
    level: ENGLISH_LEVELS.some(([value]) => raw.level === value) ? raw.level : 'B1',
  };
}

/** UI preferences must not throw away an unchanged article's translation context. */
export function translationContextKey(raw) {
  const config = normalizeTranslation(raw);
  return JSON.stringify([config.enabled, config.source, config.target, config.model]);
}

export function languageName(code) {
  return LANGUAGES.find(([value]) => value === code)?.[1] || code;
}

/** Retain the beginning, middle and end of long articles without sending their full text. */
export function sampleContext(text) {
  const value = String(text || '').trim();
  if (value.length <= MAX_CONTEXT) return value;
  const size = Math.floor((MAX_CONTEXT - 40) / 3);
  const middle = Math.max(size, Math.floor(value.length / 2) - Math.floor(size / 2));
  return `${value.slice(0, size)}\n[中间节选]\n${value.slice(middle, middle + size)}\n[结尾节选]\n${value.slice(-size)}`;
}
