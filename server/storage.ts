import { type ProcessingResult, type InsertProcessingResult, type Submission, type InsertSubmission } from "@shared/schema";
import { randomUUID } from "crypto";
import { createHash } from "crypto";

export interface IStorage {
  createProcessingResult(result: InsertProcessingResult): Promise<ProcessingResult>;
  getProcessingResult(id: string): Promise<ProcessingResult | undefined>;
  getAllProcessingResults(): Promise<ProcessingResult[]>;
  
  // Submission tracking for duplicate protection
  createSubmission(submission: InsertSubmission): Promise<Submission>;
  getSubmissionByHash(fileHash: string): Promise<Submission | undefined>;
  updateSubmissionStatus(id: number, status: string, processingResultId?: string): Promise<void>;
  
  // Utility function for file hashing
  generateFileHash(files: Record<string, Buffer>): string;
}

export class MemStorage implements IStorage {
  private results: Map<string, ProcessingResult>;
  private submissions: Map<string, Submission>;
  private submissionCounter: number;

  constructor() {
    this.results = new Map();
    this.submissions = new Map();
    this.submissionCounter = 1;
  }

  generateFileHash(files: Record<string, Buffer>): string {
    const combinedContent = Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b)) // Sort by filename for consistency
      .map(([filename, buffer]) => `${filename}:${buffer.toString('base64')}`)
      .join('|');
    
    return createHash('sha256').update(combinedContent).digest('hex');
  }

  async createSubmission(insertSubmission: InsertSubmission): Promise<Submission> {
    const id = this.submissionCounter++;
    const submission: Submission = {
      ...insertSubmission,
      id,
      processing_result_id: insertSubmission.processing_result_id || null,
      xero_submission_status: insertSubmission.xero_submission_status || "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.submissions.set(insertSubmission.file_hash, submission);
    return submission;
  }

  async getSubmissionByHash(fileHash: string): Promise<Submission | undefined> {
    return this.submissions.get(fileHash);
  }

  async updateSubmissionStatus(id: number, status: string, processingResultId?: string): Promise<void> {
    const submission = Array.from(this.submissions.values()).find(s => s.id === id);
    if (submission) {
      submission.xero_submission_status = status;
      submission.updated_at = new Date().toISOString();
      if (processingResultId) {
        submission.processing_result_id = processingResultId;
      }
      this.submissions.set(submission.file_hash, submission);
    }
  }

  async createProcessingResult(insertResult: InsertProcessingResult): Promise<ProcessingResult> {
    const id = randomUUID();
    const result: ProcessingResult = {
      ...insertResult,
      id,
      created_at: new Date().toISOString(),
    };
    this.results.set(id, result);
    return result;
  }

  async getProcessingResult(id: string): Promise<ProcessingResult | undefined> {
    return this.results.get(id);
  }

  async getAllProcessingResults(): Promise<ProcessingResult[]> {
    return Array.from(this.results.values()).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }
}

export const storage = new MemStorage();
