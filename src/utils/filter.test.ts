import { describe, it, expect } from 'vitest';
import { isRelevantArticle } from './filter';

describe('isRelevantArticle', () => {
  it('matches AI articles by keyword', () => {
    expect(isRelevantArticle('OpenAI releases GPT-5', 'New model with improved reasoning')).toBe(true);
    expect(isRelevantArticle('Google Gemini update', 'LLM benchmark results')).toBe(true);
    expect(isRelevantArticle('ChatGPT gets new features', '')).toBe(true);
    expect(isRelevantArticle('NVIDIA GPU shortage', 'Training pipelines affected')).toBe(true);
  });

  it('matches programming articles by keyword', () => {
    expect(isRelevantArticle('React 19 released', 'New hooks and concurrent features')).toBe(true);
    expect(isRelevantArticle('TypeScript 5.4 beta', 'New type inference improvements')).toBe(true);
    expect(isRelevantArticle('Critical vulnerability in OpenSSL', 'CVE patched')).toBe(true);
    expect(isRelevantArticle('Docker vs Kubernetes', 'Container orchestration compared')).toBe(true);
  });

  it('matches gaming articles by keyword', () => {
    expect(isRelevantArticle('PlayStation 6 announced', 'Sony reveals next-gen console')).toBe(true);
    expect(isRelevantArticle('GTA VI trailer drops', 'Rockstar releases first gameplay')).toBe(true);
    expect(isRelevantArticle('Steam Summer Sale', 'Best deals on AAA games')).toBe(true);
    expect(isRelevantArticle('Nintendo Switch 2 leaked', 'New hardware details')).toBe(true);
  });

  it('rejects irrelevant articles', () => {
    expect(isRelevantArticle('Celebrity divorce news', 'Hollywood drama continues')).toBe(false);
    expect(isRelevantArticle('Stock market update', 'Dow Jones drops 200 points')).toBe(false);
    expect(isRelevantArticle('Recipe: best pasta', 'How to make carbonara')).toBe(false);
    expect(isRelevantArticle('Weather forecast', 'Rain expected this weekend')).toBe(false);
  });

  it('matches on title alone when description is empty', () => {
    expect(isRelevantArticle('New Python library for AI', '')).toBe(true);
    expect(isRelevantArticle('Random news', '')).toBe(false);
  });

  it('matches on description alone when title is empty', () => {
    expect(isRelevantArticle('', 'This article discusses machine learning trends')).toBe(true);
    expect(isRelevantArticle('', 'Just some random content about cooking')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isRelevantArticle('OPENAI announces GPT', '')).toBe(true);
    expect(isRelevantArticle('new REACT framework', '')).toBe(true);
    expect(isRelevantArticle('PLAYSTATION news', '')).toBe(true);
  });

  it('matches "game" keyword in gaming context', () => {
    expect(isRelevantArticle('Game of the Year 2024', '')).toBe(true);
    expect(isRelevantArticle('Game engine comparison', 'Unity vs Unreal')).toBe(true);
  });
});
