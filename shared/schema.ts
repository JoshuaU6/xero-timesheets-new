import { z } from "zod";
import { createInsertSchema } from "drizzle-zod";
import { pgTable, varchar, timestamp, text, serial, jsonb } from "drizzle-orm/pg-core";

// Core data types for timesheet processing
export const DailyEntrySchema = z.object({
  entry_date: z.string(),
  region_name: z.string(),
  hours: z.number(),
  hour_type: z.enum(["REGULAR", "OVERTIME", "TRAVEL", "HOLIDAY"]),
  overtime_rate: z.number().nullable(),
});

export const EmployeeDataSchema = z.object({
  employee_name: z.string(),
  daily_entries: z.array(DailyEntrySchema),
});

export const ConsolidatedTimesheetSchema = z.object({
  pay_period_end_date: z.string(),
  employees: z.array(EmployeeDataSchema),
});

export const ProcessingResultSchema = z.object({
  id: z.string(),
  consolidated_data: ConsolidatedTimesheetSchema,
  summary: z.object({
    files_processed: z.number(),
    employees_found: z.number(),
    total_hours: z.number(),
    pay_period: z.string(),
    employee_summaries: z.array(z.object({
      employee_name: z.string(),
      matched_from: z.string(),
      total_hours: z.number(),
      regular_hours: z.number(),
      overtime_hours: z.number(),
      travel_hours: z.number(),
      holiday_hours: z.number(),
      overtime_rate: z.string(),
      regions_worked: z.array(z.string()),
      validation_notes: z.array(z.string()),
    })),
  }),
  created_at: z.string(),
});

export const FileUploadSchema = z.object({
  site_timesheet: z.instanceof(File).optional(),
  travel_timesheet: z.instanceof(File).optional(),
  overtime_rates: z.instanceof(File).optional(),
});

export type DailyEntry = z.infer<typeof DailyEntrySchema>;
export type EmployeeData = z.infer<typeof EmployeeDataSchema>;
export type ConsolidatedTimesheet = z.infer<typeof ConsolidatedTimesheetSchema>;
export type ProcessingResult = z.infer<typeof ProcessingResultSchema>;
export type FileUpload = z.infer<typeof FileUploadSchema>;

// Database schema for submission tracking
export const submissionTable = pgTable("submissions", {
  id: serial("id").primaryKey(),
  file_hash: varchar("file_hash", { length: 64 }).notNull().unique(),
  pay_period_end_date: varchar("pay_period_end_date", { length: 20 }).notNull(),
  file_names: jsonb("file_names").notNull(), // Store original file names
  processing_result_id: varchar("processing_result_id", { length: 36 }),
  xero_submission_status: varchar("xero_submission_status", { length: 20 }).default("pending"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const processingResultTable = pgTable("processing_results", {
  id: varchar("id", { length: 36 }).primaryKey(),
  consolidated_data: jsonb("consolidated_data").notNull(),
  summary: jsonb("summary").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

// Zod schemas for database operations
export const SubmissionSchema = z.object({
  id: z.number(),
  file_hash: z.string(),
  pay_period_end_date: z.string(),
  file_names: z.record(z.string()),
  processing_result_id: z.string().nullable(),
  xero_submission_status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const insertSubmissionSchema = createInsertSchema(submissionTable).omit({ 
  id: true, 
  created_at: true, 
  updated_at: true 
});

// Types
export type Submission = z.infer<typeof SubmissionSchema>;
export type InsertSubmission = z.infer<typeof insertSubmissionSchema>;

// Insert schemas
export const insertProcessingResultSchema = ProcessingResultSchema.omit({ id: true, created_at: true });
export type InsertProcessingResult = z.infer<typeof insertProcessingResultSchema>;
