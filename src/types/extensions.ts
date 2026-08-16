export interface ExtensionBase {
  id: string;
  nameKey: string;
  enabled: boolean;
}

/** 翻译扩展：provider 决定调用哪个后端提供商，settings 为提供商专属配置。 */
export interface TranslationExtension extends ExtensionBase {
  kind: "translation";
  provider: string;
  sourceLanguage: string;
  targetLanguage: string;
  settings: Record<string, string>;
}

/** 工具扩展（作用于原文或译文，按数组顺序执行）。 */
export interface ToolExtension extends ExtensionBase {
  kind: "tool";
  tool: string;
  settings: Record<string, string>;
}

export type Extension = TranslationExtension | ToolExtension;

export interface LangOption {
  label: string;
  value: string;
}

export interface FieldDef {
  key: string;
  labelKey: string;
  placeholder?: string;
  helpKey?: string;
  type?: "text" | "password" | "select" | "file" | "number" | "checkbox";
  options?: string[];
}

export interface TranslatorDef {
  id: string;
  nameKey: string;
  /** 需要填写的设置字段（settings 里的 key）。 */
  fields: FieldDef[];
  /** 源语言候选（value 即该服务的 API 语言码）。 */
  languages: LangOption[];
  /** 目标语言候选（省略则与 languages 相同）。 */
  targetLanguages?: LangOption[];
  defaultSource: string;
  defaultTarget: string;
}

export interface ToolDef {
  id: string;
  nameKey: string;
  fields: FieldDef[];
}

const AUTO: LangOption = { label: "Auto detect", value: "auto" };

function langs(pairs: [string, string][]): LangOption[] {
  return pairs.map(([label, value]) => ({ label, value }));
}

// Google / Google2：ISO 码。
const GOOGLE_LANGUAGES: LangOption[] = [
  AUTO,
  ...langs([
    ["Afrikaans", "af"],
    ["Albanian", "sq"],
    ["Amharic", "am"],
    ["Arabic", "ar"],
    ["Armenian", "hy"],
    ["Azerbaijani", "az"],
    ["Basque", "eu"],
    ["Belarusian", "be"],
    ["Bengali", "bn"],
    ["Bosnian", "bs"],
    ["Bulgarian", "bg"],
    ["Catalan", "ca"],
    ["Cebuano", "ceb"],
    ["Chinese (Simplified)", "zh-CN"],
    ["Chinese (Traditional)", "zh-TW"],
    ["Corsican", "co"],
    ["Croatian", "hr"],
    ["Czech", "cs"],
    ["Danish", "da"],
    ["Dutch", "nl"],
    ["English", "en"],
    ["Esperanto", "eo"],
    ["Estonian", "et"],
    ["Finnish", "fi"],
    ["French", "fr"],
    ["Frisian", "fy"],
    ["Galician", "gl"],
    ["Georgian", "ka"],
    ["German", "de"],
    ["Greek", "el"],
    ["Gujarati", "gu"],
    ["Haitian Creole", "ht"],
    ["Hausa", "ha"],
    ["Hawaiian", "haw"],
    ["Hebrew", "iw"],
    ["Hindi", "hi"],
    ["Hmong", "hmn"],
    ["Hungarian", "hu"],
    ["Icelandic", "is"],
    ["Igbo", "ig"],
    ["Indonesian", "id"],
    ["Irish", "ga"],
    ["Italian", "it"],
    ["Japanese", "ja"],
    ["Javanese", "jw"],
    ["Kannada", "kn"],
    ["Kazakh", "kk"],
    ["Khmer", "km"],
    ["Korean", "ko"],
    ["Kurdish", "ku"],
    ["Kyrgyz", "ky"],
    ["Lao", "lo"],
    ["Latin", "la"],
    ["Latvian", "lv"],
    ["Lithuanian", "lt"],
    ["Luxembourgish", "lb"],
    ["Macedonian", "mk"],
    ["Malagasy", "mg"],
    ["Malay", "ms"],
    ["Malayalam", "ml"],
    ["Maltese", "mt"],
    ["Maori", "mi"],
    ["Marathi", "mr"],
    ["Mongolian", "mn"],
    ["Myanmar (Burmese)", "my"],
    ["Nepali", "ne"],
    ["Norwegian", "no"],
    ["Nyanja", "ny"],
    ["Pashto", "ps"],
    ["Persian", "fa"],
    ["Polish", "pl"],
    ["Portuguese", "pt"],
    ["Punjabi", "pa"],
    ["Romanian", "ro"],
    ["Russian", "ru"],
    ["Samoan", "sm"],
    ["Scots Gaelic", "gd"],
    ["Serbian", "sr"],
    ["Sesotho", "st"],
    ["Shona", "sn"],
    ["Sindhi", "sd"],
    ["Sinhala", "si"],
    ["Slovak", "sk"],
    ["Slovenian", "sl"],
    ["Somali", "so"],
    ["Spanish", "es"],
    ["Sundanese", "su"],
    ["Swahili", "sw"],
    ["Swedish", "sv"],
    ["Tajik", "tg"],
    ["Tamil", "ta"],
    ["Telugu", "te"],
    ["Thai", "th"],
    ["Turkish", "tr"],
    ["Ukrainian", "uk"],
    ["Urdu", "ur"],
    ["Uzbek", "uz"],
    ["Vietnamese", "vi"],
    ["Welsh", "cy"],
    ["Xhosa", "xh"],
    ["Yiddish", "yi"],
    ["Yoruba", "yo"],
    ["Zulu", "zu"],
  ]),
];

