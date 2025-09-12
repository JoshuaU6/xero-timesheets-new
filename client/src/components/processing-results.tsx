import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ProcessingResult } from "@shared/schema";
import { EmployeeBreakdown } from "@/components/employee-breakdown";
import { JsonOutput } from "@/components/json-output";
import {
  BarChart3,
  CheckCircle,
  Download,
  Link,
  ExternalLink,
  Upload,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface ProcessingResultsProps {
  result: ProcessingResult;
  onXeroSubmitted?: () => void;
}

export function ProcessingResults({
  result,
  onXeroSubmitted,
}: ProcessingResultsProps) {
  const [xeroConnected, setXeroConnected] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitReport, setSubmitReport] = useState<null | {
    success: boolean;
    message: string;
    employees_processed: number;
    employees_failed?: number;
    failures?: Array<{ employee: string; reason: string }>;
    preview?: any;
  }>(null);
  const [showRawResponse, setShowRawResponse] = useState(false);
  const [regionMap, setRegionMap] = useState<Record<string, string>>({});
  const { toast } = useToast();
  const [regionTotals, setRegionTotals] = useState<Record<string, { regular: number; overtime: number; travel: number; holiday: number; total: number }>>({});

  // Fallback: derive per-employee summaries if server did not include them (e.g., confirmations path)
  const displayedEmployeeSummaries = useMemo(() => {
    const serverSummaries = result?.summary?.employee_summaries || [];
    if (serverSummaries.length > 0) return serverSummaries as any[];

    try {
      return (result?.consolidated_data?.employees || []).map((emp: any) => {
        let regular = 0, overtime = 0, travel = 0, holiday = 0;
        const regions = new Set<string>();
        let rate: number | null = null;
        for (const d of emp.daily_entries || []) {
          const hours = Number(d.hours) || 0;
          const type = d.hour_type as 'REGULAR' | 'OVERTIME' | 'TRAVEL' | 'HOLIDAY';
          regions.add(String(d.region_name || ''));
          if (type === 'REGULAR') regular += hours;
          if (type === 'OVERTIME') overtime += hours;
          if (type === 'TRAVEL') travel += hours;
          if (type === 'HOLIDAY') holiday += hours;
          if (d.overtime_rate !== null && d.overtime_rate !== undefined) rate = d.overtime_rate;
        }
        const total = regular + overtime + travel + holiday;
        return {
          employee_name: emp.employee_name,
          matched_from: emp.employee_name,
          total_hours: total,
          regular_hours: regular,
          overtime_hours: overtime,
          travel_hours: travel,
          holiday_hours: holiday,
          overtime_rate: rate ? `$${Number(rate).toFixed(2)}` : 'Standard',
          regions_worked: Array.from(regions).filter(Boolean),
          validation_notes: [],
        };
      });
    } catch {
      return [];
    }
  }, [result]);

  // Check Xero connection status on component mount
  useEffect(() => {
    checkXeroStatus();
    // Compute region totals from employee summaries
    try {
      const totals: Record<string, { regular: number; overtime: number; travel: number; holiday: number; total: number }> = {};
      for (const emp of result.summary.employee_summaries) {
        // Per-employee only lists regions, but detailed per-day entries are in consolidated_data
      }
      // Build from consolidated_data for accuracy
      for (const emp of result.consolidated_data.employees) {
        for (const d of emp.daily_entries as any[]) {
          const region = d.region_name || 'Unknown';
          const hourType = d.hour_type as 'REGULAR' | 'OVERTIME' | 'TRAVEL' | 'HOLIDAY';
          const hours = Number(d.hours) || 0;
          if (!totals[region]) totals[region] = { regular: 0, overtime: 0, travel: 0, holiday: 0, total: 0 };
          if (hourType === 'REGULAR') totals[region].regular += hours;
          if (hourType === 'OVERTIME') totals[region].overtime += hours;
          if (hourType === 'TRAVEL') totals[region].travel += hours;
          if (hourType === 'HOLIDAY') totals[region].holiday += hours;
          totals[region].total += hours;
        }
      }
      setRegionTotals(totals);
    } catch {}
  }, []);

  const checkXeroStatus = async () => {
    try {
      const response = await apiRequest("GET", "/api/xero/status");
      const data = await response.json();
      setXeroConnected(data.connected);
    } catch (error) {
      console.error("Error checking Xero status:", error);
    }
  };

  const handleConnectXero = async () => {
    try {
      console.log("🔘 Frontend: Starting Xero connection process...");
      console.log("🔘 Frontend: Making API call to /api/xero/connect-new");
      // Add cache buster to prevent cached responses
      const cacheBuster = Date.now();
      const response = await apiRequest(
        "GET",
        `/api/xero/connect-new?t=${cacheBuster}`
      );
      console.log("🔘 Frontend: Response received:", response.status);

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ message: "Unknown error" }));
        throw new Error(errorData.message || `HTTP ${response.status}`);
      }

      const data = await response.json();
      console.log("🔘 Frontend: Got consent URL, opening popup...");
      console.log(
        "🔘 Frontend: Consent URL received:",
        data.consentUrl ? "Yes" : "No"
      );

      if (!data.consentUrl) {
        throw new Error("No consent URL received from server");
      }

      console.log("🔘 Frontend: Opening popup window...");
      const popup = window.open(
        data.consentUrl,
        "_blank",
        "width=800,height=600"
      );

      if (!popup) {
        throw new Error(
          "Popup was blocked by browser. Please allow popups and try again."
        );
      }

      console.log(
        "🔘 Frontend: Popup opened successfully, starting polling..."
      );

      // Poll for connection status
      const pollInterval = setInterval(async () => {
        try {
          await checkXeroStatus();
          const statusResponse = await apiRequest("GET", "/api/xero/status");
          const statusData = await statusResponse.json();
          if (statusData.connected) {
            setXeroConnected(true);
            clearInterval(pollInterval);
            toast({
              title: "Xero Connected",
              description:
                "Successfully connected to Xero. You can now submit timesheets.",
            });
          }
        } catch (pollError) {
          console.error("Error during polling:", pollError);
        }
      }, 2000);

      // Stop polling after 60 seconds
      setTimeout(() => clearInterval(pollInterval), 60000);
    } catch (error) {
      console.error("Xero connection error:", error);
      toast({
        title: "Connection Failed",
        description:
          error instanceof Error
            ? error.message
            : "Failed to connect to Xero. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleSubmitToXero = async () => {
    setSubmitting(true);
    try {
      const response = await apiRequest("POST", "/api/xero/post-timesheets", {
        consolidated_data: result.consolidated_data,
      });
      const data = await response.json();
      setSubmitReport(data);
      // Pull any applied mapping preview (for visibility)
      const applied = data?.preview?.applied_region_mapping || {};
      if (applied && Object.keys(applied).length > 0) setRegionMap(applied);

      if (data.employees_failed && data.employees_failed > 0) {
        toast({
          title: "Partial validation",
          description: `${data.employees_failed} employee(s) need attention. See details below.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Success!",
          description: `${data.message} (${data.employees_processed} employees processed)`,
        });
      }

      // Call the callback to update the step 4 styling
      onXeroSubmitted?.();
    } catch (error: any) {
      console.log("🚀 ~ handleSubmitToXero ~ error:", error);
      toast({
        title: "Submission Failed",
        description:
          error.message ||
          "Failed to submit timesheets to Xero. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDownloadSummary = () => {
    const summaryData = {
      summary: result.summary,
      processed_at: result.created_at,
    };

    const blob = new Blob([JSON.stringify(summaryData, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `timesheet-summary-${
      new Date().toISOString().split("T")[0]
    }.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-8">
      {/* Processing Summary */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center">
              <BarChart3 className="mr-2 text-primary" />
              Processing Results
            </CardTitle>
            <div className="flex items-center space-x-2">
              <Badge
                variant="secondary"
                className="bg-green-100 text-green-800"
              >
                <CheckCircle className="w-4 h-4 mr-1" />
                Processing Complete
              </Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadSummary}
                data-testid="button-download-summary"
              >
                <Download className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="text-center p-4 bg-accent rounded-lg">
              <div
                className="text-2xl font-bold text-primary"
                data-testid="text-files-processed"
              >
                {result.summary.files_processed}
              </div>
              <div className="text-sm text-muted-foreground">
                Files Processed
              </div>
            </div>
            <div className="text-center p-4 bg-accent rounded-lg">
              <div
                className="text-2xl font-bold text-primary"
                data-testid="text-employees-found"
              >
                {result.summary.employees_found}
              </div>
              <div className="text-sm text-muted-foreground">
                Employees Found
              </div>
            </div>
            <div className="text-center p-4 bg-accent rounded-lg">
              <div
                className="text-2xl font-bold text-primary"
                data-testid="text-total-hours"
              >
                {result.summary.total_hours.toFixed(1)}
              </div>
              <div className="text-sm text-muted-foreground">Total Hours</div>
            </div>
            <div className="text-center p-4 bg-accent rounded-lg">
              <div
                className="text-2xl font-bold text-primary"
                data-testid="text-pay-period"
              >
                {result.summary.pay_period}
              </div>
              <div className="text-sm text-muted-foreground">Pay Period</div>
            </div>
          </div>

          {/* Parsing Results Summary */}
          <div className="space-y-4 mb-8">
            <h3 className="text-xl font-semibold text-foreground">
              Parsing Results Summary
            </h3>

            <div className="space-y-2 text-sm">
              <div>
                <span className="font-medium">Files Processed:</span>{" "}
                {result.summary.files_processed}
              </div>
              <div>
                <span className="font-medium">Pay Period End Date:</span>{" "}
                {result.consolidated_data.pay_period_end_date}
              </div>
            </div>
          </div>


          {/* Employee Breakdown */}
          <EmployeeBreakdown summaries={displayedEmployeeSummaries as any} />

          {/* Totals by Region (below employee breakdown) */}
          {Object.keys(regionTotals).length > 0 && (
            <div className="space-y-3 mt-8">
              <h3 className="text-xl font-semibold text-foreground">Totals by Region</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border border-border rounded">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left p-2">Region</th>
                      <th className="text-right p-2">Regular</th>
                      <th className="text-right p-2">Overtime</th>
                      <th className="text-right p-2">Travel</th>
                      <th className="text-right p-2">Holiday</th>
                      <th className="text-right p-2">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(regionTotals).map(([region, t]) => (
                      <tr key={region} className="border-t border-border">
                        <td className="p-2">{region}</td>
                        <td className="p-2 text-right">{t.regular.toFixed(1)}</td>
                        <td className="p-2 text-right">{t.overtime.toFixed(1)}</td>
                        <td className="p-2 text-right">{t.travel.toFixed(1)}</td>
                        <td className="p-2 text-right">{t.holiday.toFixed(1)}</td>
                        <td className="p-2 text-right font-medium">{t.total.toFixed(1)}</td>
                      </tr>
                    ))}
                    {/* Grand total row */}
                    <tr className="border-t border-border bg-accent/40">
                      <td className="p-2 font-medium">Grand Total</td>
                      <td className="p-2 text-right font-medium">{Object.values(regionTotals).reduce((s, r) => s + r.regular, 0).toFixed(1)}</td>
                      <td className="p-2 text-right font-medium">{Object.values(regionTotals).reduce((s, r) => s + r.overtime, 0).toFixed(1)}</td>
                      <td className="p-2 text-right font-medium">{Object.values(regionTotals).reduce((s, r) => s + r.travel, 0).toFixed(1)}</td>
                      <td className="p-2 text-right font-medium">{Object.values(regionTotals).reduce((s, r) => s + r.holiday, 0).toFixed(1)}</td>
                      <td className="p-2 text-right font-semibold">{Object.values(regionTotals).reduce((s, r) => s + r.total, 0).toFixed(1)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* JSON Output */}
      <JsonOutput data={result.consolidated_data} />

      {/* Xero Integration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Link className="mr-2 text-primary" />
            Xero Integration
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="bg-accent/50 border border-primary/20 rounded-lg p-4 mb-4">
            <div className="flex items-start space-x-3">
              <i className="fas fa-info-circle text-primary mt-1"></i>
              <div>
                <h4 className="font-medium text-foreground mb-1">
                  {xeroConnected
                    ? "Ready to Submit to Xero"
                    : "Connect to Xero to Continue"}
                </h4>
                <p className="text-sm text-muted-foreground">
                  {xeroConnected
                    ? "Your timesheet data is ready to be posted to Xero's Timesheets API."
                    : "Connect to your Xero organization to enable timesheet submission."}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-muted-foreground">
                OAuth 2.0 Authentication
              </span>
              <Badge
                variant="secondary"
                className={
                  xeroConnected
                    ? "bg-green-100 text-green-800"
                    : "bg-amber-100 text-amber-800"
                }
              >
                {xeroConnected ? "Connected" : "Pending"}
              </Badge>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-muted-foreground">
                Timesheet Data Processing
              </span>
              <Badge
                variant="secondary"
                className="bg-green-100 text-green-800"
              >
                Complete
              </Badge>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-muted-foreground">
                Employee Validation
              </span>
              <Badge
                variant="secondary"
                className="bg-green-100 text-green-800"
              >
                Complete
              </Badge>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-muted-foreground">
                Region Allocation
              </span>
              <Badge
                variant="secondary"
                className="bg-green-100 text-green-800"
              >
                Complete
              </Badge>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            {!xeroConnected ? (
              <Button
                className="w-full"
                onClick={handleConnectXero}
                data-testid="button-connect-xero"
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Connect to Xero
              </Button>
            ) : (
              <Button
                className="w-full"
                onClick={handleSubmitToXero}
                disabled={submitting}
                data-testid="button-submit-xero"
              >
                <Upload className="mr-2 h-4 w-4" />
                {submitting ? "Submitting..." : "Submit to Xero"}
              </Button>
            )}
          </div>

          {submitReport &&
            submitReport.employees_failed &&
            submitReport.employees_failed > 0 && (
              <div className="mt-6">
                <h4 className="font-semibold text-foreground mb-2">
                  Employees needing attention
                </h4>
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
                  <ul className="list-disc pl-5 space-y-1">
                    {submitReport.failures?.map((f, idx) => (
                      <li key={idx} className="text-amber-900">
                        <span className="font-medium">{f.employee}</span>:{" "}
                        {f.reason}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="mt-4 p-3 border rounded-md bg-muted">
                  <div className="font-medium mb-2">Region mapping</div>
                  <p className="text-sm text-muted-foreground mb-3">
                    Map spreadsheet region names to Xero options (Settings →
                    Xero). This persists.
                  </p>
                  <RegionMappingEditor
                    currentMap={regionMap}
                    onSaved={(m) => setRegionMap(m)}
                  />
                </div>
                <div className="mt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowRawResponse((v) => !v)}
                  >
                    {showRawResponse ? "Hide" : "Show"} full API response
                  </Button>
                  {showRawResponse && (
                    <pre className="mt-2 text-xs whitespace-pre-wrap bg-accent/50 p-2 rounded border">
                      {JSON.stringify(submitReport, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            )}
        </CardContent>
      </Card>
    </div>
  );
}

function RegionMappingEditor({
  currentMap,
  onSaved,
}: {
  currentMap: Record<string, string>;
  onSaved: (m: Record<string, string>) => void;
}) {
  const [map, setMap] = useState<Record<string, string>>(currentMap || {});
  const [keyInput, setKeyInput] = useState("");
  const [valInput, setValInput] = useState("");

  useEffect(() => {
    setMap(currentMap || {});
  }, [currentMap]);

  const save = async () => {
    const update: Record<string, string> = { ...map };
    if (keyInput && valInput) update[keyInput] = valInput;
    try {
      const res = await apiRequest("PATCH", "/api/settings", {
        xero: { regionMapping: update },
      });
      const data = await res.json();
      if (data?.success) onSaved(update);
    } catch {}
  };

  const remove = async (k: string) => {
    const update = { ...map };
    delete update[k];
    try {
      const res = await apiRequest("PATCH", "/api/settings", {
        xero: { regionMapping: update },
      });
      const data = await res.json();
      if (data?.success) onSaved(update);
    } catch {}
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          id="region-mapping-key"
          name="regionMappingKey"
          className="flex-1 px-2 py-1 border rounded"
          placeholder="Spreadsheet region (e.g., South)"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
        />
        <input
          id="region-mapping-value"
          name="regionMappingValue"
          className="flex-1 px-2 py-1 border rounded"
          placeholder="Xero option (e.g., South)"
          value={valInput}
          onChange={(e) => setValInput(e.target.value)}
        />
        <Button size="sm" onClick={save}>
          Save
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">Existing mappings</div>
      <ul className="space-y-1">
        {Object.entries(map).map(([k, v]) => (
          <li
            key={k}
            className="flex items-center justify-between text-sm bg-accent/50 px-2 py-1 rounded"
          >
            <span>
              {k} → {v}
            </span>
            <Button variant="outline" size="sm" onClick={() => remove(k)}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
