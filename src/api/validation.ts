import { z } from 'zod';
import type { Context } from 'hono';

// Asset types enum
const AssetTypeEnum = z.enum([
  'battlecard', 'talk_track', 'launch_messaging', 'social_hook',
  'one_pager', 'email_copy', 'messaging_template', 'narrative',
]);

// Pipeline enum
const PipelineEnum = z.enum([
  'standard', 'straight-through', 'outside-in', 'adversarial', 'multi-perspective',
]);

// POST /api/generate
export const GenerateRequestSchema = z.object({
  productDocs: z.string().min(1, 'productDocs is required').max(500000, 'productDocs exceeds 500k character limit'),
  existingMessaging: z.string().max(500000).optional(),
  prompt: z.string().max(10000).optional(),
  voiceProfileIds: z.array(z.string().min(1)).min(1, 'At least one voiceProfileId is required'),
  assetTypes: z.array(AssetTypeEnum).min(1, 'At least one assetType is required'),
  model: z.string().min(1).optional(),
  pipeline: PipelineEnum.optional().default('standard'),
});

// POST /api/extract
export const ExtractRequestSchema = z.object({
  fileId: z.string().min(1, 'fileId is required'),
  name: z.string().optional(),
});

// POST /api/auth/login
export const LoginRequestSchema = z.object({
  username: z.string().min(1, 'username is required'),
  password: z.string().min(1, 'password is required'),
});

// POST /api/auth/signup
export const SignupRequestSchema = z.object({
  username: z.string().min(2).max(50),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().min(1).max(100),
});

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
export type ExtractRequest = z.infer<typeof ExtractRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

/**
 * Validate request body against a Zod schema. Returns parsed data or sends 400 response.
 */
export async function validateBody<T>(c: Context, schema: z.ZodSchema<T>): Promise<T | null> {
  try {
    const body = await c.req.json();
    const result = schema.safeParse(body);
    if (!result.success) {
      c.status(400);
      // We need to use a workaround since we return null to signal failure
      (c as any).__validationError = {
        error: 'Validation failed',
        details: result.error.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      };
      return null;
    }
    return result.data;
  } catch {
    c.status(400);
    (c as any).__validationError = { error: 'Invalid JSON body' };
    return null;
  }
}

/**
 * Get the validation error response (call after validateBody returns null).
 */
export function validationError(c: Context): Response {
  const err = (c as any).__validationError || { error: 'Validation failed' };
  return c.json(err, 400);
}
