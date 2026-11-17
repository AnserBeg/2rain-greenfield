/**
 * Model keys. A key already in the environment wins; otherwise the file named
 * by `NORTH_STAR_AGENT_KEY_FILE` is read and exactly two names are taken from
 * it. No value, and no line of the file, is ever printed, logged or put in an
 * error: a missing key fails naming the variable only.
 */
import { readFile } from 'node:fs/promises';

export type ModelProvider = 'anthropic' | 'openai';

export const AGENT_KEY_FILE_VARIABLE = 'NORTH_STAR_AGENT_KEY_FILE';

/** File name -> provider. `CLUADE_API_KEY` is spelled so in the owner's file. */
const fileNames: Readonly<Record<ModelProvider, string>> = {
  anthropic: 'CLUADE_API_KEY',
  openai: 'OPENAI_API_KEY',
};
const environmentNames: Readonly<Record<ModelProvider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export class MissingModelKeyError extends Error {
  override name = 'MissingModelKeyError';
}

/** A key held so that printing it, by accident, shows nothing. */
export class ModelKey {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return '[model key]';
  }
  toJSON(): string {
    return '[model key]';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[model key]';
  }
}

export async function loadModelKey(
  provider: ModelProvider,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ModelKey> {
  const fromEnvironment = environment[environmentNames[provider]]?.trim();
  if (fromEnvironment) return new ModelKey(fromEnvironment);
  const path = environment[AGENT_KEY_FILE_VARIABLE];
  if (!path)
    throw new MissingModelKeyError(
      `no ${environmentNames[provider]} in the environment and ${AGENT_KEY_FILE_VARIABLE} is not set`,
    );
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new MissingModelKeyError(
      `${AGENT_KEY_FILE_VARIABLE} names a file that cannot be read`,
    );
  }
  const value = keyFromFile(text, fileNames[provider]);
  if (!value)
    throw new MissingModelKeyError(
      `${fileNames[provider]} is not set in the file named by ${AGENT_KEY_FILE_VARIABLE}`,
    );
  return new ModelKey(value);
}

/** The value of one `NAME=value` line; CRLF endings and quotes stripped. */
export function keyFromFile(text: string, name: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/\r$/u, '')
      .trim()
      .replace(/^export\s+/u, '');
    if (!line.startsWith(`${name}=`)) continue;
    const value = line
      .slice(name.length + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/u, '$2');
    return value === '' ? null : value;
  }
  return null;
}
