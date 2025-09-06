import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConsolidatedTimesheet } from "@shared/schema";
import { Code, Copy, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface JsonOutputProps {
  data: ConsolidatedTimesheet;
}

export function JsonOutput({ data }: JsonOutputProps) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const handleCopyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      toast({
        title: "Copied to clipboard",
        description: "JSON data has been copied to your clipboard.",
      });
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast({
        title: "Failed to copy",
        description: "Could not copy to clipboard.",
        variant: "destructive",
      });
    }
  };

  const handleDownloadJson = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `consolidated-timesheet-${data.pay_period_end_date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center">
            <Code className="mr-2 text-primary" />
            Consolidated JSON Output
          </CardTitle>
          <div className="flex items-center space-x-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyToClipboard}
              data-testid="button-copy-json"
            >
              <Copy className="h-4 w-4 mr-1" />
              {copied ? 'Copied!' : 'Copy'}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleDownloadJson}
              data-testid="button-download-json"
            >
              <Download className="h-4 w-4 mr-1" />
              Download
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="bg-muted rounded-lg p-4 overflow-x-auto">
          <pre className="font-mono text-sm text-foreground" data-testid="text-json-output">
            <code>{JSON.stringify(data, null, 2)}</code>
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}
