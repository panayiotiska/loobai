import { runTickWithRetry } from '@loob/agent-core';

// Research ticks get one whole-tick retry on transient Gemini outages — the
// LLM IS the run, and a lost tick is a lost 4-hour research window. Monitor
// ticks instead degrade to sweeps-only inside runTick.
await runTickWithRetry('research');
