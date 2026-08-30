export type DecimalString = string;

export interface HealthResponse {
  service: 'excess-api';
  status: 'ok';
  timestamp: string;
}

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP';