// DeepL：ISO 码（后端转大写）。
const DEEPL_LANGUAGES: LangOption[] = [
  AUTO,
  ...langs([
    ["Bulgarian", "bg"],
    ["Czech", "cs"],
    ["Danish", "da"],
    ["German", "de"],
    ["Greek", "el"],
    ["English", "en"],
    ["Spanish", "es"],
    ["Estonian", "et"],
    ["Finnish", "fi"],
    ["French", "fr"],
    ["Hungarian", "hu"],
    ["Indonesian", "id"],
    ["Italian", "it"],
    ["Japanese", "ja"],
    ["Korean", "ko"],
    ["Lithuanian", "lt"],
    ["Latvian", "lv"],
    ["Norwegian", "nb"],
    ["Dutch", "nl"],
    ["Polish", "pl"],
    ["Portuguese", "pt"],
    ["Romanian", "ro"],
    ["Russian", "ru"],
    ["Slovak", "sk"],
    ["Slovenian", "sl"],
    ["Swedish", "sv"],
    ["Turkish", "tr"],
    ["Ukrainian", "uk"],
    ["Chinese (Simplified)", "zh"],
  ]),
];

// OpenAI / Claude / DeepSeek / Gemini：人类可读语言名（用于提示词）。
const AI_LANGUAGES: LangOption[] = [
  { label: "Auto detect", value: "auto" },
  ...langs([
    ["Simplified Chinese", "Simplified Chinese"],
    ["Traditional Chinese", "Traditional Chinese"],
    ["English", "English"],
    ["Japanese", "Japanese"],
    ["Korean", "Korean"],
    ["French", "French"],
    ["German", "German"],
    ["Spanish", "Spanish"],
    ["Russian", "Russian"],
    ["Portuguese", "Portuguese"],
    ["Italian", "Italian"],
    ["Dutch", "Dutch"],
    ["Polish", "Polish"],
    ["Vietnamese", "Vietnamese"],
    ["Thai", "Thai"],
    ["Indonesian", "Indonesian"],
    ["Arabic", "Arabic"],
    ["Hindi", "Hindi"],
    ["Turkish", "Turkish"],
    ["Custom...", "Custom..."],
  ]),
];

