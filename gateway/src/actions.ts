import { z } from 'zod';

// Mirrors episodes.action_payload in the Python harness: normalized 0-1 image coordinates.
const coordinate = z.number().min(0).max(1);

export const phoneActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tap'), x: coordinate, y: coordinate }).strict(),
  z.object({ type: z.literal('scroll'), x: coordinate, y: coordinate, dy: z.number().min(-1000).max(1000) }).strict(),
  z.object({ type: z.literal('type'), text: z.string().trim().min(1).max(500) }).strict(),
  z.object({ type: z.literal('home') }).strict(),
  z.object({ type: z.literal('wait'), seconds: z.number().min(0).max(30) }).strict(),
]);

export type PhoneAction = z.infer<typeof phoneActionSchema>;

export const commandResultSchema = z.object({
  id: z.string().uuid(),
  ok: z.boolean(),
  receipt: z.unknown().optional(),
  error: z.string().max(2000).optional(),
});
