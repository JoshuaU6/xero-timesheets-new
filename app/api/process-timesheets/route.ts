import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { storage } from "@server/storage";
import { insertProcessingResultSchema } from "@shared/schema";
import {
  employeeValidator,
  regionValidator,
  ValidationStatus,
} from "@server/validation-system";
import { authManager } from "@server/auth-manager";

// Do not use demo employees for matching; rely on live Xero list when connected
const FALLBACK_REGIONS = ["Eastside", "South", "North"];
employeeValidator.setKnownEmployees([]);
regionValidator.setXeroRegions([]);

export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const skipDuplicateCheck =
      searchParams.get("skipDuplicateCheck") === "true";

    // Require Xero connection first
    const isAuthed = await authManager.isAuthenticated();
    if (!isAuthed) {
      return NextResponse.json(
        { success: false, needs_reauth: true, message: "Connect to Xero before processing so names and regions match your org." },
        { status: 401 }
      );
    }

    const form = await req.formData();
    const site = form.get("site_timesheet") as File | null;
    const travel = form.get("travel_timesheet") as File | null;
    const overtime = form.get("overtime_rates") as File | null;

    if (!site || !travel || !overtime) {
      return NextResponse.json(
        {
          message:
            "All three files are required: site_timesheet, travel_timesheet, overtime_rates",
        },
        { status: 400 }
      );
    }

    if (!skipDuplicateCheck) {
      const fileBuffers: Record<string, Buffer> = {};
      const fileNames: Record<string, string> = {};
      const entries: Array<[string, File]> = [
        ["site_timesheet", site],
        ["travel_timesheet", travel],
        ["overtime_rates", overtime],
      ];
      for (const [fieldName, f] of entries) {
        const arrayBuffer = await f.arrayBuffer();
        fileBuffers[fieldName] = Buffer.from(arrayBuffer);
        fileNames[fieldName] = f.name;
      }
      const fileHash = storage.generateFileHash(fileBuffers);
      const existing = await storage.getSubmissionByHash(fileHash);
      if (existing) {
        return NextResponse.json(
          {
            success: false,
            isDuplicate: true,
            message: "These files have already been processed.",
            existingSubmission: {
              id: existing.id,
              pay_period_end_date: existing.pay_period_end_date,
              file_names: existing.file_names,
              created_at: existing.created_at,
              xero_submission_status: existing.xero_submission_status,
            },
          },
          { status: 409 }
        );
      }
    }

    const parseExcelFile = (buffer: Buffer, filename: string) => {
      const workbook = XLSX.read(buffer, { type: "buffer" });
      return { workbook, sheets: workbook.SheetNames };
    };

    const getWeekStart = (date: Date): Date => {
      const d = new Date(date);
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      return new Date(d.setDate(diff));
    };

    const calculateOvertimeHours = (employeeData: Map<string, any>) => {
      for (const [, employee] of Array.from(employeeData.entries())) {
        const weeklyEntries = new Map<string, any[]>();
        for (const entry of employee.entries) {
          if (entry.hour_type !== "REGULAR") continue;
          const entryDate = new Date(entry.entry_date);
          const weekStart = getWeekStart(entryDate);
          const weekKey = weekStart.toISOString().split("T")[0];
          if (!weeklyEntries.has(weekKey)) weeklyEntries.set(weekKey, []);
          weeklyEntries.get(weekKey)!.push(entry);
        }
        for (const [, weekEntries] of Array.from(weeklyEntries.entries())) {
          const totalWeeklyHours = weekEntries.reduce(
            (sum: number, e: any) => sum + e.hours,
            0
          );
          if (totalWeeklyHours > 40) {
            let remaining = totalWeeklyHours - 40;
            for (let i = weekEntries.length - 1; i >= 0 && remaining > 0; i--) {
              const entry = weekEntries[i];
              const used = Math.min(entry.hours, remaining);
              if (used > 0) {
                entry.hours -= used;
                remaining -= used;
                employee.entries.push({
                  entry_date: entry.entry_date,
                  region_name: entry.region_name,
                  hours: used,
                  hour_type: "OVERTIME",
                  overtime_rate: entry.overtime_rate,
                });
              }
            }
            for (const entry of [...employee.entries]) {
              if (entry.hour_type === "REGULAR" && entry.hours === 0) {
                const idx = employee.entries.indexOf(entry);
                if (idx > -1) employee.entries.splice(idx, 1);
              }
            }
          }
        }
      }
      return employeeData;
    };

    const pendingMatches: Array<{
      input_name: string;
      line_number?: number;
      file_type: string;
      suggestions: Array<{ name: string; score: number; confidence: string }>;
    }> = [];

    const validateAndMatchEmployee = (
      input: string,
      lineNumber?: number,
      fileType: string = "unknown"
    ) => {
      const raw = String(input || "").trim();
      // Heuristic: skip obvious headers/non-names
      const headerLike =
        raw.length < 3 ||
        raw.includes(":") ||
        /\d/.test(raw) ||
        [/WEEK/i, /COMPANY/i, /REGION/i, /SUPERVISOR/i, /CONTRACTOR/i, /EMPLOYEE\s*NAME/i, /To\s*Temporary/i, /signed\s*by\s*supervisor/i].some((re) => re.test(raw));
      if (headerLike) {
        return {
          match: null,
          score: 0,
          confidence: "LOW",
          suggestions: [],
          validationResult: null,
          needsConfirmation: false,
        };
      }

      const matchResult = employeeValidator.validateEmployee(raw, lineNumber);
      const hasExact = Boolean(matchResult.matched_name) && matchResult.confidence_score >= 95;
      if (hasExact) {
        return {
          match: matchResult.matched_name,
          score: matchResult.confidence_score / 100,
          confidence: matchResult.confidence,
          suggestions: [],
          validationResult: matchResult,
          needsConfirmation: false,
        };
      }

      // Only ask for confirmation if we have a reasonably strong suggestion from Xero
      const top = matchResult.suggestions?.[0];
      const strongSuggestion = top && top.score >= 70;
      if (strongSuggestion) {
        if (!pendingMatches.some((p) => p.input_name === raw && p.file_type === fileType)) {
          pendingMatches.push({
            input_name: raw,
            line_number: lineNumber,
            file_type: fileType,
            suggestions: matchResult.suggestions.map((s: any) => ({
              name: s.name,
              score: s.score,
              confidence: matchResult.confidence,
            })),
          });
        }
        return {
          match: null,
          score: matchResult.confidence_score / 100,
          confidence: matchResult.confidence,
          suggestions: matchResult.suggestions.map((s: any) => s.name),
          validationResult: matchResult,
          needsConfirmation: true,
        };
      }

      // Otherwise, skip silently (do not force user to review non-matches)
      return {
        match: null,
        score: matchResult.confidence_score / 100,
        confidence: matchResult.confidence,
        suggestions: [],
        validationResult: matchResult,
        needsConfirmation: false,
      };
    };

    let employeeData = new Map();
    const overtimeRatesByEmployee = new Map<string, number | null>();

    // Parse three files
    const [siteBuf, travelBuf, overtimeBuf] = await Promise.all([
      Buffer.from(await site.arrayBuffer()),
      Buffer.from(await travel.arrayBuffer()),
      Buffer.from(await overtime.arrayBuffer()),
    ]);

    const siteWb = parseExcelFile(siteBuf, site.name);
    const travelWb = parseExcelFile(travelBuf, travel.name);
    const overtimeWb = parseExcelFile(overtimeBuf, overtime.name);

    // Determine allowed regions (prefer live from Xero if authenticated)
    let allowedRegions = [...FALLBACK_REGIONS];
    let xeroEmployees: string[] | undefined;
    try {
      const client = await authManager.getAuthenticatedClient();
      if (client) {
        const tenantId = authManager.getTenantId();
        // Live employees
        try {
          const empResp = await client.payrollUKApi.getEmployees(tenantId);
          if (Array.isArray(empResp.body?.employees)) {
            xeroEmployees = empResp.body.employees
              .map((e: any) =>
                [e.firstName, e.middleNames, e.lastName]
                  .filter(Boolean)
                  .join(" ")
                  .trim()
              )
              .filter(Boolean);
          }
        } catch {}
        const trackResp = await client.accountingApi.getTrackingCategories(
          tenantId
        );
        const regionCat = trackResp.body?.trackingCategories?.find(
          (c: any) => c.name?.toLowerCase() === "region"
        );
        if (regionCat?.options) {
          allowedRegions = regionCat.options
            .map((o: any) => o.name)
            .filter(Boolean);
        }
      } else {
        // Not connected: keep known employees empty to avoid non-Xero suggestions
        employeeValidator.setKnownEmployees([]);
        allowedRegions = [];
      }
    } catch {}

    // If we have live employees, feed them into the validator for better matching
    if (xeroEmployees && xeroEmployees.length > 0) {
      employeeValidator.setKnownEmployees(xeroEmployees);
    }

    const unknownRegions = new Set<string>();

    // Site workbook (multi-tab by region)
    const regions = siteWb.workbook.SheetNames;
    for (const regionName of regions) {
      if (allowedRegions.length > 0 && !allowedRegions.includes(regionName)) {
        unknownRegions.add(regionName);
        continue;
      }
      const sheet = siteWb.workbook.Sheets[regionName];
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      for (let i = 1; i < data.length; i++) {
        const row = data[i] as any[];
        if (!row || row.length === 0) continue;
        const nameCell = row[0];
        if (!nameCell) continue;
        const nameStr = String(nameCell).trim();
        const res = validateAndMatchEmployee(nameStr, i + 1, "site_timesheet");
        if (!res.match) continue;
        const employeeName = res.match;
        if (!employeeData.has(employeeName)) {
          employeeData.set(employeeName, {
            name: employeeName,
            matchedFrom: nameStr,
            entries: [],
            validationNotes: [],
          });
        }
        const baseDate = new Date("2025-09-08");
        for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
          const cellValue = row[dayIndex + 1];
          if (!cellValue) continue;
          const entryDate = new Date(baseDate);
          entryDate.setDate(baseDate.getDate() + dayIndex);
          let hours = 0;
          let hourType = "REGULAR";
          if (String(cellValue).toUpperCase() === "HOL") {
            const employee = employeeData.get(employeeName);
            const dateStr = entryDate.toISOString().split("T")[0];
            const existingHoliday = employee.entries.find(
              (e: any) =>
                e.entry_date === dateStr &&
                e.region_name === regionName &&
                e.hour_type === "HOLIDAY"
            );
            if (!existingHoliday) {
              hours = 8;
              hourType = "HOLIDAY";
            } else {
              continue;
            }
          } else {
            hours = parseFloat(String(cellValue));
            if (isNaN(hours) || hours <= 0) continue;
            hourType = "REGULAR";
          }
          const dateString = entryDate.toISOString().split("T")[0];
          const employee = employeeData.get(employeeName);
          const existing = employee.entries.find(
            (e: any) =>
              e.entry_date === dateString &&
              e.region_name === regionName &&
              e.hour_type === hourType
          );
          if (existing) existing.hours += hours;
          else
            employee.entries.push({
              entry_date: dateString,
              region_name: regionName,
              hours,
              hour_type: hourType,
              overtime_rate: null,
            });
        }
      }
    }

    // If unknown regions encountered, instruct user to add them in Xero and re-run
    if (unknownRegions.size > 0) {
      return NextResponse.json(
        {
          success: false,
          message: `Unknown region(s) found: ${Array.from(unknownRegions).join(
            ", "
          )}. Please add these as options under the 'Region' tracking category in Xero, then re-run the processing.`,
          unknown_regions: Array.from(unknownRegions),
        },
        { status: 400 }
      );
    }

    // Travel workbook is intentionally processed later so it doesn't affect overtime calculations

    // Overtime workbook (first sheet) - store rates per employee for later application
    {
      const sheet =
        overtimeWb.workbook.Sheets[overtimeWb.workbook.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      let nameColIndex = -1,
        rateColIndex = -1;
      for (let i = 0; i < data.length; i++) {
        const row = data[i] as any[];
        if (!row) continue;
        for (let j = 0; j < row.length; j++) {
          const cell = String(row[j]).toLowerCase();
          if (cell.includes("name") || cell.includes("employee"))
            nameColIndex = j;
          if (cell.includes("rate") || cell.includes("overtime"))
            rateColIndex = j;
        }
        if (nameColIndex !== -1 && rateColIndex !== -1) {
          for (let k = i + 1; k < data.length; k++) {
            const empRow = data[k] as any[];
            if (!empRow) continue;
            const nameCell = empRow[nameColIndex];
            const rateValue = empRow[rateColIndex];
            if (!nameCell) continue;
            const nameStr = String(nameCell).trim();
            const res = validateAndMatchEmployee(
              nameStr,
              k + 1,
              "overtime_rates"
            );
            if (!res.match) continue;
            const employeeName = res.match;
            let overtimeRate: number | null = null;
            if (
              rateValue !== undefined &&
              rateValue !== null &&
              rateValue !== ""
            ) {
              const rateStr = String(rateValue).replace(/[^0-9.]/g, "");
              const parsed = parseFloat(rateStr);
              if (!isNaN(parsed) && parsed > 0) overtimeRate = parsed;
            }
            overtimeRatesByEmployee.set(employeeName, overtimeRate);
          }
          break;
        }
      }
    }

    // If any pending matches require confirmation, return them now
    if (pendingMatches.length > 0) {
      return NextResponse.json({
        success: false,
        needsConfirmation: true,
        pendingMatches,
        message: `Found ${pendingMatches.length} employee name(s) that need confirmation before processing can continue.`,
      });
    }

    employeeData = calculateOvertimeHours(employeeData);

    // Now process Travel workbook (first sheet), adding entries as TRAVEL (not counted toward overtime)
    {
      const sheet = travelWb.workbook.Sheets[travelWb.workbook.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      let nameColIndex = -1,
        dateColIndex = -1,
        hoursColIndex = -1,
        regionColIndex = -1;
      for (let i = 0; i < data.length; i++) {
        const row = data[i] as any[];
        if (!row) continue;
        for (let j = 0; j < row.length; j++) {
          const cell = String(row[j]).toLowerCase();
          if (cell.includes("name") || cell.includes("employee"))
            nameColIndex = j;
          if (cell.includes("date")) dateColIndex = j;
          if (cell.includes("hours") || cell.includes("time"))
            hoursColIndex = j;
          if (cell.includes("region") || cell.includes("location"))
            regionColIndex = j;
        }
        if (nameColIndex !== -1 && hoursColIndex !== -1) {
          for (let k = i + 1; k < data.length; k++) {
            const travelRow = data[k] as any[];
            if (!travelRow) continue;
            const nameCell = travelRow[nameColIndex];
            const travelHours =
              parseFloat(String(travelRow[hoursColIndex])) || 0;
            const travelDate = travelRow[dateColIndex];
            const travelRegion = travelRow[regionColIndex] || "Eastside";
            if (!nameCell || travelHours === 0) continue;
            const nameStr = String(nameCell).trim();
            const res = validateAndMatchEmployee(
              nameStr,
              k + 1,
              "travel_timesheet"
            );
            if (!res.match) continue;
            const employeeName = res.match;
            if (!employeeData.has(employeeName)) {
              employeeData.set(employeeName, {
                name: employeeName,
                matchedFrom: nameStr,
                entries: [],
                validationNotes: [],
              });
            }
            let entryDate = "2025-09-08";
            if (travelDate) {
              try {
                const parsed = new Date(travelDate);
                if (!isNaN(parsed.getTime()))
                  entryDate = parsed.toISOString().split("T")[0];
              } catch {}
            }
            const employee = employeeData.get(employeeName);
            const regionName = String(travelRegion).trim();
            // Keep travel as separate type
            employee.entries.push({
              entry_date: entryDate,
              region_name: regionName,
              hours: travelHours,
              hour_type: "TRAVEL",
              overtime_rate: null,
            });
            if (
              !employee.validationNotes.some((n: string) =>
                n.includes("travel time")
              )
            ) {
              employee.validationNotes.push(
                "Travel time kept separate and not included in overtime."
              );
            }
          }
          break;
        }
      }
    }

    // Apply overtime rate to all entries for employees where provided
    for (const [, employee] of Array.from(employeeData.entries())) {
      const rate = overtimeRatesByEmployee.get(employee.name) ?? null;
      employee.entries.forEach((entry: any) => {
        entry.overtime_rate = rate;
      });
      if (rate !== undefined) {
        employee.validationNotes.push(
          rate
            ? `Overtime rate applied: $${rate.toFixed(2)}.`
            : "Overtime rate applied: Standard."
        );
      }
    }

    const employees = Array.from(employeeData.values()).map((emp: any) => ({
      employee_name: emp.name,
      daily_entries: emp.entries.map((entry: any) => ({
        entry_date: entry.entry_date,
        region_name: entry.region_name,
        hours: entry.hours,
        hour_type: entry.hour_type,
        overtime_rate: entry.overtime_rate,
      })),
    }));

    const totalHours = employees.reduce(
      (total: number, emp: any) =>
        total + emp.daily_entries.reduce((t: number, e: any) => t + e.hours, 0),
      0
    );

    const employeeSummaries = Array.from(employeeData.values()).map(
      (emp: any) => {
        const regularHours = emp.entries
          .filter((e: any) => e.hour_type === "REGULAR")
          .reduce((s: number, e: any) => s + e.hours, 0);
        const overtimeHours = emp.entries
          .filter((e: any) => e.hour_type === "OVERTIME")
          .reduce((s: number, e: any) => s + e.hours, 0);
        const travelHours = emp.entries
          .filter((e: any) => e.hour_type === "TRAVEL")
          .reduce((s: number, e: any) => s + e.hours, 0);
        const holidayHours = emp.entries
          .filter((e: any) => e.hour_type === "HOLIDAY")
          .reduce((s: number, e: any) => s + e.hours, 0);
        const totalEmpHours = regularHours + overtimeHours + holidayHours + travelHours;
        const regions = Array.from(
          new Set(emp.entries.map((e: any) => e.region_name))
        );
        const overtimeRate = emp.entries.find(
          (e: any) => e.overtime_rate !== null
        )?.overtime_rate;
        return {
          employee_name: emp.name,
          matched_from: emp.matchedFrom,
          total_hours: totalEmpHours,
          regular_hours: regularHours,
          overtime_hours: overtimeHours,
          travel_hours: travelHours,
          holiday_hours: holidayHours,
          overtime_rate: overtimeRate
            ? `$${overtimeRate.toFixed(2)}`
            : "Standard",
          regions_worked: regions,
          validation_notes: emp.validationNotes,
        };
      }
    );

    const consolidatedData = {
      pay_period_end_date: "2025-09-14",
      employees,
    };

    const processingResult = {
      consolidated_data: consolidatedData,
      summary: {
        files_processed: 3,
        employees_found: employees.length,
        total_hours: totalHours,
        pay_period: "Jun 2-8",
        employee_summaries: employeeSummaries,
      },
    };

    const validated = insertProcessingResultSchema.parse(processingResult);
    const saved = await storage.createProcessingResult(validated);

    if (!skipDuplicateCheck) {
      const fileBuffers: Record<string, Buffer> = {};
      const fileNames: Record<string, string> = {};
      const entries: Array<[string, File]> = [
        ["site_timesheet", site],
        ["travel_timesheet", travel],
        ["overtime_rates", overtime],
      ];
      for (const [fieldName, f] of entries) {
        const arrayBuffer = await f.arrayBuffer();
        fileBuffers[fieldName] = Buffer.from(arrayBuffer);
        fileNames[fieldName] = f.name;
      }
      const fileHash = storage.generateFileHash(fileBuffers);
      await storage.createSubmission({
        file_hash: fileHash,
        pay_period_end_date: consolidatedData.pay_period_end_date,
        file_names: fileNames,
        processing_result_id: saved.id,
        xero_submission_status: "pending",
      });
    }

    return NextResponse.json(saved);
  } catch (error: any) {
    return NextResponse.json(
      { message: error?.message || "Processing failed" },
      { status: 500 }
    );
  }
}
