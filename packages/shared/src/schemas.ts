import { z } from 'zod';

export const RunOutputSchema = z.object({
  summary: z.string().max(2000),
  newFormula: z.string().optional(),
  formulaChangelog: z.string().optional(),
  paperTradesOpened: z.array(z.string().uuid()).default([]),
  paperTradesClosed: z.array(z.string().uuid()).default([]),
  agentRequestsCreated: z.array(z.string().uuid()).default([]),
  confidenceInThesis: z.number().min(0).max(1),
  nextRunFocus: z.string().max(500),
});

export type RunOutput = z.infer<typeof RunOutputSchema>;
