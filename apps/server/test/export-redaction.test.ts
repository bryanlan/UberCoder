import { expect, it } from 'vitest';
import contract from '../src/engineering/export_redaction.v1.json' with { type: 'json' };
import { redactText, sanitizeExport } from '../src/engineering/export-redaction.js';

it.each(contract.cases)('applies shared export redaction: $input', ({ input, expected }) => {
  expect(redactText(input)).toBe(expected);
});
it.each(contract.object_cases)('preserves identifiers and counts while masking structured credentials', ({ input, expected }) => {
  expect(sanitizeExport(input)).toEqual(expected);
});
it('sanitizes arrays and nested sensitive fields while preserving public token counts', () => {
  expect(sanitizeExport({ title: 'postgres://private-host/db', nested: [{ RESEND_API_KEY: 'synthetic',
    total_tokens: 4200 }] })).toEqual({ title: '[connection URL omitted]',
    nested: [{ RESEND_API_KEY: '[credential omitted]', total_tokens: 4200 }] });
});
