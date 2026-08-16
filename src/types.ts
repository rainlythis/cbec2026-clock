import type { TimerState, TimerStatus } from './timer';

export type AppointmentStatus =
  | 'scheduled'
  | 'arrived'
  | 'called'
  | 'in_meeting'
  | 'completed'
  | 'skipped'
  | 'no_show';

export type ArrivalStatus = 'not_arrived' | 'arrived';

/**
 * Public appointment shape. The schema stores no phone numbers, emails or any
 * other personal contact detail, so nothing sensitive can leak to /display or
 * /live by accident.
 */
export interface PublicAppointment {
  id: number;
  /** Null when the approved roster carried no queue number; clients fall back to the time. */
  queueNumber: string | null;
  companyName: string;
  scheduledStart: string;
  scheduledEnd: string;
  tableCode: string;
  platform: string;
  appointmentStatus: AppointmentStatus;
  arrivalStatus: ArrivalStatus;
}

export interface TableSnapshot {
  tableCode: string;
  /** Full vendor name for the active day, e.g. Profreight-1 on day 2. Used on the operator grid. */
  displayLabel: string;
  /** Short per-day name for the room screen, e.g. THPM, Profreight-1. */
  shortLabel: string;
  platform: string;
  zone: 'main' | 'shopee';
  /** False when the table is not trading that day (AMAZON_2 on 18 Aug). */
  isActive: boolean;
  durationSeconds: number;
  durationMinutes: number;
  displayOrder: number;
  timer: TimerState & {
    remainingSeconds: number;
    statusLabel: string;
    toggleLabel: 'Play' | 'Pause' | 'Resume';
    toggleEnabled: boolean;
  };
  current: PublicAppointment | null;
  next: PublicAppointment | null;
  upcoming: PublicAppointment[];
  stats: { completed: number; skipped: number; waiting: number; total: number };
}

export interface EventSnapshot {
  name: string;
  activeDate: string;
  eventDates: string[];
  timezone: string;
  soundEnabled: boolean;
  sessions: { label: string; start: string; end: string }[];
}

export interface StateSnapshot {
  serverTime: number;
  /** Fingerprint of the frontend the server is serving; clients reload when it changes. */
  assetVersion: string;
  event: EventSnapshot;
  tables: TableSnapshot[];
  global: { action: 'play' | 'pause'; label: string; mixed: boolean };
  revision: number;
}

export interface TimerRow {
  table_code: string;
  timer_status: TimerStatus;
  duration_seconds: number;
  started_at: Date | null;
  ends_at: Date | null;
  paused_remaining_seconds: number | null;
  current_appointment_id: number | null;
  timeup_at: Date | null;
}

export interface TableRow {
  table_code: string;
  platform: string;
  duration_seconds: number;
  zone: 'main' | 'shopee';
  display_order: number;
}

/** A table as it trades on one specific day (joined matching_tables x table_days). */
export interface TableDayRow {
  table_code: string;
  display_label: string;
  short_label: string;
  platform: string;
  grid_key: 'main' | 'shopee';
  duration_seconds: number;
  display_order: number;
  is_active: boolean;
}

export interface TimeSlotRow {
  id: number;
  event_date: string;
  grid_key: 'main' | 'shopee';
  slot_index: number;
  starts_at: string;
  ends_at: string;
}

export interface AppointmentRow {
  id: number;
  event_date: string;
  scheduled_start: string;
  scheduled_end: string;
  platform: string;
  table_code: string;
  queue_number: string | null;
  company_name: string;
  appointment_status: AppointmentStatus;
  arrival_status: ArrivalStatus;
  /** Grid cell. NULL means parked: in the roster but off the grid and not callable. */
  slot_id: number | null;
  original_slot_id?: number | null;
  row_version?: number;
}

export interface EventSettingsRow {
  event_name: string;
  active_event_date: string;
  timezone: string;
  sound_enabled: boolean;
}
