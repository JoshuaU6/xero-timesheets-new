import { useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FileX, Upload, FileSpreadsheet, Route, Calculator } from "lucide-react";

interface FileUploadProps {
  onFileUpload: (formData: FormData) => void;
  isProcessing: boolean;
}

export function FileUpload({ onFileUpload, isProcessing }: FileUploadProps) {
  const [files, setFiles] = useState<{
    site_timesheet: File | null;
    travel_timesheet: File | null;
    overtime_rates: File | null;
  }>({
    site_timesheet: null,
    travel_timesheet: null,
    overtime_rates: null,
  });

  const siteInputRef = useRef<HTMLInputElement>(null);
  const travelInputRef = useRef<HTMLInputElement>(null);
  const overtimeInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (type: keyof typeof files, file: File | null) => {
    setFiles(prev => ({ ...prev, [type]: file }));
  };

  const handleProcessFiles = () => {
    if (!files.site_timesheet || !files.travel_timesheet || !files.overtime_rates) {
      return;
    }

    const formData = new FormData();
    formData.append('site_timesheet', files.site_timesheet);
    formData.append('travel_timesheet', files.travel_timesheet);
    formData.append('overtime_rates', files.overtime_rates);

    onFileUpload(formData);
  };

  const allFilesUploaded = files.site_timesheet && files.travel_timesheet && files.overtime_rates;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center">
          <Upload className="mr-2 text-primary" />
          Upload Required Files
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4">
          {/* Site Timesheet Upload */}
          <div className="space-y-2">
            <Label htmlFor="site-timesheet" className="text-sm font-medium">
              Site Timesheet (Multi-tab)
            </Label>
            <div className="upload-dropzone bg-accent rounded-lg p-6 border-2 border-dashed border-border hover:border-primary transition-colors">
              <div className="text-center space-y-2">
                <FileSpreadsheet className="mx-auto text-primary" size={48} />
                <h3 className="font-medium text-foreground">Site Timesheet (Multi-tab)</h3>
                <p className="text-sm text-muted-foreground">Excel file with regional data across multiple tabs</p>
                <div className="flex items-center justify-center space-x-2 text-xs text-muted-foreground">
                  <i className="fas fa-info-circle"></i>
                  <span>Supports .xlsx, .xls formats</span>
                </div>
                {files.site_timesheet ? (
                  <p className="text-green-600 font-medium">✓ {files.site_timesheet.name}</p>
                ) : (
                  <Button 
                    variant="outline" 
                    onClick={() => siteInputRef.current?.click()}
                    data-testid="button-upload-site-timesheet"
                  >
                    Select File
                  </Button>
                )}
              </div>
              <Input
                ref={siteInputRef}
                id="site-timesheet"
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => handleFileChange('site_timesheet', e.target.files?.[0] || null)}
                data-testid="input-site-timesheet"
              />
            </div>
          </div>

          {/* Travel Timesheet Upload */}
          <div className="space-y-2">
            <Label htmlFor="travel-timesheet" className="text-sm font-medium">
              Travel Timesheet
            </Label>
            <div className="upload-dropzone bg-secondary rounded-lg p-6 border-2 border-dashed border-border hover:border-primary transition-colors">
              <div className="text-center space-y-2">
                <Route className="mx-auto text-primary" size={48} />
                <h3 className="font-medium text-foreground">Travel Timesheet</h3>
                <p className="text-sm text-muted-foreground">Employee travel time records</p>
                <div className="flex items-center justify-center space-x-2 text-xs text-muted-foreground">
                  <i className="fas fa-clock"></i>
                  <span>Distributed across working days</span>
                </div>
                {files.travel_timesheet ? (
                  <p className="text-green-600 font-medium">✓ {files.travel_timesheet.name}</p>
                ) : (
                  <Button 
                    variant="outline" 
                    onClick={() => travelInputRef.current?.click()}
                    data-testid="button-upload-travel-timesheet"
                  >
                    Select File
                  </Button>
                )}
              </div>
              <Input
                ref={travelInputRef}
                id="travel-timesheet"
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => handleFileChange('travel_timesheet', e.target.files?.[0] || null)}
                data-testid="input-travel-timesheet"
              />
            </div>
          </div>

          {/* Employee Overtime Rates Upload */}
          <div className="space-y-2">
            <Label htmlFor="overtime-rates" className="text-sm font-medium">
              Employee Overtime Rates
            </Label>
            <div className="upload-dropzone bg-secondary rounded-lg p-6 border-2 border-dashed border-border hover:border-primary transition-colors">
              <div className="text-center space-y-2">
                <Calculator className="mx-auto text-primary" size={48} />
                <h3 className="font-medium text-foreground">Employee Overtime Rates</h3>
                <p className="text-sm text-muted-foreground">Master sheet with overtime pay rates</p>
                <div className="flex items-center justify-center space-x-2 text-xs text-muted-foreground">
                  <i className="fas fa-user-tie"></i>
                  <span>Employee-specific rates</span>
                </div>
                {files.overtime_rates ? (
                  <p className="text-green-600 font-medium">✓ {files.overtime_rates.name}</p>
                ) : (
                  <Button 
                    variant="outline" 
                    onClick={() => overtimeInputRef.current?.click()}
                    data-testid="button-upload-overtime-rates"
                  >
                    Select File
                  </Button>
                )}
              </div>
              <Input
                ref={overtimeInputRef}
                id="overtime-rates"
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => handleFileChange('overtime_rates', e.target.files?.[0] || null)}
                data-testid="input-overtime-rates"
              />
            </div>
          </div>
        </div>

        <Button
          className="w-full"
          onClick={handleProcessFiles}
          disabled={!allFilesUploaded || isProcessing}
          data-testid="button-process-files"
        >
          {isProcessing ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>
              Processing Files...
            </>
          ) : (
            <>
              <i className="fas fa-cogs mr-2"></i>
              Process Files
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
