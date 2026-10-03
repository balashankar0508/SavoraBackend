// Mirrors the relevant shapes in c:\Savora\src\types\index.ts so API
// responses can be dropped straight into the existing Zustand stores
// without any reshaping on the client.

export type SubscriptionTier = 'free' | 'premium' | 'premium_plus' | 'ultimate';

// Kept in lockstep with AI_DAILY_LIMIT in c:\Savora\src\types\index.ts.
export const AI_DAILY_LIMIT: Record<SubscriptionTier, number> = {
  free: 0,
  premium: 10,
  premium_plus: 20,
  ultimate: -1,
};

export interface User {
  id: string;
  name: string;
  email: string;
  created_at: string;
}

export type TransactionType = 'income' | 'expense';
export type TransactionSource = 'manual' | 'upi_import' | 'voice';

export interface Transaction {
  id: string;
  user_id: string;
  type: TransactionType;
  amount: number;
  category: string;
  notes?: string;
  transaction_date: string;
  merchant_name?: string;
  source: TransactionSource;
  created_at: string;
}

export interface Goal {
  id: string;
  user_id: string;
  title: string;
  target_amount: number;
  current_amount: number;
  target_date: string;
  created_at?: string;
}

export interface GoalContribution {
  id: string;
  goal_id: string;
  amount: number;
  note: string | null;
  contribution_date: string;
  created_at: string;
}

export interface MonthlySummary {
  month: string;
  income: number;
  expenses: number;
  savings: number;
}
