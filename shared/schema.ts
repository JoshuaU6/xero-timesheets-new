import { z } from "zod";
import { createInsertSchema } from "drizzle-zod";

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

// Insert schemas
export const insertProcessingResultSchema = ProcessingResultSchema.omit({ id: true, created_at: true });
export type InsertProcessingResult = z.infer<typeof insertProcessingResultSchema>;