// Baidu：百度语言码。
const BAIDU_LANGUAGES: LangOption[] = [
  AUTO,
  ...langs([
    ["Chinese (Simplified)", "zh"],
    ["Chinese (Traditional)", "cht"],
    ["English", "en"],
    ["Cantonese", "yue"],
    ["Classical Chinese", "wyw"],
    ["Japanese", "jp"],
    ["Korean", "kor"],
    ["French", "fra"],
    ["Spanish", "spa"],
    ["Thai", "th"],
    ["Arabic", "ara"],
    ["Russian", "ru"],
    ["Portuguese", "pt"],
    ["German", "de"],
    ["Italian", "it"],
    ["Greek", "el"],
    ["Dutch", "nl"],
    ["Polish", "pl"],
    ["Bulgarian", "bul"],
    ["Estonian", "est"],
    ["Danish", "dan"],
    ["Finnish", "fin"],
    ["Czech", "cs"],
    ["Romanian", "rom"],
    ["Slovenian", "slo"],
    ["Swedish", "swe"],
    ["Hungarian", "hu"],
    ["Vietnamese", "vie"],
  ]),
];

// Bing / Bing2：Bing 语言码。
const BING_LANGUAGES: LangOption[] = [
  { label: "Auto detect", value: "auto-detect" },
  ...langs([
    ["Afrikaans", "af"],
    ["Arabic", "ar"],
    ["Bulgarian", "bg"],
    ["Bangla", "bn"],
    ["Catalan", "ca"],
    ["Czech", "cs"],
    ["Welsh", "cy"],
    ["Danish", "da"],
    ["German", "de"],
    ["Greek", "el"],
    ["English", "en"],
    ["Spanish", "es"],
    ["Estonian", "et"],
    ["Persian", "fa"],
    ["Finnish", "fi"],
    ["Filipino", "fil"],
    ["Fijian", "fj"],
    ["French", "fr"],
    ["Irish", "ga"],
    ["Galician", "gl"],
    ["Gujarati", "gu"],
    ["Hebrew", "he"],
    ["Hindi", "hi"],
    ["Croatian", "hr"],
    ["Haitian Creole", "ht"],
    ["Hungarian", "hu"],
    ["Armenian", "hy"],
    ["Indonesian", "id"],
    ["Icelandic", "is"],
    ["Italian", "it"],
    ["Japanese", "ja"],
    ["Georgian", "ka"],
    ["Kazakh", "kk"],
    ["Khmer", "km"],
    ["Kannada", "kn"],
    ["Korean", "ko"],
    ["Lao", "lo"],
    ["Lithuanian", "lt"],
    ["Latvian", "lv"],
    ["Malagasy", "mg"],
    ["Maori", "mi"],
    ["Macedonian", "mk"],
    ["Malayalam", "ml"],
    ["Mongolian (Cyrillic)", "mn-Cyrl"],
    ["Marathi", "mr"],
    ["Malay", "ms"],
    ["Maltese", "mt"],
    ["Hmong Daw", "mww"],
    ["Myanmar (Burmese)", "my"],
    ["Norwegian", "nb"],
    ["Nepali", "ne"],
    ["Dutch", "nl"],
    ["Punjabi", "pa"],
    ["Polish", "pl"],
    ["Pashto", "ps"],
    ["Portuguese (Brazil)", "pt"],
    ["Romanian", "ro"],
    ["Russian", "ru"],
    ["Sindhi", "sd"],
    ["Sinhala", "si"],
    ["Slovak", "sk"],
    ["Slovenian", "sl"],
    ["Samoan", "sm"],
    ["Shona", "sn"],
    ["Somali", "so"],
    ["Albanian", "sq"],
    ["Serbian (Cyrillic)", "sr-Cyrl"],
    ["Serbian (Latin)", "sr-Latn"],
    ["Swedish", "sv"],
    ["Swahili", "sw"],
    ["Tamil", "ta"],
    ["Telugu", "te"],
    ["Thai", "th"],
    ["Turkish", "tr"],
    ["Tatar", "tt"],
    ["Tahitian", "ty"],
    ["Ukrainian", "uk"],
    ["Urdu", "ur"],
    ["Uzbek (Latin)", "uz"],
    ["Vietnamese", "vi"],
    ["Xhosa", "xh"],
    ["Yoruba", "yo"],
    ["Cantonese (Traditional)", "yue"],
    ["Chinese Simplified", "zh-Hans"],
    ["Chinese Traditional", "zh-Hant"],
    ["Zulu", "zu"],
  ]),
];

