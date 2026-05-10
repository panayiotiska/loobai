import type { Result } from '@loob/shared';

export interface ProposeLiveTradeInput {
  instrument_kind: string;
  instrument_id: string;
  side: 'buy' | 'sell' | 'yes' | 'no';
  size_usd: number;
  thesis: string;
}

export function proposeLiveTrade(_input: ProposeLiveTradeInput): Result<never> {
  throw new Error(
    'Live execution disabled. Set EXECUTION_MODE=live and provide WALLET_PRIVATE_KEY to enable.',
  );
}
