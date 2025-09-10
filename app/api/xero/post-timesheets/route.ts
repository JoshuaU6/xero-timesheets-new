import { AxiosResponse } from "axios";
import { NextRequest, NextResponse } from "next/server";
import { authManager } from "@server/auth-manager";
import { settingsManager } from "@server/settings-manager";
import { PayRunCalendar } from "xero-node/dist/gen/model/payroll-uk/payRunCalendar";
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

    const payrollCalendarsResp = await client.payrollUKApi.getPayRunCalendars(
      tenantId
    );

    const payrollCalendarId = payrollCalendarsResp.body?.payRunCalendars?.find(
      (payRun) => payRun.calendarType === PayRunCalendar.CalendarTypeEnum.Weekly
    )?.payrollCalendarID;

    const failures: Array<{ employee: string; reason: string }> = [];
    const successes: Array<{ employee: string; entries: number }> = [];
    const preparedPayloads: Array<Timesheet> = [];

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
        const erName = isOvertime ? "Overtime Hours" : "Regular Hours";
        const erId =
          earningsRateNameToId.get(normalize(erName)) ||
          (isOvertime
            ? defaultOvertimeEarningsRateId
            : defaultRegularEarningsRateId);
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

      // Prepare a preview payload matching Xero Timesheet format (UK payroll)
      const payPeriodEnd = data.pay_period_end_date;
      const startDate = new Date(payPeriodEnd);
      startDate.setDate(startDate.getDate() - 6); // 7-day period ending on pay_period_end_date
      const timesheetLines: TimesheetLine[] = Array.from(
        entriesByDate.entries()
      )
        .map(([date, entries]) => {
          return entries.map((e) => ({
            date,
            earningsRateID: e.earningsRateId,
            numberOfUnits: e.hours,
            trackingItemID: e.regionTrackingOptionId,
          }));
        })
        .flat();

      preparedPayloads.push({
        payrollCalendarID: payrollCalendarId!,
        employeeID: employeeId,
        startDate: startDate.toISOString().slice(0, 10),
        endDate: new Date(data.pay_period_end_date).toISOString().slice(0, 10),
        status: Timesheet.StatusEnum.Draft,
        timesheetLines: timesheetLines,
      });

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

      for (const timesheet of preparedPayloads) {
        const timeSheetRes = await client.payrollUKApi.createTimesheet(
          tenantId,
          timesheet
        );

        allRes.push(timeSheetRes);
      }

      return NextResponse.json({
        success,
        message: allRes.map((res) => res.response?.data?.message).join(", "),
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
      },
      organization: authManager.getOrganizationName(),
      tenant_id: tenantId,
    });
  } catch (error: any) {
    console.log("🚀 ~ POST ~ error:", error);

    // Try to extract the Xero-specific error
    const extractedError: XeroErrorInfo = extractXeroError(error);
    console.log("🚀 ~ POST ~ extractedError:", extractedError)

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