// Aliyun：ISO 码（中文 zh / zh-tw）。
const ALIYUN_LANGUAGES: LangOption[] = [
  AUTO,
  ...langs([
    ["Albanian", "sq"],
    ["Amharic", "am"],
    ["Arabic", "ar"],
    ["Armenian", "hy"],
    ["Azerbaijani", "az"],
    ["Belarusian", "be"],
    ["Bengali", "bn"],
    ["Bosnian", "bs"],
    ["Bulgarian", "bg"],
    ["Catalan", "ca"],
    ["Cebuano", "ceb"],
    ["Simplified Chinese", "zh"],
    ["Traditional Chinese", "zh-tw"],
    ["Croatian", "hr"],
    ["Czech", "cs"],
    ["Danish", "da"],
    ["Dutch", "nl"],
    ["English", "en"],
    ["Esperanto", "eo"],
    ["Estonian", "et"],
    ["Finnish", "fi"],
    ["French", "fr"],
    ["Georgian", "ka"],
    ["German", "de"],
    ["Greek", "el"],
    ["Gujarati", "gu"],
    ["Haitian", "ht"],
    ["Hausa", "ha"],
    ["Hebrew", "he"],
    ["Hindi", "hi"],
    ["Hungarian", "hu"],
    ["Icelandic", "is"],
    ["Igbo", "ig"],
    ["Indonesian", "id"],
    ["Irish", "ga"],
    ["Italian", "it"],
    ["Japanese", "ja"],
    ["Javanese", "jv"],
    ["Kannada", "kn"],
    ["Kazakh", "kk"],
    ["Khmer", "km"],
    ["Korean", "ko"],
    ["Kurdish", "ku"],
    ["Kyrgyz", "ky"],
    ["Lao", "lo"],
    ["Latin", "la"],
    ["Latvian", "lv"],
    ["Lithuanian", "lt"],
    ["Luxembourgish", "lb"],
    ["Macedonian", "mk"],
    ["Malagasy", "mg"],
    ["Malay", "ms"],
    ["Malayalam", "ml"],
    ["Maltese", "mt"],
    ["Maori", "mi"],
    ["Marathi", "mr"],
    ["Mongolian", "mn"],
    ["Myanmar (Burmese)", "my"],
    ["Nepali", "ne"],
    ["Norwegian", "no"],
    ["Pashto", "ps"],
    ["Persian", "fa"],
    ["Polish", "pl"],
    ["Portuguese", "pt"],
    ["Punjabi", "pa"],
    ["Romanian", "ro"],
    ["Russian", "ru"],
    ["Samoan", "sm"],
    ["Serbian", "sr"],
    ["Sinhala", "si"],
    ["Slovak", "sk"],
    ["Slovenian", "sl"],
    ["Somali", "so"],
    ["Spanish", "es"],
    ["Swahili", "sw"],
    ["Swedish", "sv"],
    ["Tajik", "tg"],
    ["Tamil", "ta"],
    ["Telugu", "te"],
    ["Thai", "th"],
    ["Turkish", "tr"],
    ["Ukrainian", "uk"],
    ["Urdu", "ur"],
    ["Uzbek", "uz"],
    ["Vietnamese", "vi"],
    ["Welsh", "cy"],
    ["Xhosa", "xh"],
    ["Yoruba", "yo"],
    ["Zulu", "zu"],
  ]),
];

