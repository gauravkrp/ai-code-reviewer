export interface BatchedReviewRequest {
  files: {
    path: string;
    language: string;
    chunks: {
      changes: string;
      lineRange: {
        start: number;
        end: number;
      };
    }[];
  }[];
  prContext: {
    title: string;
    description: string;
  };
}

export interface CodebaseContext {
  relevantFiles: {
    path: string;
    content: string;
    similarity: number;
  }[];
  imports: {
    from: string;
    to: string;
    type: 'import' | 'require' | 'dependency';
  }[];
  dependencies: {
    name: string;
    version: string;
    type: 'runtime' | 'dev';
  }[];
}

export interface FileTreeContext {
  structure: {
    path: string;
    type: 'file' | 'directory';
    children?: FileTreeContext[];
  }[];
  relationships: {
    type: 'import' | 'dependency' | 'reference';
    from: string;
    to: string;
  }[];
}

export interface ReviewComment {
  path: string;
  line: number;
  lineNumber?: number;
  body: string;
  side?: 'LEFT' | 'RIGHT';
  suggestion?: {
    code?: string;
  };
}

export interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
  eventType: 'pull_request' | 'push' | 'other';
  ref?: string;
  commit?: string;
}

export interface AIReviewResponse {
  lineNumber: number;
  body: string;
  reviewComment: string;
  severity: 'error' | 'warning' | 'info';
  suggestion?: {
    code?: string;
    description?: string;
  };
}

export type AIResponseArray = AIReviewResponse[]; 