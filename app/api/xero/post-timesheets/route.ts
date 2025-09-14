import { AxiosResponse } from "axios";
import { NextRequest, NextResponse } from "next/server";
import { authManager } from "@server/auth-manager";
import { settingsManager } from "@server/settings-manager";
import { PayRun } from "xero-node/dist/gen/model/payroll-uk/payRun";
import { Timesheet } from "xero-node/dist/gen/model/payroll-uk/timesheet";
import { TimesheetLine } from "xero-node/dist/gen/model/payroll-uk/timesheetLine";
import { extractXeroError, XeroErrorInfo } from "app/utils/xero-error";
import { TimesheetObject } from "xero-node/dist/gen/model/payroll-uk/timesheetObject";

type ConsolidatedData = {
  pay_period_end_date: string;
  employees: Array<{
    employee_name: string;
    daily_entries: Array<{
      entry_date: string;
      region_name: string;
      hours: number;
      hour_type: "REGULAR" | "OVERTIME" | "HOLIDAY";
      overtime_rate: number | null;
    }>;
  }>;
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { consolidated_data } = body || {};
    if (!consolidated_data) {
      return NextResponse.json(
        { message: "No timesheet data provided" },
        { status: 400 }
      );
    }

    const client = await authManager.getAuthenticatedClient();
    if (!client) {
      return NextResponse.json(
        {
          message: "Not authenticated with Xero. Please connect first.",
          needs_reauth: true,
        },
        { status: 401 }
      );
    }

    const tenantId = authManager.getTenantId();
    const data = consolidated_data as ConsolidatedData;

    // Fetch live employees, PayItems and Region tracking options from Xero for validation and mapping
    const normalize = (s: string) => s.trim().toLowerCase();
    const simplify = (s: string) => normalize(s).replace(/[^a-z0-9]/g, "");
    let employeeNameToId = new Map<string, string>();
    let regionNameToTrackingOptionId = new Map<string, string>();
    let simplifiedRegionNameToTrackingOptionId = new Map<string, string>();
    let earningsRateNameToId = new Map<string, string>();
    // Optional mapping from overtime multiplier to specific Xero earnings rate name
    const overtimeRateToEarningsName: Array<{ match: (rate: number | null) => boolean; name: string }> = [
      { match: (r) => r === 2 || r === 2.0, name: "Overtime 2x" },
      { match: (r) => r === 1.75, name: "Overtime 1.75x" },
      { match: (r) => r === 1.5, name: "Overtime 1.5x" },
    ];
    let availableEarningsRateNames: string[] = [];
    let defaultRegularEarningsRateId: string | undefined;
    let defaultOvertimeEarningsRateId: string | undefined;
    let availableRegionNames: string[] | undefined = [];
    const regionMapping =
      settingsManager.getSetting<Record<string, string>>(
        "xero.regionMapping"
      ) || {};
    const normalizedRegionMapping = new Map<string, string>();
    for (const [k, v] of Object.entries(regionMapping)) {
      if (k && v) normalizedRegionMapping.set(normalize(k), String(v).trim());
    }

    const empResp = await client.payrollUKApi.getEmployees(tenantId);

    if (Array.isArray(empResp.body?.employees)) {
      for (const e of empResp.body.employees) {
        const fullName = [e.firstName, e.lastName]
          .filter(Boolean)
          .join(" ")
          .trim();
        if (fullName && e.employeeID)
          employeeNameToId.set(normalize(fullName), e.employeeID);
      }
    }

    const payItemsResp = await client.payrollUKApi.getEarningsRates(tenantId);

    const earnings = payItemsResp.body.earningsRates;
    if (Array.isArray(earnings)) {
      for (const er of earnings) {
        const erName = er?.name;
        const erId = er?.earningsRateID;
        if (erName && erId) {
          const normName = normalize(erName);
          earningsRateNameToId.set(normName, erId);
          availableEarningsRateNames.push(erName);
        }
      }

      // Pick sensible defaults if explicit names not found
      const pickByIncludes = (substr: string) => {
        const found = availableEarningsRateNames.find((n) =>
          normalize(n).includes(substr)
        );
        return found ? earningsRateNameToId.get(normalize(found)) : undefined;
      };
      // Common regular names
      defaultRegularEarningsRateId =
        earningsRateNameToId.get(normalize("Regular Hours")) ||
        pickByIncludes("regular") ||
        earningsRateNameToId.get(normalize("Ordinary Hours")) ||
        pickByIncludes("ordinary") ||
        earningsRateNameToId.get(normalize("Basic Hours")) ||
        pickByIncludes("basic") ||
        // Fallback: first available
        (availableEarningsRateNames.length > 0
          ? earningsRateNameToId.get(normalize(availableEarningsRateNames[0]))
          : undefined);

      // Common overtime names
      defaultOvertimeEarningsRateId =
        earningsRateNameToId.get(normalize("Overtime Hours")) ||
        pickByIncludes("overtime") ||
        // Fallback to regular
        defaultRegularEarningsRateId;
    }

    const trackResp = await client.accountingApi.getTrackingCategories(
      tenantId
    );

    const regionCat = trackResp.body?.trackingCategories?.find(
      (c: any) => c.name?.toLowerCase() === "region"
    );
    if (regionCat?.options) {
      availableRegionNames = regionCat.options
        .map((o) => o.name)
        .filter((name): name is string => Boolean(name));
      for (const opt of regionCat.options) {
        if (opt.name && opt.trackingOptionID) {
          const norm = normalize(opt.name);
          const simp = simplify(opt.name);
          regionNameToTrackingOptionId.set(norm, opt.trackingOptionID);
          simplifiedRegionNameToTrackingOptionId.set(
            simp,
            opt.trackingOptionID
          );
        }
      }
    }

    // First, calculate the date range from timesheet entries to find the matching pay run
    const allEntryDates = new Set<string>();
    for (const emp of data.employees) {
      for (const entry of emp.daily_entries) {
        allEntryDates.add(entry.entry_date);
      }
    }

    const sortedEntryDates = Array.from(allEntryDates).sort();
    let timesheetStartDate = sortedEntryDates[0];
    let timesheetEndDate = sortedEntryDates[sortedEntryDates.length - 1];
    // Fallback: derive from pay_period_end_date if entries did not include dates
    if ((!timesheetStartDate || !timesheetEndDate) && (data as any)?.pay_period_end_date) {
      try {
        const end = new Date((data as any).pay_period_end_date);
        const start = new Date(end);
        start.setDate(end.getDate() - 6);
        timesheetStartDate = start.toISOString().split("T")[0];
        timesheetEndDate = end.toISOString().split("T")[0];
      } catch {}
    }

    console.log(
      "🚀 ~ POST ~ Looking for pay run containing dates:",
      timesheetStartDate,
      "to",
      timesheetEndDate
    );

    // Get all pay runs to find the one that contains our timesheet dates
    // Try both Draft and Posted status to see all available pay runs
    const [draftPayRunsResp, allPayRunsResp] = await Promise.all([
      client.payrollUKApi.getPayRuns(tenantId, 1, "Draft"),
      client.payrollUKApi.getPayRuns(tenantId, 1), // Get all statuses
    ]);

    console.log(
      "🚀 ~ POST ~ Number of Draft pay runs:",
      draftPayRunsResp.body?.payRuns?.length || 0,
      "Draft pay runs:",
      draftPayRunsResp.body?.payRuns
    );
    console.log(
      "🚀 ~ POST ~ All pay runs:",
      allPayRunsResp.body?.payRuns?.length || 0
    );

    // Pick the latest draft pay run that contains the period
    let matchingPayRun = null as any;
    if (draftPayRunsResp.body?.payRuns) {
      const candidate = draftPayRunsResp.body.payRuns
        .filter((pr: any) => pr.periodStartDate && pr.periodEndDate)
        .filter((pr: any) => {
          const payRunStart = new Date(pr.periodStartDate);
          const payRunEnd = new Date(pr.periodEndDate);
          const timesheetStart = new Date(timesheetStartDate);
          const timesheetEnd = new Date(timesheetEndDate);
          return timesheetStart >= payRunStart && timesheetEnd <= payRunEnd;
        })
        .sort((a: any, b: any) => new Date(b.periodEndDate).getTime() - new Date(a.periodEndDate).getTime());
      matchingPayRun = candidate[0] || null;
    }

    if (!matchingPayRun) {
      // Suggest helpful guidance and provide nearby options
      const suggestion = `No matching draft pay run covers ${timesheetStartDate} to ${timesheetEndDate}. In Xero → Payroll → Pay Runs, create a Draft weekly pay run with start ${timesheetStartDate} and end ${timesheetEndDate}.`;
      return NextResponse.json(
        {
          message: suggestion,
          timesheet_date_range: {
            start: timesheetStartDate,
            end: timesheetEndDate,
          },
          available_draft_pay_runs:
            draftPayRunsResp.body?.payRuns?.map((pr) => ({
              id: pr.payRunID,
              start: pr.periodStartDate,
              end: pr.periodEndDate,
              status: pr.payRunStatus,
              calendar_type: pr.calendarType,
            })) || [],
          available_all_pay_runs:
            allPayRunsResp.body?.payRuns?.map((pr) => ({
              id: pr.payRunID,
              start: pr.periodStartDate,
              end: pr.periodEndDate,
              status: pr.payRunStatus,
              calendar_type: pr.calendarType,
            })) || [],
        },
        { status: 400 }
      );
    }

    console.log(
      "🚀 ~ POST ~ Found matching pay run:",
      matchingPayRun.payRunID,
      "with period:",
      matchingPayRun.periodStartDate,
      "to",
      matchingPayRun.periodEndDate
    );

    const payrollCalendarId = matchingPayRun.payrollCalendarID;
    const payRunCalendar = {
      periodStartDate: matchingPayRun.periodStartDate!,
      periodEndDate: matchingPayRun.periodEndDate!,
      name: `Pay Run ${matchingPayRun.payRunID}`,
      calendarType: matchingPayRun.calendarType,
      paymentDate: matchingPayRun.paymentDate || matchingPayRun.periodEndDate!,
    };

    const failures: Array<{ employee: string; reason: string }> = [];
    const successes: Array<{ employee: string; entries: number }> = [];
    const preparedPayloads: Array<Timesheet> = [];
    const preparedLineReplacements: Array<{
      timesheetId: string;
      newLines: TimesheetLine[];
    }> = [];

    const inputRegionsRaw = new Set<string>();
    const inputRegionsMapped = new Set<string>();

    for (const emp of data.employees) {
      const employeeId = employeeNameToId.get(normalize(emp.employee_name));
      if (!employeeId) {
        failures.push({
          employee: emp.employee_name,
          reason: "Employee not found in Xero",
        });
        continue;
      }

      // Validate regions (apply mapping before lookup)
      const missingRegion = emp.daily_entries.find((d) => {
        const inputRegion = d.region_name;
        const mappedName =
          normalizedRegionMapping.get(normalize(inputRegion)) || inputRegion;
        const norm = normalize(mappedName);
        const simp = simplify(mappedName);
        return !(
          regionNameToTrackingOptionId.has(norm) ||
          simplifiedRegionNameToTrackingOptionId.has(simp)
        );
      });
      if (missingRegion) {
        failures.push({
          employee: emp.employee_name,
          reason: `Region not found in Xero: ${missingRegion.region_name}`,
        });
        continue;
      }

      // Build placeholder payload grouped by date with tracking option and earnings rate
      const entriesByDate = new Map<
        string,
        Array<{
          hours: number;
          regionTrackingOptionId: string;
          earningsRateId: string;
        }>
      >();
      for (const d of emp.daily_entries) {
        const list = entriesByDate.get(d.entry_date) || [];
        const isOvertime = d.hour_type === "OVERTIME";
        // Pick earnings rate: for overtime, try mapping by multiplier first, then fallback to defaults
        let erName = isOvertime ? "Overtime Hours" : "Regular Hours";
        let erId: string | undefined;
        if (isOvertime) {
          const rate = d.overtime_rate as number | null;
          let mappedName: string | undefined;
          if (rate && !isNaN(rate)) {
            const found = overtimeRateToEarningsName.find((m) => m.match(rate));
            if (found) mappedName = found.name;
          }
          if (mappedName) {
            erName = mappedName;
            erId = earningsRateNameToId.get(normalize(erName));
          }
        }
        erId =
          erId ||
          earningsRateNameToId.get(normalize(erName)) ||
          (isOvertime ? defaultOvertimeEarningsRateId : defaultRegularEarningsRateId);
        if (!erId) {
          failures.push({
            employee: emp.employee_name,
            reason: `Earnings rate not found in Xero: ${erName}`,
          });
          continue;
        }
        const inputRegion = d.region_name;
        const mappedName =
          normalizedRegionMapping.get(normalize(inputRegion)) || inputRegion;
        const norm = normalize(mappedName);
        const simp = simplify(mappedName);
        const trackingId =
          regionNameToTrackingOptionId.get(norm) ||
          simplifiedRegionNameToTrackingOptionId.get(simp);
        inputRegionsRaw.add(String(inputRegion));
        inputRegionsMapped.add(String(mappedName));
        list.push({
          hours: d.hours,
          regionTrackingOptionId: trackingId!,
          earningsRateId: erId,
        });
        entriesByDate.set(d.entry_date, list);
      }

      // Use the pay run period dates, not the actual entry dates
      const timesheetStartDate = matchingPayRun.periodStartDate!;
      const timesheetEndDate = matchingPayRun.periodEndDate!;

      // Validate that all entry dates fall within the pay run period
      const payRunStart = new Date(timesheetStartDate);
      const payRunEnd = new Date(timesheetEndDate);
      let hasInvalidDate = false;

      for (const [date] of Array.from(entriesByDate.entries())) {
        const entryDate = new Date(date);
        if (entryDate < payRunStart || entryDate > payRunEnd) {
          failures.push({
            employee: emp.employee_name,
            reason: `Entry date ${date} falls outside pay run period ${timesheetStartDate} to ${timesheetEndDate}`,
          });
          hasInvalidDate = true;
          break; // Skip to next employee
        }
      }

      if (hasInvalidDate) {
        continue; // Skip this employee
      }

      // Debug: Log the exact pay run details
      console.log("🚀 ~ POST ~ Pay Run Details:", {
        payRunId: matchingPayRun.payRunID,
        payrollCalendarId,
        periodStart: matchingPayRun.periodStartDate,
        periodEnd: matchingPayRun.periodEndDate,
        status: matchingPayRun.payRunStatus,
        calendarType: matchingPayRun.calendarType,
      });

      // Verify pay run is in Draft status
      if (matchingPayRun.payRunStatus !== PayRun.PayRunStatusEnum.Draft) {
        failures.push({
          employee: emp.employee_name,
          reason: `Pay run status is '${matchingPayRun.payRunStatus}' but must be 'Draft' to add timesheets`,
        });
        continue;
      }

      console.log(
        "🚀 ~ POST ~ Using pay run period dates - Start:",
        timesheetStartDate,
        "End:",
        timesheetEndDate
      );

      const timesheetLines: TimesheetLine[] = Array.from(
        entriesByDate.entries()
      )
        .map(([date, entries]) => {
          return entries.map((e) => ({
            // Try simple date format first
            date: date, // Keep as "2025-09-08" format
            earningsRateID: e.earningsRateId,
            numberOfUnits: e.hours,
            trackingItemID: e.regionTrackingOptionId,
          }));
        })
        .flat();

      // Debug: Check employee's payroll calendar assignment
      try {
        const employeeResp = await client.payrollUKApi.getEmployee(
          tenantId,
          employeeId
        );
        const employee = employeeResp.body?.employee;

        console.log("🚀 ~ POST ~ Employee payroll details:", {
          employeeId: employee?.employeeID,
          employeePayrollCalendarId: employee?.payrollCalendarID,
          payRunPayrollCalendarId: payrollCalendarId,
          match: employee?.payrollCalendarID === payrollCalendarId,
        });

        // If employee has different calendar, use that one instead
        const actualPayrollCalendarId =
          employee?.payrollCalendarID || payrollCalendarId;

        // Check for existing timesheets
        const existingTimesheetsResp = await client.payrollUKApi.getTimesheets(
          tenantId,
          1,
          employeeId
        );

        console.log(
          "🚀 ~ POST ~ Existing timesheets:",
          existingTimesheetsResp.body?.timesheets?.length || 0
        );

        const conflictingTimesheet =
          existingTimesheetsResp.body?.timesheets?.find(
            (ts) =>
              (ts.startDate === timesheetStartDate ||
                ts.startDate === timesheetStartDate.split("T")[0]) &&
              (ts.endDate === timesheetEndDate ||
                ts.endDate === timesheetEndDate.split("T")[0])
          );

        if (conflictingTimesheet) {
          const existingStatus = conflictingTimesheet.status as unknown as string | undefined;
          const isDraft =
            existingStatus === (Timesheet.StatusEnum?.Draft as unknown as string) ||
            existingStatus === "Draft";

          if (!isDraft) {
            failures.push({
              employee: emp.employee_name,
              reason: `Existing timesheet for ${timesheetStartDate} to ${timesheetEndDate} is not in Draft status`,
            });
            continue;
          }

          // Plan to replace lines on the existing draft timesheet
          preparedLineReplacements.push({
            timesheetId: String(conflictingTimesheet.timesheetID),
            newLines: timesheetLines,
          });
        } else {
          preparedPayloads.push({
            payrollCalendarID: actualPayrollCalendarId!, // Use employee's calendar
            employeeID: employeeId,
            // Try different date formats
            startDate: matchingPayRun.periodStartDate!, // Keep exact format from pay run
            endDate: matchingPayRun.periodEndDate!,
            status: Timesheet.StatusEnum.Draft,
            timesheetLines: timesheetLines,
          });
        }
      } catch (employeeError: any) {
        console.log("🚀 ~ POST ~ Employee fetch error:", employeeError);
        failures.push({
          employee: emp.employee_name,
          reason: `Could not fetch employee details: ${employeeError.message}`,
        });
        continue;
      }

      // NOTE: Replace with actual POST when ready
      successes.push({
        employee: emp.employee_name,
        entries: emp.daily_entries.length,
      });
    }

    const success = failures.length === 0;
    const message = success
      ? "Timesheets validated. Ready to create draft pay run in Xero."
      : "Some employees failed validation. Please resolve and retry.";

    if (success) {
      const allRes: Array<{
        response: AxiosResponse<any, any>;
        body: TimesheetObject;
      }> = [];

      // Create new timesheets
      for (const timesheet of preparedPayloads) {
        const timeSheetRes = await client.payrollUKApi.createTimesheet(
          tenantId,
          timesheet
        );
        allRes.push(timeSheetRes);
      }

      // For existing draft timesheets: delete all existing lines and recreate with new lines
      for (const repl of preparedLineReplacements) {
        // Fetch current lines
        const existingTs = await client.payrollUKApi.getTimesheet(
          tenantId,
          repl.timesheetId
        );
        const currentLines = existingTs.body?.timesheet?.timesheetLines || [];

        // Delete existing lines
        for (const line of currentLines) {
          const lineId = (line as any)?.timesheetLineID as string | undefined;
          if (!lineId) continue;
          await client.payrollUKApi.deleteTimesheetLine(
            tenantId,
            repl.timesheetId,
            lineId
          );
        }

        // Create new lines
        for (const nl of repl.newLines) {
          const createLineRes = await client.payrollUKApi.createTimesheetLine(
            tenantId,
            repl.timesheetId,
            nl
          );
          allRes.push(createLineRes);
        }
      }

      return NextResponse.json({
        success,
        message:
          allRes.map((res) => res.response?.data?.message).join(", ") ||
          `Processed ${preparedPayloads.length} new and ${preparedLineReplacements.length} updated timesheet(s)`,
        employees_processed: successes.length,
        employees_failed: failures.length,
        failures,
      });
    }

    return NextResponse.json({
      success,
      message,
      employees_processed: successes.length,
      employees_failed: failures.length,
      failures,
      preview: {
        employee_name_to_id_count: employeeNameToId.size,
        earnings_rate_map_count: earningsRateNameToId.size,
        region_option_map_count: regionNameToTrackingOptionId.size,
        simplified_region_option_map_count:
          simplifiedRegionNameToTrackingOptionId.size,
        prepared_timesheets: preparedPayloads,
        applied_region_mapping: Object.fromEntries(
          normalizedRegionMapping.entries()
        ),
        input_regions_raw: Array.from(inputRegionsRaw),
        input_regions_mapped: Array.from(inputRegionsMapped),
        available_regions: availableRegionNames,
        available_earnings_rates: availableEarningsRateNames,
        selected_defaults: {
          regular: defaultRegularEarningsRateId,
          overtime: defaultOvertimeEarningsRateId,
        },
        pay_run_calendar_info: {
          calendar_id: payrollCalendarId,
          calendar_name: payRunCalendar.name,
          calendar_type: payRunCalendar.calendarType,
          period_start_date: payRunCalendar.periodStartDate,
          period_end_date: payRunCalendar.periodEndDate,
          payment_date: payRunCalendar.paymentDate,
        },
      },
      organization: authManager.getOrganizationName(),
      tenant_id: tenantId,
    });
  } catch (error: any) {
    console.log("🚀 ~ POST ~ error:", error);

    // Try to extract the Xero-specific error
    const extractedError: XeroErrorInfo = extractXeroError(error);
    console.log("🚀 ~ POST ~ extractedError:", extractedError);

    // Use the extracted status if available, otherwise default to 500
    const responseStatus = extractedError.status || 500;

    return NextResponse.json(
      {
        message: extractedError.message || "Failed to post to Xero",
        error: extractedError.message,
        status: extractedError.status,
        httpStatusCode: extractedError.httpStatusCode,
      },
      { status: responseStatus }
    );
  }
}
