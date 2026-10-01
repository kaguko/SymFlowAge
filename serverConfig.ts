import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Load default .env
dotenv.config();

// 2. Load .env.local if present (useful for local development overrides)
const localEnvPath = path.resolve(__dirname, '.env.local');
if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath, override: true });
}

/**
 * Function to resolve API key from:
 * 1) process.env.GEMINI_API_KEY (injected by AI Studio / Cloud Run / .env / .env.local)
 * 2) untracked local api-keys.json file (if created by developer)
 */
function resolveGeminiApiKey(): string | undefined {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== '') {
    return process.env.GEMINI_API_KEY.trim();
  }
  if (process.env.VITE_GEMINI_API_KEY && process.env.VITE_GEMINI_API_KEY.trim() !== '') {
    return process.env.VITE_GEMINI_API_KEY.trim();
  }

  // Fallback check: untracked local api-keys.json
  const keysFilePath = path.resolve(__dirname, 'api-keys.json');
  if (fs.existsSync(keysFilePath)) {
    try {
      const raw = fs.readFileSync(keysFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.GEMINI_API_KEY) {
        return String(parsed.GEMINI_API_KEY).trim();
      }
      if (parsed?.geminiApiKey) {
        return String(parsed.geminiApiKey).trim();
      }
    } catch {
      // Ignore JSON parse errors in local fallback
    }
  }

  return undefined;
}

export const serverConfig = {
  geminiApiKey: resolveGeminiApiKey(),
  port: Number(process.env.PORT) || 3000,
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  isApiKeyConfigured: () => Boolean(resolveGeminiApiKey()),
};
