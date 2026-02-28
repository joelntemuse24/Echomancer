export type JobStatus = "queued" | "processing" | "ready" | "failed";

export interface User {
  id: string;
  email: string;
  name: string;
  credits: number;
  stripe_customer_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: string;
  user_id: string;
  book_title: string;
  voice_name: string;
  status: JobStatus;
  progress: number;
  pdf_storage_path: string;
  voice_storage_path: string;
  audio_storage_path: string | null;
  video_id: string | null;
  start_time: number;
  end_time: number;
  error: string | null;
  trigger_task_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Voice {
  id: string;
  user_id: string;
  name: string;
  storage_path: string;
  source: "youtube" | "upload";
  source_video_id: string | null;
  created_at: string;
}

export interface UsageLog {
  id: string;
  user_id: string;
  action: string;
  chars_processed: number;
  cost_usd: number;
  created_at: string;
}
