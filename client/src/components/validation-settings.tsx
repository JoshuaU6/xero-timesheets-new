import { useQuery } from "@tanstack/react-query";

interface Settings {
  validation: {
    fuzzyMatchThresholds: { high: number; medium: number; low: number };
    enabledAlgorithms: { levenshtein: boolean; jaccard: boolean; wordLevel: boolean };
  };
}

interface XeroStatus {
  connected: boolean;
  organization_name: string;
  tenant_id: string;
  known_employees: string[];
  valid_regions: string[];
}

export function ValidationSettings() {
  const { data: settings } = useQuery<Settings>({
    queryKey: ["/api/settings"],
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  const { data: xeroStatus } = useQuery<XeroStatus>({
    queryKey: ["/api/xero/status"],
    staleTime: 30 * 1000, // 30 seconds
  });

  const knownEmployeesCount = xeroStatus?.known_employees?.length || 0;
  const validRegions = xeroStatus?.valid_regions || [];
  const fuzzyMatchingEnabled = settings?.validation?.enabledAlgorithms ? 
    Object.values(settings.validation.enabledAlgorithms).some(enabled => enabled) : true;

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Xero Organization</span>
        <span className="text-foreground font-medium">
          {xeroStatus?.connected ? (xeroStatus.organization_name || 'Connected') : 'Not connected'}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Known Employees</span>
        <span className="text-foreground font-medium">
          {knownEmployeesCount} employee{knownEmployeesCount !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Valid Regions</span>
        <span className="text-foreground font-medium">
          {validRegions.length > 0 ? validRegions.join(', ') : 'Loading...'}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Fuzzy Matching</span>
        <span className={`font-medium ${fuzzyMatchingEnabled ? 'text-green-600' : 'text-red-600'}`}>
          <i className={`fas ${fuzzyMatchingEnabled ? 'fa-check' : 'fa-times'} mr-1`}></i>
          {fuzzyMatchingEnabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      {settings?.validation?.fuzzyMatchThresholds && (
        <div className="pt-2 border-t border-border/50">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Match Thresholds</span>
            <span className="text-foreground">
              High: {settings.validation.fuzzyMatchThresholds.high}% | 
              Medium: {settings.validation.fuzzyMatchThresholds.medium}% | 
              Low: {settings.validation.fuzzyMatchThresholds.low}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}