import { z } from 'zod';

// Optional fields accept null as well — Gemini occasionally emits null instead of omitting,
// and our pre-parse sanitizer rewrites bare `undefined` tokens to `null`.
const optionalString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v == null ? undefined : v));

const uuidArray = z
  .union([z.array(z.string().uuid()), z.null()])
  .optional()
  .transform((v) => v ?? []);

export const RunOutputSchema = z.object({
  summary: z.string().max(2000),
  newFormula: optionalString,
  formulaChangelog: optionalString,
  paperTradesOpened: uuidArray,
  paperTradesClosed: uuidArray,
  agentRequestsCreated: uuidArray,
  confidenceInThesis: z.number().min(0).max(1),
  nextRunFocus: z.string().max(500),
});

export type RunOutput = z.infer<typeof RunOutputSchema>;
