import { z } from 'zod';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function hasOnlyUnicodeScalarValues(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function isCanonicalVaultPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.normalize('NFC') !== path ||
    !hasOnlyUnicodeScalarValues(path)
  ) {
    return false;
  }

  const segments = path.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export const canonicalVaultPathSchema = z
  .string()
  .refine(isCanonicalVaultPath, 'Path must be a canonical vault-relative path.');
export const sha256Schema = z
  .string()
  .regex(SHA256_PATTERN, 'Expected a lowercase SHA-256 hex digest.');
export const identifierSchema = z.string().min(1);
export const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();
