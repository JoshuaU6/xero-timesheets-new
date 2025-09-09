import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle, AlertCircle, Users } from "lucide-react";

interface FuzzyMatch {
  input_name: string;
  line_number?: number;
  file_type: string;
  suggestions: Array<{
    name: string;
    score: number;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  }>;
  auto_selected?: string;
}

interface FuzzyMatchConfirmationProps {
  pendingMatches: FuzzyMatch[];
  onConfirmMatches: (confirmations: Record<string, string | null>) => void;
  isProcessing?: boolean;
}

export function FuzzyMatchConfirmation({ 
  pendingMatches, 
  onConfirmMatches, 
  isProcessing = false 
}: FuzzyMatchConfirmationProps) {
  const [confirmations, setConfirmations] = useState<Record<string, string | null>>({});

  const getConfidenceColor = (confidence: string) => {
    switch (confidence) {
      case 'HIGH': return 'bg-green-100 text-green-800 border-green-200';
      case 'MEDIUM': return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'LOW': return 'bg-red-100 text-red-800 border-red-200';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const getConfidenceIcon = (confidence: string) => {
    switch (confidence) {
      case 'HIGH': return <CheckCircle className="w-4 h-4" />;
      case 'MEDIUM': return <AlertCircle className="w-4 h-4" />;
      case 'LOW': return <XCircle className="w-4 h-4" />;
      default: return <AlertCircle className="w-4 h-4" />;
    }
  };

  const handleSelectMatch = (inputName: string, selectedMatch: string | null) => {
    setConfirmations(prev => ({
      ...prev,
      [inputName]: selectedMatch
    }));
  };

  const handleConfirmAll = () => {
    // Fill in any missing confirmations with auto-selections or null
    const finalConfirmations = { ...confirmations };
    
    pendingMatches.forEach(match => {
      if (!(match.input_name in finalConfirmations)) {
        // Auto-select the highest confidence match if it's HIGH confidence
        const bestMatch = match.suggestions[0];
        if (bestMatch && bestMatch.confidence === 'HIGH' && bestMatch.score >= 90) {
          finalConfirmations[match.input_name] = bestMatch.name;
        } else {
          finalConfirmations[match.input_name] = null; // Skip this match
        }
      }
    });

    onConfirmMatches(finalConfirmations);
  };

  const allMatchesReviewed = pendingMatches.every(match => 
    match.input_name in confirmations
  );

  if (pendingMatches.length === 0) {
    return null;
  }

  return (
    <Card className="w-full" data-testid="fuzzy-match-confirmation">
      <CardHeader>
        <CardTitle className="flex items-center">
          <Users className="mr-2 text-blue-600" />
          Review Employee Name Matches
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Please review and confirm the following employee name matches found in your timesheets.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {pendingMatches.map((match, index) => (
          <div key={`${match.input_name}-${index}`} className="border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-medium text-foreground">
                  "{match.input_name}"
                  <span className="text-sm text-muted-foreground ml-2">
                    ({match.file_type}{match.line_number ? `, line ${match.line_number}` : ''})
                  </span>
                </h4>
              </div>
            </div>
            
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Suggested matches:</p>
              
              {match.suggestions.map((suggestion, suggestionIndex) => (
                <div key={suggestionIndex} className="flex items-center justify-between p-2 border rounded hover:bg-accent">
                  <div className="flex items-center space-x-3">
                    <div className="flex items-center space-x-2">
                      {getConfidenceIcon(suggestion.confidence)}
                      <span className="font-medium">{suggestion.name}</span>
                    </div>
                    <Badge className={getConfidenceColor(suggestion.confidence)}>
                      {Math.round(suggestion.score)}% {suggestion.confidence}
                    </Badge>
                  </div>
                  <Button
                    size="sm"
                    variant={confirmations[match.input_name] === suggestion.name ? "default" : "outline"}
                    onClick={() => handleSelectMatch(match.input_name, suggestion.name)}
                    data-testid={`select-match-${match.input_name}-${suggestion.name}`}
                  >
                    {confirmations[match.input_name] === suggestion.name ? "Selected" : "Select"}
                  </Button>
                </div>
              ))}
              
              <div className="flex items-center justify-between p-2 border rounded hover:bg-accent">
                <span className="text-muted-foreground">Skip this match (not found in known employees)</span>
                <Button
                  size="sm"
                  variant={confirmations[match.input_name] === null ? "default" : "outline"}
                  onClick={() => handleSelectMatch(match.input_name, null)}
                  data-testid={`skip-match-${match.input_name}`}
                >
                  {confirmations[match.input_name] === null ? "Skipped" : "Skip"}
                </Button>
              </div>
            </div>
          </div>
        ))}
        
        <div className="flex justify-between items-center pt-4 border-t">
          <p className="text-sm text-muted-foreground">
            {Object.keys(confirmations).length} of {pendingMatches.length} matches reviewed
          </p>
          <Button 
            onClick={handleConfirmAll}
            disabled={isProcessing}
            data-testid="confirm-all-matches"
            className="px-6"
          >
            {isProcessing ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                Processing...
              </>
            ) : (
              "Confirm and Continue"
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}