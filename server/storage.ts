import { type ProcessingResult, type InsertProcessingResult, type Submission, type InsertSubmission, processingResultTable, submissionTable } from "@shared/schema";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import { db } from "./db";
import { eq } from "drizzle-orm";

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

// DatabaseStorage implementation
export class DatabaseStorage implements IStorage {
  generateFileHash(files: Record<string, Buffer>): string {
    const combinedContent = Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b)) // Sort by filename for consistency
      .map(([filename, buffer]) => `${filename}:${buffer.toString('base64')}`)
      .join('|');
    
    return createHash('sha256').update(combinedContent).digest('hex');
  }

  async createSubmission(insertSubmission: InsertSubmission): Promise<Submission> {
    const [submission] = await db
      .insert(submissionTable)
      .values(insertSubmission)
      .returning();
    return {
      ...submission,
      processing_result_id: submission.processing_result_id || null,
      xero_submission_status: submission.xero_submission_status || "pending",
      created_at: submission.created_at.toISOString(),
      updated_at: submission.updated_at.toISOString(),
    };
  }

  async getSubmissionByHash(fileHash: string): Promise<Submission | undefined> {
    const [submission] = await db
      .select()
      .from(submissionTable)
      .where(eq(submissionTable.file_hash, fileHash));
    
    if (!submission) return undefined;
    
    return {
      ...submission,
      processing_result_id: submission.processing_result_id || null,
      xero_submission_status: submission.xero_submission_status || "pending",
      created_at: submission.created_at.toISOString(),
      updated_at: submission.updated_at.toISOString(),
    };
  }

  async updateSubmissionStatus(id: number, status: string, processingResultId?: string): Promise<void> {
    const updateData: any = { 
      xero_submission_status: status,
      updated_at: new Date()
    };
    
    if (processingResultId) {
      updateData.processing_result_id = processingResultId;
    }
    
    await db
      .update(submissionTable)
      .set(updateData)
      .where(eq(submissionTable.id, id));
  }

  async createProcessingResult(insertResult: InsertProcessingResult): Promise<ProcessingResult> {
    const id = randomUUID();
    const [result] = await db
      .insert(processingResultTable)
      .values({
        id,
        consolidated_data: insertResult.consolidated_data,
        summary: insertResult.summary,
      })
      .returning();
    
    return {
      ...insertResult,
      id: result.id,
      created_at: result.created_at.toISOString(),
    };
  }

  async getProcessingResult(id: string): Promise<ProcessingResult | undefined> {
    const [result] = await db
      .select()
      .from(processingResultTable)
      .where(eq(processingResultTable.id, id));
    
    if (!result) return undefined;
    
    return {
      id: result.id,
      consolidated_data: result.consolidated_data as any,
      summary: result.summary as any,
      created_at: result.created_at.toISOString(),
    };
  }

  async getAllProcessingResults(): Promise<ProcessingResult[]> {
    const results = await db
      .select()
      .from(processingResultTable)
      .orderBy(processingResultTable.created_at);
    
    return results.map(result => ({
      id: result.id,
      consolidated_data: result.consolidated_data as any,
      summary: result.summary as any,
      created_at: result.created_at.toISOString(),
    })).reverse(); // Most recent first
  }
}

export const storage = process.env.DATABASE_URL ? new DatabaseStorage() : new MemStorage();
