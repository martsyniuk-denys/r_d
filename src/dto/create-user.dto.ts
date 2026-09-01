import { z } from 'zod';

export const createUserSchema = z
  .object({
    name: z.string().min(2, 'name must be at least 2 characters').max(50),
    email: z.email('email must be a valid email address'),
    age: z.int().min(0).max(150).optional(),
  })
  .strict();

export type CreateUserDto = z.infer<typeof createUserSchema>;
