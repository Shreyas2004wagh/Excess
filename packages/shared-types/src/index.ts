export type DecimalString = string;

export interface HealthResponse {
  service: 'excess-api';
  status: 'ok';
  timestamp: string;
}

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP';

export type UserStatus = 'ACTIVE' | 'SUSPENDED';
export type AccountStatus = 'ACTIVE' | 'RESTRICTED' | 'CLOSED';
export type LedgerEntryType =
  'DEMO_CREDIT' | 'REALIZED_PNL' | 'FEE' | 'ADJUSTMENT';

export interface UserProfileSummary {
  id: string;
  email: string;
  displayName: string | null;
  status: UserStatus;
}

export interface DemoAccountSummary {
  id: string;
  type: 'DEMO';
  baseCurrency: string;
  balance: DecimalString;
  initialBalance: DecimalString;
  status: AccountStatus;
  createdAt: string;
}

export interface SessionBootstrapResponse {
  user: UserProfileSummary;
  account: DemoAccountSummary;
}

export interface LedgerEntrySummary {
  id: string;
  type: LedgerEntryType;
  amount: DecimalString;
  balanceAfter: DecimalString;
  referenceType: string | null;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntrySummary[];
  nextCursor: string | null;
}
