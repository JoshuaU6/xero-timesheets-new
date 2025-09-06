import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ProcessingResult } from "@shared/schema";
import { EmployeeBreakdown } from "./employee-breakdown";
import { JsonOutput } from "./json-output";
import { BarChart3, CheckCircle, Download, Link } from "lucide-react";

interface ProcessingResultsProps {
  result: ProcessingResult;
}

export function ProcessingResults({ result }: ProcessingResultsProps) {
  const handleDownloadSummary = () => {
    const summaryData = {
      summary: result.summary,
      processed_at: result.created_at,
    };
    
    const blob = new Blob([JSON.stringify(summaryData, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `timesheet-summary-${new Date().toISOString().split('T')[0]}.json`;
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
              <Badge variant="secondary" className="bg-green-100 text-green-800">
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
              <div className="text-2xl font-bold text-primary" data-testid="text-files-processed">
                {result.summary.files_processed}
              </div>
              <div className="text-sm text-muted-foreground">Files Processed</div>
            </div>
            <div className="text-center p-4 bg-accent rounded-lg">
              <div className="text-2xl font-bold text-primary" data-testid="text-employees-found">
                {result.summary.employees_found}
              </div>
              <div className="text-sm text-muted-foreground">Employees Found</div>
            </div>
            <div className="text-center p-4 bg-accent rounded-lg">
              <div className="text-2xl font-bold text-primary" data-testid="text-total-hours">
                {result.summary.total_hours.toFixed(1)}
              </div>
              <div className="text-sm text-muted-foreground">Total Hours</div>
            </div>
            <div className="text-center p-4 bg-accent rounded-lg">
              <div className="text-2xl font-bold text-primary" data-testid="text-pay-period">
                {result.summary.pay_period}
              </div>
              <div className="text-sm text-muted-foreground">Pay Period</div>
            </div>
          </div>

          {/* Employee Breakdown */}
          <EmployeeBreakdown summaries={result.summary.employee_summaries} />
        </CardContent>
      </Card>

      {/* JSON Output */}
      <JsonOutput data={result.consolidated_data} />

      {/* Xero Integration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Link className="mr-2 text-primary" />
            Xero Integration (Future)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="bg-accent/50 border border-primary/20 rounded-lg p-4 mb-4">
            <div className="flex items-start space-x-3">
              <i className="fas fa-info-circle text-primary mt-1"></i>
              <div>
                <h4 className="font-medium text-foreground mb-1">Ready for Xero API Integration</h4>
                <p className="text-sm text-muted-foreground">
                  The consolidated JSON data is structured for direct posting to Xero Timesheets API endpoints.
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-muted-foreground">OAuth 2.0 Authentication</span>
              <Badge variant="secondary" className="bg-amber-100 text-amber-800">Pending</Badge>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-muted-foreground">Employee ID Mapping</span>
              <Badge variant="secondary" className="bg-amber-100 text-amber-800">Pending</Badge>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-muted-foreground">Region Tracking IDs</span>
              <Badge variant="secondary" className="bg-amber-100 text-amber-800">Pending</Badge>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-muted-foreground">Timesheet API Posting</span>
              <Badge variant="secondary" className="bg-amber-100 text-amber-800">Pending</Badge>
            </div>
          </div>

          <Button
            className="w-full mt-4"
            variant="secondary"
            disabled
            data-testid="button-connect-xero"
          >
            <i className="fas fa-cloud-upload-alt mr-2"></i>
            Connect to Xero (Coming Soon)
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