// Tencent：腾讯云语言码。
const TENCENT_LANGUAGES: LangOption[] = langs([
  ["Chinese (Simplified)", "zh"],
  ["Chinese (Traditional)", "zh-TW"],
  ["English", "en"],
  ["Japanese", "ja"],
  ["Korean", "ko"],
  ["French", "fr"],
  ["Spanish", "es"],
  ["Italian", "it"],
  ["German", "de"],
  ["Turkish", "tr"],
  ["Russian", "ru"],
  ["Portuguese", "pt"],
  ["Vietnamese", "vi"],
  ["Indonesian", "id"],
  ["Thai", "th"],
  ["Malay", "ms"],
  ["Arabic", "ar"],
  ["Hindi", "hi"],
]);

// Tencent transmart：免费端点语言码。
const TRANSMART_LANGUAGES: LangOption[] = [
  AUTO,
  ...langs([
    ["Arabic", "ar"],
    ["German", "de"],
    ["Russian", "ru"],
    ["French", "fr"],
    ["Korean", "ko"],
    ["Portuguese", "pt"],
    ["Japanese", "ja"],
    ["Thai", "th"],
    ["Turkish", "tr"],
    ["Spanish", "es"],
    ["Italian", "it"],
    ["English", "en"],
    ["Vietnamese", "vi"],
    ["Cantonese", "ct"],
    ["Chinese", "zh"],
  ]),
];

// Lingocloud（彩云小译）：源/目标语言不同。
const LINGOCLOUD_FROM: LangOption[] = [
  AUTO,
  ...langs([
    ["Chinese (Simplified)", "zh"],
    ["Chinese (Traditional)", "zh-Hant"],
    ["English", "en"],
    ["Japanese", "ja"],
    ["Korean", "ko"],
    ["German", "de"],
    ["Spanish", "es"],
    ["French", "fr"],
    ["Italian", "it"],
    ["Portuguese", "pt"],
    ["Russian", "ru"],
    ["Turkish", "tr"],
    ["Vietnamese", "vi"],
  ]),
];

const LINGOCLOUD_TO: LangOption[] = langs([
  ["Chinese (Simplified)", "zh"],
  ["Chinese (Traditional)", "zh-Hant"],
  ["English", "en"],
  ["Japanese", "ja"],
  ["Korean", "ko"],
]);

