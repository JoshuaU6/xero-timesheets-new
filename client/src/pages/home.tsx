"use client";
import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { FileUpload } from "@/components/file-upload";
import { ProcessingResults } from "@/components/processing-results";
import { FuzzyMatchConfirmation } from "@/components/fuzzy-match-confirmation";
import { ValidationSettings } from "@/components/validation-settings";
import { ProcessingResult } from "@shared/schema";
import { Moon, Sun, FlaskConical } from "lucide-react";

export default function Home() {
  const [darkMode, setDarkMode] = useState(false);
  const [currentResult, setCurrentResult] = useState<ProcessingResult | null>(null);
  const [xeroSubmitted, setXeroSubmitted] = useState(false);
  const [duplicateProtectionEnabled, setDuplicateProtectionEnabled] = useState(true);
  const [pendingMatches, setPendingMatches] = useState<any[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<FormData | null>(null);
  const { toast } = useToast();

  // Initialize theme from localStorage on first render
  useEffect(() => {
    try {
      const savedTheme = localStorage.getItem('theme');
      const shouldUseDark = savedTheme === 'dark';
      setDarkMode(shouldUseDark);
      document.documentElement.classList.toggle('dark', shouldUseDark);
    } catch {}
  }, []);

  const toggleTheme = () => {
    const nextDark = !darkMode;
    setDarkMode(nextDark);
    document.documentElement.classList.toggle('dark', nextDark);
    try {
      localStorage.setItem('theme', nextDark ? 'dark' : 'light');
    } catch {}
  };

  const processFilesMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      // Add duplicate protection setting as URL parameter instead of form data
      const skipValue = (!duplicateProtectionEnabled).toString();
      
      const url = `/api/process-timesheets?skipDuplicateCheck=${skipValue}`;
      const response = await apiRequest("POST", url, formData);
      
      if (!response.ok) {
        const errorData = await response.json();
        
        // Handle duplicate submission case
        if (response.status === 409 && errorData.isDuplicate) {
          const error = new Error(errorData.message) as Error & { isDuplicate: boolean; existingSubmission: any };
          error.isDuplicate = true;
          error.existingSubmission = errorData.existingSubmission;
          throw error;
        }
        
        throw new Error(errorData.message || 'Processing failed');
      }
      
      return response.json();
    },
    onSuccess: (result: any) => {
      if (result.needsConfirmation) {
        // Handle fuzzy match confirmations needed
        setPendingMatches(result.pendingMatches);
        setUploadedFiles(processFilesMutation.variables as FormData);
        toast({
          title: "Employee Name Confirmation Required",
          description: `Found ${result.pendingMatches.length} employee name(s) that need confirmation.`,
          variant: "default",
        });
      } else {
        // Normal successful processing
        setCurrentResult(result);
        setPendingMatches([]);
        setUploadedFiles(null);
        queryClient.invalidateQueries({ queryKey: ["/api/processing-results"] });
        toast({
          title: "Processing Complete",
          description: `Successfully processed timesheet data for ${result.summary.employees_found} employees.`,
        });
      }
    },
    onError: (error: Error & { isDuplicate?: boolean; existingSubmission?: any }) => {
      if (error.isDuplicate && error.existingSubmission) {
        toast({
          title: "⚠️ Duplicate Submission Detected",
          description: `These files were already processed on ${new Date(error.existingSubmission.created_at).toLocaleDateString()}. Status: ${error.existingSubmission.xero_submission_status}`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Processing Failed",
          description: error.message,
          variant: "destructive",
        });
      }
    },
  });

  const processWithConfirmationsMutation = useMutation({
    mutationFn: async ({ formData, confirmations }: { formData: FormData; confirmations: Record<string, string | null> }) => {
      formData.append('confirmations', JSON.stringify(confirmations));
      
      const response = await apiRequest("POST", "/api/process-timesheets-with-confirmations", formData);
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Processing with confirmations failed');
      }
      
      return response.json();
    },
    onSuccess: (result: ProcessingResult) => {
      setCurrentResult(result);
      setPendingMatches([]);
      setUploadedFiles(null);
      queryClient.invalidateQueries({ queryKey: ["/api/processing-results"] });
      toast({
        title: "Processing Complete",
        description: `Successfully processed timesheet data for ${result.summary.employees_found} employees with confirmations.`,
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

  const handleConfirmMatches = (confirmations: Record<string, string | null>) => {
    if (uploadedFiles) {
      processWithConfirmationsMutation.mutate({ 
        formData: uploadedFiles, 
        confirmations 
      });
    }
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
              
              {/* Duplicate Protection Toggle */}
              <div className="flex items-center space-x-2 px-3 py-1 bg-muted rounded-lg">
                <span className="text-xs text-muted-foreground">Duplicate Check:</span>
                <button
                  onClick={() => setDuplicateProtectionEnabled(!duplicateProtectionEnabled)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    duplicateProtectionEnabled ? 'bg-primary' : 'bg-gray-300'
                  }`}
                  data-testid="toggle-duplicate-protection"
                >
                  <span
                    className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                      duplicateProtectionEnabled ? 'translate-x-5' : 'translate-x-1'
                    }`}
                  />
                </button>
                <span className={`text-xs ${duplicateProtectionEnabled ? 'text-green-600' : 'text-amber-600'}`}>
                  {duplicateProtectionEnabled ? 'ON' : 'OFF'}
                </span>
              </div>
              
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
            <div className={`flex items-center space-x-3 p-4 rounded-lg border border-border ${xeroSubmitted ? 'bg-primary/10' : 'bg-muted'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${xeroSubmitted ? 'bg-primary text-primary-foreground' : 'bg-muted-foreground text-background'}`}>4</div>
              <span className={`text-sm font-medium ${xeroSubmitted ? 'text-foreground' : 'text-muted-foreground'}`}>Export to Xero</span>
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
                <ValidationSettings />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Fuzzy Match Confirmation Section */}
        {pendingMatches.length > 0 && (
          <div className="mb-8">
            <FuzzyMatchConfirmation
              pendingMatches={pendingMatches}
              onConfirmMatches={handleConfirmMatches}
              isProcessing={processWithConfirmationsMutation.isPending}
            />
          </div>
        )}

        {/* Processing Results */}
        {currentResult && (
          <ProcessingResults result={currentResult} onXeroSubmitted={() => setXeroSubmitted(true)} />
        )}
      </main>

      <footer className="border-t border-border bg-card mt-16">
        <div className="container mx-auto px-6 py-8">
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              © 2025 EarlyAdoptersHub. MVP Solution for automated timesheet processing.
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
