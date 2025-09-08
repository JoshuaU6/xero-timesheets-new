import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { FileUpload } from "@/components/file-upload";
import { ProcessingResults } from "@/components/processing-results";
import { ProcessingResult } from "@shared/schema";
import { Moon, Sun, FlaskConical } from "lucide-react";

export default function Home() {
  const [darkMode, setDarkMode] = useState(false);
  const [currentResult, setCurrentResult] = useState<ProcessingResult | null>(null);
  const { toast } = useToast();

  const toggleTheme = () => {
    setDarkMode(!darkMode);
    document.documentElement.classList.toggle('dark');
  };

  const processFilesMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const response = await apiRequest("POST", "/api/process-timesheets", formData);
      return response.json();
    },
    onSuccess: (result: ProcessingResult) => {
      setCurrentResult(result);
      queryClient.invalidateQueries({ queryKey: ["/api/processing-results"] });
      toast({
        title: "Processing Complete",
        description: `Successfully processed timesheet data for ${result.summary.employees_found} employees.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Processing Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleFileUpload = (formData: FormData) => {
    processFilesMutation.mutate(formData);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2">
                <i className="fas fa-file-excel text-primary text-2xl"></i>
                <div>
                  <h1 className="text-xl font-semibold text-foreground">Timesheets to Xero Payroll</h1>
                  <p className="text-sm text-muted-foreground">Automated timesheet processing and consolidation</p>
                </div>
              </div>
            </div>
            <div className="flex items-center space-x-4">
              <span className="px-3 py-1 bg-accent text-accent-foreground rounded-full text-sm font-medium">
                <FlaskConical className="w-4 h-4 mr-1 inline" />
                MVP Version
              </span>
              <Button 
                variant="ghost" 
                size="icon" 
                onClick={toggleTheme}
                data-testid="button-theme-toggle"
              >
                {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-8 max-w-7xl">
        {/* Process Overview */}
        <div className="mb-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="flex items-center space-x-3 p-4 bg-card rounded-lg border border-border">
              <div className="w-8 h-8 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-semibold">1</div>
              <span className="text-sm font-medium text-foreground">Upload Files</span>
            </div>
            <div className={`flex items-center space-x-3 p-4 rounded-lg border border-border ${processFilesMutation.isPending || currentResult ? 'bg-primary/10' : 'bg-muted'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${processFilesMutation.isPending || currentResult ? 'bg-primary text-primary-foreground' : 'bg-muted-foreground text-background'}`}>2</div>
              <span className={`text-sm font-medium ${processFilesMutation.isPending || currentResult ? 'text-foreground' : 'text-muted-foreground'}`}>Parse & Validate</span>
            </div>
            <div className={`flex items-center space-x-3 p-4 rounded-lg border border-border ${currentResult ? 'bg-primary/10' : 'bg-muted'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${currentResult ? 'bg-primary text-primary-foreground' : 'bg-muted-foreground text-background'}`}>3</div>
              <span className={`text-sm font-medium ${currentResult ? 'text-foreground' : 'text-muted-foreground'}`}>Review Results</span>
            </div>
            <div className="flex items-center space-x-3 p-4 bg-muted rounded-lg border border-border">
              <div className="w-8 h-8 bg-muted-foreground text-background rounded-full flex items-center justify-center text-sm font-semibold">4</div>
              <span className="text-sm font-medium text-muted-foreground">Export to Xero</span>
            </div>
          </div>
        </div>

        {/* File Upload Section */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          <FileUpload 
            onFileUpload={handleFileUpload}
            isProcessing={processFilesMutation.isPending}
          />
          
          {/* Upload Status */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <i className="fas fa-list-check mr-2 text-primary"></i>
                Upload Status
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-4">
                {processFilesMutation.isPending && (
                  <div className="flex items-center justify-between p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <div className="flex items-center space-x-3">
                      <i className="fas fa-spinner fa-spin text-blue-600"></i>
                      <div>
                        <p className="font-medium text-blue-800">Processing files...</p>
                        <p className="text-sm text-blue-600">Parsing Excel data and validating employees</p>
                      </div>
                    </div>
                  </div>
                )}
                
                {processFilesMutation.isError && (
                  <div className="flex items-center justify-between p-3 bg-red-50 border border-red-200 rounded-lg">
                    <div className="flex items-center space-x-3">
                      <i className="fas fa-times-circle text-red-600"></i>
                      <div>
                        <p className="font-medium text-red-800">Processing Failed</p>
                        <p className="text-sm text-red-600">{processFilesMutation.error?.message}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-6 border-t border-border">
                <h4 className="font-medium text-foreground mb-3">Validation Settings</h4>
                <div className="space-y-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Known Employees</span>
                    <span className="text-foreground font-medium">3 employees</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Valid Regions</span>
                    <span className="text-foreground font-medium">Eastside, South, North</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Fuzzy Matching</span>
                    <span className="text-green-600 font-medium">
                      <i className="fas fa-check mr-1"></i>Enabled
                    </span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Processing Results */}
        {currentResult && (
          <ProcessingResults result={currentResult} />
        )}
      </main>

      <footer className="border-t border-border bg-card mt-16">
        <div className="container mx-auto px-6 py-8">
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              © 2024 EarlyAdoptersHub. MVP Solution for automated timesheet processing.
            </div>
            <div className="flex items-center space-x-4">
              <a href="#" className="text-muted-foreground hover:text-foreground text-sm">Documentation</a>
              <a href="#" className="text-muted-foreground hover:text-foreground text-sm">Support</a>
              <a href="#" className="text-muted-foreground hover:text-foreground text-sm">GitHub</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
