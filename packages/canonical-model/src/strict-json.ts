import { assertUnicodeScalarString } from './canonicalize.js';
import { CanonicalModelError, diagnostic } from './diagnostics.js';

export interface StrictJsonResult {
  byteLength: number;
  value: unknown;
}

export function parseStrictJson(input: string | Uint8Array): StrictJsonResult {
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let text: string;
  try {
    text =
      typeof input === 'string'
        ? input
        : new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw jsonError(
      'CANON_JSON_INVALID_UTF8',
      'authored JSON must be valid UTF-8',
      'encode the document as UTF-8 without replacement characters',
    );
  }
  if (text.charCodeAt(0) === 0xfeff) {
    throw jsonError(
      'CANON_JSON_BOM_FORBIDDEN',
      'authored JSON does not admit a byte-order mark',
      'remove the leading UTF-8 BOM',
    );
  }
  assertUnicodeScalarString(text, '$');
  const parser = new StrictJsonParser(text);
  return { byteLength: bytes.byteLength, value: parser.parse() };
}

class StrictJsonParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.parseValue('$');
    this.skipWhitespace();
    if (this.index !== this.source.length) this.fail('trailing content');
    return value;
  }

  private parseValue(path: string): unknown {
    this.skipWhitespace();
    const token = this.source[this.index];
    if (token === '{') return this.parseObject(path);
    if (token === '[') return this.parseArray(path);
    if (token === '"') return this.parseString(path);
    if (token === 't') return this.parseLiteral('true', true);
    if (token === 'f') return this.parseLiteral('false', false);
    if (token === 'n') return this.parseLiteral('null', null);
    if (token === '-' || (token !== undefined && /[0-9]/.test(token))) {
      return this.parseNumber();
    }
    this.fail('expected a JSON value');
  }

  private parseObject(path: string): Record<string, unknown> {
    this.index += 1;
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.source[this.index] === '}') {
      this.index += 1;
      return result;
    }
    while (true) {
      this.skipWhitespace();
      if (this.source[this.index] !== '"') this.fail('expected an object key');
      const key = this.parseString(path);
      if (keys.has(key)) {
        throw new CanonicalModelError([
          diagnostic(
            'CANON_JSON_DUPLICATE_KEY',
            `${path}.${key}`,
            'object keys are unique before schema validation',
            'keep exactly one occurrence of the property',
          ),
        ]);
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ':') this.fail('expected a colon');
      this.index += 1;
      result[key] = this.parseValue(`${path}.${key}`);
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === '}') {
        this.index += 1;
        return result;
      }
      if (delimiter !== ',') this.fail('expected a comma or closing brace');
      this.index += 1;
    }
  }

  private parseArray(path: string): unknown[] {
    this.index += 1;
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.source[this.index] === ']') {
      this.index += 1;
      return result;
    }
    while (true) {
      result.push(this.parseValue(`${path}[${result.length}]`));
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === ']') {
        this.index += 1;
        return result;
      }
      if (delimiter !== ',') this.fail('expected a comma or closing bracket');
      this.index += 1;
    }
  }

  private parseString(path: string): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.source.length) {
      const token = this.source[this.index];
      if (!escaped && token === '"') {
        this.index += 1;
        const raw = this.source.slice(start, this.index);
        try {
          const value = JSON.parse(raw) as string;
          assertUnicodeScalarString(value, path);
          return value;
        } catch (error) {
          if (error instanceof CanonicalModelError) throw error;
          this.fail('invalid string escape');
        }
      }
      if (!escaped && token === '\\') {
        escaped = true;
      } else {
        escaped = false;
      }
      this.index += 1;
    }
    this.fail('unterminated string');
  }

  private parseLiteral<T>(spelling: string, value: T): T {
    if (
      this.source.slice(this.index, this.index + spelling.length) !== spelling
    ) {
      this.fail(`invalid ${spelling} literal`);
    }
    this.index += spelling.length;
    return value;
  }

  private parseNumber(): number {
    const remainder = this.source.slice(this.index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      remainder,
    );
    if (!match) this.fail('invalid number');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail('non-finite number');
    return value;
  }

  private skipWhitespace(): void {
    while ([' ', '\n', '\r', '\t'].includes(this.source[this.index] ?? '')) {
      this.index += 1;
    }
  }

  private fail(reason: string): never {
    throw jsonError(
      'CANON_JSON_INVALID',
      `authored JSON is invalid at offset ${this.index}: ${reason}`,
      'supply one complete JSON value using the closed authored schema',
    );
  }
}

function jsonError(
  code: string,
  rule: string,
  acceptedAlternative: string,
): CanonicalModelError {
  return new CanonicalModelError([
    diagnostic(code, '$', rule, acceptedAlternative),
  ]);
}
