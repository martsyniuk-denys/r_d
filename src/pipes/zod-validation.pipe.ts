import { z } from 'zod';

import { ValidationError, type FieldError } from '../errors';
import type { ArgumentMetadata, PipeTransform } from '../lifecycle';

export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = metadata.schema;

    if (!(schema instanceof z.ZodType)) return value;

    const result = schema.safeParse(value);

    if (!result.success) {
      throw new ValidationError(toFieldErrors(result.error));
    }

    return result.data;
  }
}

function toFieldErrors(error: z.ZodError): FieldError[] {
  const byField = new Map<string, string[]>();

  for (const issue of error.issues) {
    const field = issue.path.length > 0 ? issue.path.join('.') : '(body)';
    const constraints = byField.get(field) ?? [];

    constraints.push(issue.message);
    byField.set(field, constraints);
  }

  return [...byField].map(([field, constraints]) => ({ field, constraints }));
}