export const TRANSLATOR_DEFS: TranslatorDef[] = [
  { id: "google", nameKey: "extensions.google", fields: [], languages: GOOGLE_LANGUAGES, defaultSource: "ja", defaultTarget: "zh-CN" },
  { id: "google2", nameKey: "extensions.google2", fields: [], languages: GOOGLE_LANGUAGES, defaultSource: "ja", defaultTarget: "zh-CN" },
  {
    id: "deepl",
    nameKey: "extensions.deepl",
    fields: [{ key: "apiKey", labelKey: "extensions.apiKey", type: "password" }],
    languages: DEEPL_LANGUAGES,
    defaultSource: "ja",
    defaultTarget: "zh",
  },
  {
    id: "openai",
    nameKey: "extensions.openai",
    fields: [
      { key: "baseUrl", labelKey: "extensions.baseUrl", placeholder: "https://api.openai.com" },
      { key: "apiKey", labelKey: "extensions.apiKey", type: "password" },
      { key: "model", labelKey: "extensions.model", placeholder: "gpt-4o-mini" },
      { key: "contextSentences", labelKey: "extensions.contextSentences", type: "select", options: ["0", "3", "5"] },
    ],
    languages: AI_LANGUAGES,
    defaultSource: "Japanese",
    defaultTarget: "Simplified Chinese",
  },
  {
    id: "baidu",
    nameKey: "extensions.baidu",
    fields: [
      { key: "appId", labelKey: "extensions.appId" },
      { key: "appKey", labelKey: "extensions.appKey", type: "password" },
    ],
    languages: BAIDU_LANGUAGES,
    defaultSource: "jp",
    defaultTarget: "zh",
  },
  {
    id: "aliyun",
    nameKey: "extensions.aliyun",
    fields: [
      { key: "version", labelKey: "extensions.edition", type: "select", options: ["free", "general", "pro"] },
      {
        key: "authKey",
        labelKey: "extensions.apiKey",
        type: "password",
        placeholder: "AccessKeyId|AccessKeySecret",
        helpKey: "extensions.aliyunKeyHint",
      },
    ],
    languages: ALIYUN_LANGUAGES,
    defaultSource: "ja",
    defaultTarget: "zh",
  },
  {
    id: "bing",
    nameKey: "extensions.bing",
    fields: [{ key: "apiKey", labelKey: "extensions.apiKey", type: "password", helpKey: "extensions.bingKeyHint" }],
    languages: BING_LANGUAGES,
    defaultSource: "ja",
    defaultTarget: "zh-Hans",
  },
  {
    id: "bing2",
    nameKey: "extensions.bing2",
    fields: [{ key: "apiKey", labelKey: "extensions.apiKey", type: "password", helpKey: "extensions.bingKeyHint" }],
    languages: BING_LANGUAGES,
    defaultSource: "ja",
    defaultTarget: "zh-Hans",
  },
  {
    id: "claude",
    nameKey: "extensions.claude",
    fields: [
      { key: "apiKey", labelKey: "extensions.apiKey", type: "password" },
      { key: "apiHost", labelKey: "extensions.apiHost", placeholder: "api.anthropic.com" },
      { key: "apiPath", labelKey: "extensions.apiPath", placeholder: "/v1/messages" },
      { key: "model", labelKey: "extensions.model", placeholder: "claude-opus-4-7" },
      { key: "systemPrompt", labelKey: "extensions.systemPrompt", type: "text" },
      { key: "temperature", labelKey: "extensions.temperature", type: "number" },
      { key: "enableThinking", labelKey: "extensions.enableThinking", type: "checkbox" },
      { key: "contextSentences", labelKey: "extensions.contextSentences", type: "select", options: ["0", "3", "5"] },
    ],
    languages: AI_LANGUAGES,
    defaultSource: "Japanese",
    defaultTarget: "Simplified Chinese",
  },
  {
    id: "deepseek",
    nameKey: "extensions.deepseek",
    fields: [
      { key: "apiKey", labelKey: "extensions.apiKey", type: "password" },
      { key: "apiHost", labelKey: "extensions.apiHost", placeholder: "api.deepseek.com" },
      { key: "apiPath", labelKey: "extensions.apiPath", placeholder: "/chat/completions" },
      { key: "model", labelKey: "extensions.model", placeholder: "deepseek-v4-flash" },
      { key: "systemPrompt", labelKey: "extensions.systemPrompt", type: "text" },
      { key: "temperature", labelKey: "extensions.temperature", type: "number" },
      { key: "enableThinking", labelKey: "extensions.enableThinking", type: "checkbox" },
      { key: "reasoningEffort", labelKey: "extensions.reasoningEffort", placeholder: "high" },
      { key: "contextSentences", labelKey: "extensions.contextSentences", type: "select", options: ["0", "3", "5"] },
    ],
    languages: AI_LANGUAGES,
    defaultSource: "Japanese",
    defaultTarget: "Simplified Chinese",
  },
  {
    id: "gemini",
    nameKey: "extensions.gemini",
    fields: [
      { key: "apiKey", labelKey: "extensions.apiKey", type: "password" },
      { key: "apiHost", labelKey: "extensions.apiHost", placeholder: "generativelanguage.googleapis.com" },
      { key: "apiPath", labelKey: "extensions.apiPath", placeholder: "/v1beta/models/" },
      { key: "model", labelKey: "extensions.model", placeholder: "gemini-3-flash-preview" },
      { key: "systemPrompt", labelKey: "extensions.systemPrompt", type: "text" },
      { key: "temperature", labelKey: "extensions.temperature", type: "number" },
      { key: "enableThinking", labelKey: "extensions.enableThinking", type: "checkbox" },
      { key: "contextSentences", labelKey: "extensions.contextSentences", type: "select", options: ["0", "3", "5"] },
    ],
    languages: AI_LANGUAGES,
    defaultSource: "Japanese",
    defaultTarget: "Simplified Chinese",
  },
  {
    id: "lingocloud",
    nameKey: "extensions.lingocloud",
    fields: [{ key: "apiKey", labelKey: "extensions.apiKey", type: "password" }],
    languages: LINGOCLOUD_FROM,
    targetLanguages: LINGOCLOUD_TO,
    defaultSource: "ja",
    defaultTarget: "zh",
  },
  {
    id: "tencent",
    nameKey: "extensions.tencent",
    fields: [
      { key: "secretId", labelKey: "extensions.secretId" },
      { key: "secretKey", labelKey: "extensions.secretKey", type: "password" },
    ],
    languages: TENCENT_LANGUAGES,
    defaultSource: "ja",
    defaultTarget: "zh",
  },
  {
    id: "tencenttransmart",
    nameKey: "extensions.tencenttransmart",
    fields: [],
    languages: TRANSMART_LANGUAGES,
    defaultSource: "ja",
    defaultTarget: "zh",
  },
];

