import { Chunk, File } from "parse-diff";

export interface AIReviewResponse {
  lineNumber: number;
  reviewComment: string;
  severity: 'error' | 'warning' | 'info';
  filePath: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  side: 'LEFT' | 'RIGHT';
}

export interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
  ref?: string;     // Branch name for push events
  commit?: string;  // Commit SHA for push events
  eventType?: 'pull_request' | 'push' | 'other'; // Type of event
}

export type AIResponseArray = AIReviewResponse[];

export interface DiffFile extends File {
  chunks: Chunk[];
} 