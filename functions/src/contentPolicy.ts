/** v1 content policy: single-token ASCII words, small profanity blocklist. */

const PROFANITY = new Set(['fuck', 'shit', 'damn']);

export function assertAllowedWord(raw: string): void {
  const w = raw.trim().toLowerCase();
  if (!w.length) {
    throw new Error('empty_word');
  }
  if (!/^[a-z]+$/.test(w)) {
    throw new Error('non_ascii_letters');
  }
  if (w.includes(' ')) {
    throw new Error('multi_token');
  }
  if (PROFANITY.has(w)) {
    throw new Error('profanity');
  }
}

export function filterVocab(words: string[]): string[] {
  return words.filter(w => {
    try {
      assertAllowedWord(w);
      return true;
    } catch {
      return false;
    }
  });
}
