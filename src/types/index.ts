// ─── Enums ───────────────────────────────────────────────────────────────────

export type Role = 'employee' | 'manager' | 'hr';
export type LeaveType = 'sick' | 'casual' | 'earned';
export type LeaveStatus =
  | 'pending'
  | 'pending_document'
  | 'partially_approved'
  | 'approved'
  | 'rejected'
  | 'cancelled';
export type ApprovalDecision = 'pending' | 'approved' | 'rejected' | 'not_required';

// ─── Database Row Types ──────────────────────────────────────────────────────

export interface Employee {
  id: number;
  name: string;
  email: string;
  role: Role;
  department: string;
  reporting_manager_id: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface LeaveBalance {
  id: number;
  employee_id: number;
  leave_type: LeaveType;
  year: number;
  total_days: number;
  used_days: number;
}

export interface LeaveRequest {
  id: number;
  employee_id: number;
  leave_type: LeaveType;
  start_date: Date;
  end_date: Date;
  reason: string | null;
  status: LeaveStatus;
  medical_document_url: string | null;
  document_reminder_count: number;
  document_deadline: Date | null;
  requires_dual_approval: boolean;
  manager_approval: ApprovalDecision;
  hr_approval: ApprovalDecision;
  team_capacity_warning: boolean;
  blackout_warning: boolean;
  blackout_override: boolean;
  rejection_reason: string | null;
  // Delegation chain fields
  current_manager_approver_id: number | null;
  escalation_count: number;
  current_approver_assigned_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ApprovalAction {
  id: number;
  leave_request_id: number;
  approver_id: number;
  action: 'approved' | 'rejected' | 'overridden' | 'delegated';
  role_type: 'manager' | 'hr';
  comments: string | null;
  created_at: Date;
}

export interface DelegationLog {
  id: number;
  leave_request_id: number;
  from_approver_id: number;
  to_approver_id: number;
  reason: 'on_leave' | 'timeout_48h' | 'also_unavailable';
  created_at: Date;
}

export interface BlackoutPeriod {
  id: number;
  department: string;
  name: string;
  start_date: Date;
  end_date: Date;
  reason: string | null;
  created_at: Date;
}

export interface Notification {
  id: number;
  employee_id: number;
  type: string;
  message: string;
  related_leave_request_id: number | null;
  is_read: boolean;
  created_at: Date;
}

export interface TeamAvailability {
  id: number;
  department: string;
  date: Date;
  employee_id: number;
  leave_request_id: number;
}

// ─── API Request/Response Types ──────────────────────────────────────────────

export interface CreateLeaveRequestDTO {
  employee_id: number;
  leave_type: LeaveType;
  start_date: string; // ISO date string
  end_date: string;
  reason?: string;
}

export interface ApproveLeaveDTO {
  approver_id: number;
  comments?: string;
  blackout_override?: boolean; // explicitly override blackout warning
}

export interface RejectLeaveDTO {
  approver_id: number;
  reason: string;
  comments?: string;
}

export interface UploadDocumentDTO {
  document_url: string;
}

export interface CreateBlackoutDTO {
  department: string;
  name: string;
  start_date: string;
  end_date: string;
  reason?: string;
}

// ─── Event Types ─────────────────────────────────────────────────────────────

export interface LeaveEvent {
  type: 'leave.approved' | 'leave.rejected' | 'leave.cancelled' | 'leave.created';
  leaveRequest: LeaveRequest;
  actor_id: number; // who triggered the event
  metadata?: Record<string, unknown>;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  warnings?: string[];
}
