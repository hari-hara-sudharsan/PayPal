export type CriterionKind = 'judgment' | 'min_words' | 'must_include' | 'url_live';
export interface Criterion { id: string; text: string; kind: CriterionKind; arg?: string | number | null }

export type PactStatus = 'AWAITING_SIGNATURE' | 'AWAITING_FUNDS' | 'ACTIVE' | 'SETTLED' | 'CANCELLED';
export type MilestoneStatus =
  | 'OPEN' | 'VERIFYING' | 'PASSED' | 'FAILED' | 'HELD' | 'CONTESTED' | 'IN_TRIBUNAL'
  | 'ESCALATED' | 'RELEASING' | 'RELEASED' | 'PAYOUT_FAILED' | 'FORFEITED';

export type Role = 'buyer' | 'worker';

export interface Pact {
  id: string; title: string; summary: string; currency: string; total_cents: number;
  buyer_name: string; buyer_email: string; worker_name: string; worker_email: string;
  buyer_key: string; worker_key: string; terms_hash: string; status: PactStatus;
  challenge_seconds: number; auto_release_max_cents: number; ai_arbitration: number;
  source_text: string; order_id: string | null; auth_id: string | null;
  honor_expires_at: number | null; auth_expires_at: number | null;
  captured_cents: number; signed_at: number | null; funded_at: number | null; created_at: number;
}

export interface Milestone {
  id: string; pact_id: string; idx: number; title: string; amount_cents: number; due_at: number | null;
  criteria: Criterion[]; status: MilestoneStatus; release_at: number | null;
  awarded_cents: number | null; capture_id: string | null; payout_id: string | null;
  contest_by: Role | null; contest_statement: string | null; response_statement: string | null;
  convene_at: number | null; payout_status: string | null; payout_attempt: number;
}

export interface CriterionResult {
  criterion_id: string; passed: boolean; confidence: number; reason: string;
  evidence: string; evidence_verified: boolean; machine: boolean;
}

export interface ShieldFinding { technique: string; excerpt: string; severity: 'high' | 'medium' }

export interface Verification {
  id: string; milestone_id: string; attempt: number; deliverable_text: string; deliverable_url: string | null;
  outcome: 'PASS' | 'FAIL' | 'HOLD'; results: CriterionResult[]; shield: ShieldFinding[];
  summary: string; model: string; created_at: number;
}

export interface TribunalStep {
  id: string; milestone_id: string; seq: number;
  speaker: 'advocate_worker' | 'advocate_buyer' | 'judge';
  round: string; text: string; model: string; created_at: number;
}
