export const MAX_CONTENT_LENGTH = 2000;
export const MAX_ARTICLE_TEXT_LENGTH = 8000;
export const MAX_CAPTION_LENGTH = 1020;
export const MAX_MESSAGE_LENGTH = 4090;
export const MAX_RETRY_COUNT = 3;
export const PROCESSING_TIMEOUT_MINUTES = 10;
export const GEMINI_MODEL = 'gemini-3.1-flash-lite';
export const GEMMA_MODEL = 'gemma-4-31b-it';
export const PROCESS_BATCH_SIZE = 5;

export const BATCH_SELECT_SIZE = 300;
export const SELECT_TOP_N = 10;

export const MIN_RELEVANCE_SCORE = 4;

export const MAX_ARTICLE_AGE_HOURS = 24;

export const DELIVERY_START_HOUR = 9;
export const DELIVERY_END_HOUR = 21;
export const MAX_MESSAGES_PER_HOUR = 10;
export const MAX_SAME_CATEGORY_IN_ROW = 3;
export const TIMEZONE = 'Asia/Tehran';

export const RELEVANT_KEYWORDS: Record<string, string[]> = {
  ai: [
    'ai', 'artificial intelligence', 'llm', 'gpt', 'chatgpt', 'openai',
    'anthropic', 'claude', 'gemini', 'machine learning', 'deep learning',
    'neural network', 'transformer', 'fine-tuning', 'fine tuning', 'rag',
    'embedding', 'copilot', 'agi', 'generative ai', 'diffusion',
    'stable diffusion', 'midjourney', 'sora', 'dalle', 'grok',
    'language model', 'foundation model', 'inference', 'training data',
    'gpu', 'nvidia', 'tpu', 'attention mechanism', 'token', 'prompt',
  ],
  programming: [
    'programming', 'coding', 'developer', 'software engineer', 'api',
    'react', 'vue', 'angular', 'svelte', 'python', 'javascript',
    'typescript', 'rust', 'golang', 'java ', 'c++', 'c#', 'php', 'ruby',
    'node.js', 'deno', 'bun', 'framework', 'library', 'github', 'gitlab',
    'docker', 'kubernetes', 'ci/cd', 'devops', 'serverless', 'microservice',
    'sql', 'nosql', 'database', 'compiler', 'webpack', 'vite', 'npm',
    'pnpm', 'yarn', 'debugging', 'vulnerability', 'cve', 'patched',
    'open source', 'linux', 'kernel', 'bash', 'shell', 'terraform',
    'cloudflare', 'aws', 'azure', 'gcp', 'pipeline', 'refactor',
  ],
  gaming: [
    'game', 'gaming', 'playstation', 'xbox', 'nintendo', 'switch',
    'steam', 'valve', 'unity', 'unreal engine', 'aaa game', 'game release',
    'game dev', 'game engine', 'early access', 'dlc', 'expansion',
    'bethesda', 'ea sports', 'ubisoft', 'cd projekt', 'rockstar',
    'fromsoftware', 'blizzard', 'activision', 'riot games', 'epic games',
    'game awards', 'steam deck', 'vr game', 'ps5', 'ps6', 'xbox series',
    'nintendo switch', 'gameplay', 'trailer', 'release date', 'beta test',
    'game studio', 'indie game', 'modding', 'speedrun', 'esports',
    'counter-strike', 'valorant', 'league of legends', 'dota',
  ],
};
