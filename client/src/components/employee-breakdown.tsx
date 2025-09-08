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
  return (
    <div className="space-y-6">
      {summaries.map((employee, index) => (
        <div key={employee.employee_name} className="space-y-3">
          {/* Employee Name Header */}
          <h3 className="text-lg font-semibold text-foreground border-b border-border pb-2" data-testid={`text-employee-name-${index}`}>
            {employee.employee_name}
          </h3>
          
          {/* Total Hours */}
          <div className="text-base" data-testid={`text-total-hours-${index}`}>
            <span className="font-medium">Total Hours:</span> {employee.total_hours}
          </div>
          
          {/* Hour Breakdown */}
          <div className="space-y-1 ml-4">
            <div data-testid={`text-regular-hours-${index}`}>
              <span className="font-medium">Regular:</span> {employee.regular_hours} hours
            </div>
            <div data-testid={`text-overtime-hours-${index}`}>
              <span className="font-medium">Overtime:</span> {employee.overtime_hours} hours
            </div>
            <div data-testid={`text-travel-hours-${index}`}>
              <span className="font-medium">Travel:</span> {employee.travel_hours} hours
            </div>
            <div data-testid={`text-holiday-hours-${index}`}>
              <span className="font-medium">Holiday:</span> {employee.holiday_hours} hours
            </div>
          </div>
          
          {/* Regions Worked */}
          <div>
            <span className="font-medium">Regions Worked:</span>{' '}
            <span data-testid={`text-regions-${index}`}>
              {employee.regions_worked.join(', ')}
            </span>
          </div>
          
          {/* Validation Notes */}
          {employee.validation_notes.length > 0 && (
            <div>
              <div className="font-medium mb-1">Validation Notes:</div>
              <ul className="list-disc list-inside ml-4 space-y-1">
                {employee.validation_notes.map((note, noteIndex) => (
                  <li key={noteIndex} data-testid={`text-validation-note-${index}-${noteIndex}`}>
                    {note}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