export const TOOL_DEFS: ToolDef[] = [
  {
    id: "regex-filter",
    nameKey: "extensions.regexFilter",
    fields: [
      { key: "pattern", labelKey: "extensions.pattern" },
      { key: "filePath", labelKey: "extensions.filterFile", type: "file", helpKey: "extensions.fileHint" },
    ],
  },
  {
    id: "regex-replacer",
    nameKey: "extensions.regexReplacer",
    fields: [
      { key: "pattern", labelKey: "extensions.pattern" },
      { key: "replacement", labelKey: "extensions.replacement" },
    ],
  },
  {
    id: "regex-replacer-translated",
    nameKey: "extensions.regexReplacerTranslated",
    fields: [
      { key: "pattern", labelKey: "extensions.pattern" },
      { key: "replacement", labelKey: "extensions.replacement" },
    ],
  },
  { id: "remove-repeated-chars", nameKey: "extensions.removeRepeatedChars", fields: [] },
  { id: "remove-repeated-leading-sentence", nameKey: "extensions.removeRepeatedLeadingSentence", fields: [] },
  { id: "remove-repeat-phrase", nameKey: "extensions.removeRepeatPhrase", fields: [] },
  {
    id: "remove-repeat-sentence",
    nameKey: "extensions.removeRepeatSentence",
    fields: [{ key: "cacheSize", labelKey: "extensions.cacheSize", type: "number", placeholder: "30" }],
  },
  {
    id: "replacer",
    nameKey: "extensions.replacer",
    fields: [{ key: "filePath", labelKey: "extensions.replacementFile", type: "file", helpKey: "extensions.replacerFileHint" }],
  },
  {
    id: "replacer-language-chars",
    nameKey: "extensions.replacerLanguageChars",
    fields: [{ key: "filePath", labelKey: "extensions.replacementFile", type: "file", helpKey: "extensions.replacerFileHint" }],
  },  { id: "romanji", nameKey: "extensions.romanji", fields: [] },  { id: "copy-clipboard", nameKey: "extensions.copyClipboard", fields: [] },
];

/** 按 id 查找翻译器定义。 */
export function getTranslatorDef(id: string): TranslatorDef | undefined {
  return TRANSLATOR_DEFS.find((def) => def.id === id);
}

/** 按 id 查找工具定义。 */
export function getToolDef(id: string): ToolDef | undefined {
  return TOOL_DEFS.find((def) => def.id === id);
}
