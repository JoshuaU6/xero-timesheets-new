import { Badge } from "@/components/ui/badge";

interface EmployeeSummary {
  employee_name: string;
  matched_from: string;
  total_hours: number;
  regular_hours: number;
  overtime_hours: number;
  travel_hours: number;
  holiday_hours: number;
  overtime_rate: string;
  regions_worked: string[];
  validation_notes: string[];
}

interface EmployeeBreakdownProps {
  summaries: EmployeeSummary[];
}

export function EmployeeBreakdown({ summaries }: EmployeeBreakdownProps) {
  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(part => part.charAt(0))
      .join('')
      .toUpperCase();
  };

  const getAvatarColor = (index: number) => {
    const colors = [
      'bg-primary text-primary-foreground',
      'bg-secondary text-secondary-foreground',
      'bg-accent text-accent-foreground',
    ];
    return colors[index % colors.length];
  };

  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-foreground mb-4">Employee Breakdown</h3>

      {summaries.map((employee, index) => (
        <div key={employee.employee_name} className="border border-border rounded-lg">
          <div className="p-4 bg-muted/50 border-b border-border">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center font-semibold ${getAvatarColor(index)}`}>
                  {getInitials(employee.employee_name)}
                </div>
                <div>
                  <h4 className="font-medium text-foreground" data-testid={`text-employee-name-${index}`}>
                    {employee.employee_name}
                  </h4>
                  <p className="text-sm text-muted-foreground" data-testid={`text-matched-from-${index}`}>
                    Matched from "{employee.matched_from}"
                  </p>
                </div>
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold text-foreground" data-testid={`text-total-hours-${index}`}>
                  {employee.total_hours.toFixed(1)} hrs
                </div>
                <div className="text-sm text-muted-foreground">Total</div>
              </div>
            </div>
          </div>
          <div className="p-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
              <div className="text-center">
                <div className="text-lg font-semibold text-foreground" data-testid={`text-regular-hours-${index}`}>
                  {employee.regular_hours}
                </div>
                <div className="text-xs text-muted-foreground">Regular</div>
              </div>
              <div className="text-center">
                <div className={`text-lg font-semibold ${employee.overtime_hours > 0 ? 'text-amber-600' : 'text-foreground'}`} data-testid={`text-overtime-hours-${index}`}>
                  {employee.overtime_hours}
                </div>
                <div className="text-xs text-muted-foreground">Overtime</div>
              </div>
              <div className="text-center">
                <div className={`text-lg font-semibold ${employee.travel_hours > 0 ? 'text-blue-600' : 'text-foreground'}`} data-testid={`text-travel-hours-${index}`}>
                  {employee.travel_hours}
                </div>
                <div className="text-xs text-muted-foreground">Travel</div>
              </div>
              <div className="text-center">
                <div className={`text-lg font-semibold ${employee.holiday_hours > 0 ? 'text-green-600' : 'text-foreground'}`} data-testid={`text-holiday-hours-${index}`}>
                  {employee.holiday_hours}
                </div>
                <div className="text-xs text-muted-foreground">Holiday</div>
              </div>
              <div className="text-center">
                <div className={`text-sm font-medium ${employee.overtime_rate.startsWith('$') ? 'text-green-600' : 'text-foreground'}`} data-testid={`text-overtime-rate-${index}`}>
                  {employee.overtime_rate}
                </div>
                <div className="text-xs text-muted-foreground">OT Rate</div>
              </div>
            </div>
            <div className="flex items-center space-x-2 text-sm mb-3">
              <span className="text-muted-foreground">Regions:</span>
              {employee.regions_worked.map((region, regionIndex) => (
                <Badge 
                  key={region} 
                  variant="secondary" 
                  className="bg-primary/10 text-primary"
                  data-testid={`badge-region-${index}-${regionIndex}`}
                >
                  {region}
                </Badge>
              ))}
            </div>
            
            {employee.validation_notes.length > 0 && (
              <div className="text-xs text-muted-foreground">
                <strong>Validation Notes:</strong>
                <ul className="list-disc list-inside mt-1 space-y-1">
                  {employee.validation_notes.map((note, noteIndex) => (
                    <li key={noteIndex} data-testid={`text-validation-note-${index}-${noteIndex}`}>
                      {note}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
