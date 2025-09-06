import { type ProcessingResult, type InsertProcessingResult } from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  createProcessingResult(result: InsertProcessingResult): Promise<ProcessingResult>;
  getProcessingResult(id: string): Promise<ProcessingResult | undefined>;
  getAllProcessingResults(): Promise<ProcessingResult[]>;
}

export class MemStorage implements IStorage {
  private results: Map<string, ProcessingResult>;

  constructor() {
    this.results = new Map();
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
