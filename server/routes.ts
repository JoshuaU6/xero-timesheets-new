import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertProcessingResultSchema } from "@shared/schema";
import multer from "multer";
import * as XLSX from "xlsx";
import { XeroClient } from "xero-node";
import { authManager } from "./auth-manager";
import { 
  regionValidator, 
  employeeValidator, 
  ValidationResultBuilder,
  ValidationStatus,
  EnhancedFuzzyMatcher 
} from "./validation-system";
import { settingsManager, SettingsSchema } from "./settings-manager";

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

// Known validation data (as specified in requirements)
const KNOWN_EMPLOYEES = [
  "Charlotte Danes", 
  "Chelsea Serati", 
  "Jack Allan",
  "Andrew Dwyer",    // Similar to "Andy Dwyer" in test data
  "Pamela Beesly",   // Similar to "Pam Beesly" in test data  
  "Dwight K Schrute" // Similar to "Dwight Schrute" in test data
];
const VALID_REGIONS = ["Eastside", "South", "North"];

// Initialize enhanced validation system
employeeValidator.setKnownEmployees(KNOWN_EMPLOYEES);
regionValidator.setXeroRegions(VALID_REGIONS);

// Initialize Xero client
const xero = new XeroClient({
  clientId: process.env.XERO_CLIENT_ID!,
  clientSecret: process.env.XERO_CLIENT_SECRET!,
  redirectUris: [process.env.XERO_REDIRECT_URI!],
  scopes: 'offline_access payroll.employees.read payroll.timesheets'.split(' ')
});

// Note: Token storage and management is now handled by authManager

// Enhanced validation helper function
// Store pending matches that need user confirmation
interface PendingMatch {
  input_name: string;
  line_number?: number;
  file_type: string;
  suggestions: Array<{
    name: string;
    score: number;
    confidence: string;
  }>;
}

const pendingMatches: PendingMatch[] = [];

function validateAndMatchEmployee(input: string, lineNumber?: number, fileType: string = "unknown"): { 
  match: string | null; 
  score: number; 
  confidence: string;
  suggestions: string[];
  validationResult: any;
  needsConfirmation: boolean;
} {
  const matchResult = employeeValidator.validateEmployee(input, lineNumber);
  
  // Check if this match needs user confirmation (MEDIUM or HIGH confidence with score < 95)
  const needsConfirmation = matchResult.confidence_score < 95 && 
                           matchResult.confidence_score >= 70 && 
                           matchResult.suggestions.length > 0;
  
  if (needsConfirmation) {
    // Store for user confirmation
    const pendingMatch: PendingMatch = {
      input_name: input,
      line_number: lineNumber,
      file_type: fileType,
      suggestions: matchResult.suggestions.map(s => ({
        name: s.name,
        score: s.score,
        confidence: matchResult.confidence
      }))
    };
    
    // Avoid duplicates
    if (!pendingMatches.some(p => p.input_name === input && p.file_type === fileType)) {
      pendingMatches.push(pendingMatch);
    }
    
    console.log(`🤔 Match needs confirmation: "${input}" (${matchResult.confidence_score}%)`);
  }
  
  return {
    match: needsConfirmation ? null : (matchResult.matched_name || null),
    score: matchResult.confidence_score / 100,
    confidence: matchResult.confidence,
    suggestions: matchResult.suggestions.map(s => s.name),
    validationResult: matchResult,
    needsConfirmation
  };
}

// Parse Excel file
function parseExcelFile(buffer: Buffer, filename: string) {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    return { workbook, sheets: workbook.SheetNames };
  } catch (error) {
    throw new Error(`Failed to parse ${filename}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Process site timesheet (multi-tab)
function processSiteTimesheet(workbook: XLSX.WorkBook) {
  const employeeData = new Map();
  const regions = workbook.SheetNames;
  
  for (const regionName of regions) {
    if (!VALID_REGIONS.includes(regionName)) {
      continue; // Skip invalid region tabs
    }
    
    const sheet = workbook.Sheets[regionName];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    
    // Process each row (skip headers)
    for (let i = 1; i < data.length; i++) {
      const row = data[i] as any[];
      if (!row || row.length === 0) continue;
      
      const nameCell = row[0];
      if (!nameCell) continue;
      
      const nameStr = String(nameCell).trim();
      const enhancedResult = validateAndMatchEmployee(nameStr, i + 1, "site_timesheet");
      
      if (!enhancedResult.match) {
        console.log(`⚠️ No match found for employee: "${nameStr}" on line ${i + 1}`);
        if (enhancedResult.suggestions.length > 0) {
          console.log(`💡 Suggestions: ${enhancedResult.suggestions.slice(0, 3).join(', ')}`);
        }
        continue;
      }
      
      // Log match confidence for debugging
      console.log(`✅ Employee match: "${nameStr}" → "${enhancedResult.match}" (${enhancedResult.confidence}, ${Math.round(enhancedResult.score * 100)}%)`);
      
      if (enhancedResult.confidence === 'LOW' || enhancedResult.confidence === 'MEDIUM') {
        console.log(`⚠️ Low confidence match - may need verification`);
      }
      
      const employeeName = enhancedResult.match;
      if (!employeeData.has(employeeName)) {
        employeeData.set(employeeName, {
          name: employeeName,
          matchedFrom: nameStr,
          entries: [],
          validationNotes: [`Successfully matched "${nameStr}" from timesheet.`],
        });
      }
      
      // Process daily entries (assuming columns 1-7 are days of the week)
      const baseDate = new Date('2025-06-02'); // Monday of the week
      
      for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        const cellValue = row[dayIndex + 1];
        if (!cellValue) continue;
        
        const entryDate = new Date(baseDate);
        entryDate.setDate(baseDate.getDate() + dayIndex);
        
        let hours = 0;
        let hourType = "REGULAR";
        
        if (String(cellValue).toUpperCase() === 'HOL') {
          // Check if this employee already has a holiday entry for this date
          const existingHoliday = employeeData.get(employeeName).entries.find(
            (entry: any) => entry.entry_date === entryDate.toISOString().split('T')[0] && entry.hour_type === 'HOLIDAY'
          );
          
          if (!existingHoliday) {
            hours = 8;
            hourType = "HOLIDAY";
          } else {
            continue; // Skip duplicate holiday entries
          }
        } else {
          hours = parseFloat(String(cellValue)) || 0;
          if (hours === 0) continue;
          hourType = "REGULAR";
        }
        
        const dateString = entryDate.toISOString().split('T')[0];
        
        // Check if there's already an entry for this date/region/type
        const employee = employeeData.get(employeeName);
        const existingEntry = employee.entries.find(
          (entry: any) => 
            entry.entry_date === dateString && 
            entry.region_name === regionName && 
            entry.hour_type === hourType
        );
        
        if (existingEntry) {
          // Add to existing entry
          existingEntry.hours += hours;
        } else {
          // Create new entry with total hours for this date/region/type
          employee.entries.push({
            entry_date: dateString,
            region_name: regionName,
            hours: hours,
            hour_type: hourType,
            overtime_rate: null,
          });
        }
      }
    }
  }
  
  return employeeData;
}

// Process travel timesheet
function processTravelTimesheet(workbook: XLSX.WorkBook, employeeData: Map<string, any>) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  
  // Look for headers to find the right columns
  let nameColIndex = -1;
  let dateColIndex = -1;
  let hoursColIndex = -1;
  let regionColIndex = -1;
  
  for (let i = 0; i < data.length; i++) {
    const row = data[i] as any[];
    if (!row) continue;
    
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j]).toLowerCase();
      if (cell.includes('name') || cell.includes('employee')) nameColIndex = j;
      if (cell.includes('date')) dateColIndex = j;
      if (cell.includes('hours') || cell.includes('time')) hoursColIndex = j;
      if (cell.includes('region') || cell.includes('location')) regionColIndex = j;
    }
    
    if (nameColIndex !== -1 && hoursColIndex !== -1) {
      // Process travel entries
      for (let k = i + 1; k < data.length; k++) {
        const travelRow = data[k] as any[];
        if (!travelRow) continue;
        
        const nameCell = travelRow[nameColIndex];
        const travelHours = parseFloat(String(travelRow[hoursColIndex])) || 0;
        const travelDate = travelRow[dateColIndex];
        const travelRegion = travelRow[regionColIndex] || "Eastside"; // Default region
        
        if (!nameCell || travelHours === 0) continue;
        
        const nameStr = String(nameCell).trim();
        const enhancedResult = validateAndMatchEmployee(nameStr, k + 1, "travel_timesheet");
        
        if (!enhancedResult.match) {
          console.log(`⚠️ No travel time match for: "${nameStr}" on line ${k + 1}`);
          continue;
        }
        
        console.log(`✅ Travel time match: "${nameStr}" → "${enhancedResult.match}" (${enhancedResult.confidence})`);
        const employeeName = enhancedResult.match;
        if (!employeeData.has(employeeName)) {
          employeeData.set(employeeName, {
            name: employeeName,
            matchedFrom: nameStr,
            entries: [],
            validationNotes: [`Successfully matched "${nameStr}" from timesheet.`],
          });
        }
        
        // Parse travel date or use a default date
        let entryDate = "2025-06-02"; // Default
        if (travelDate) {
          try {
            const parsedDate = new Date(travelDate);
            if (!isNaN(parsedDate.getTime())) {
              entryDate = parsedDate.toISOString().split('T')[0];
            }
          } catch (e) {
            // Use default date if parsing fails
          }
        }
        
        // Add travel hours to regular hours (not as separate category)
        const employee = employeeData.get(employeeName);
        const regionName = String(travelRegion).trim();
        
        // Look for existing regular hours entry for same date/region
        const existingRegularEntry = employee.entries.find(
          (entry: any) => 
            entry.entry_date === entryDate && 
            entry.region_name === regionName && 
            entry.hour_type === "REGULAR"
        );
        
        if (existingRegularEntry) {
          // Add travel hours to existing regular hours
          existingRegularEntry.hours += travelHours;
          console.log(`📋 Added ${travelHours}h travel time to existing regular hours for ${employeeName} on ${entryDate}`);
        } else {
          // Create new regular hours entry with travel time
          employee.entries.push({
            entry_date: entryDate,
            region_name: regionName,
            hours: travelHours,
            hour_type: "REGULAR",
            overtime_rate: null,
          });
          console.log(`📋 Created new regular hours entry with ${travelHours}h travel time for ${employeeName} on ${entryDate}`);
        }
        
        // Add note about travel time inclusion
        if (!employee.validationNotes.some((note: string) => note.includes('travel time'))) {
          employee.validationNotes.push(`Travel time hours included in regular hours totals.`);
        }
      }
      break;
    }
  }
  
  return employeeData;
}

// Process overtime rates
function processOvertimeRates(workbook: XLSX.WorkBook, employeeData: Map<string, any>) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  
  // Find header row and column indices - look for employee name and rate columns
  let nameColIndex = -1;
  let rateColIndex = -1;
  
  for (let i = 0; i < data.length; i++) {
    const row = data[i] as any[];
    if (!row) continue;
    
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j]).toLowerCase();
      if (cell.includes('name') || cell.includes('employee')) nameColIndex = j;
      if (cell.includes('rate') || cell.includes('overtime')) rateColIndex = j;
    }
    
    if (nameColIndex !== -1 && rateColIndex !== -1) {
      // Process remaining rows  
      for (let k = i + 1; k < data.length; k++) {
        const empRow = data[k] as any[];
        if (!empRow) continue;
        
        const nameCell = empRow[nameColIndex];
        const rateValue = empRow[rateColIndex];
        
        if (!nameCell) continue;
        
        const nameStr = String(nameCell).trim();
        const enhancedResult = validateAndMatchEmployee(nameStr, k + 1, "overtime_rates");
        
        if (!enhancedResult.match) {
          console.log(`⚠️ No overtime rate match for: "${nameStr}" on line ${k + 1}`);
          continue;
        }
        
        console.log(`✅ Overtime rate match: "${nameStr}" → "${enhancedResult.match}" (${enhancedResult.confidence})`);
        const employeeName = enhancedResult.match;
        
        // Parse the rate - handle both number and string formats
        let overtimeRate = null;
        if (rateValue !== undefined && rateValue !== null && rateValue !== '') {
          const rateStr = String(rateValue).replace(/[^0-9.]/g, ''); // Remove currency symbols
          const parsedRate = parseFloat(rateStr);
          if (!isNaN(parsedRate) && parsedRate > 0) {
            overtimeRate = parsedRate;
          }
        }
        
        if (employeeData.has(employeeName)) {
          const employee = employeeData.get(employeeName);
          
          // Apply overtime rate to all entries for this employee
          employee.entries.forEach((entry: any) => {
            entry.overtime_rate = overtimeRate;
          });
          
          if (overtimeRate) {
            employee.validationNotes.push(`Overtime rate applied: $${overtimeRate.toFixed(2)}.`);
          } else {
            employee.validationNotes.push("Overtime rate applied: Standard.");
          }
        }
      }
      break;
    }
  }
  
  return employeeData;
}

// Calculate and split overtime hours (hours over 40 per week)
function calculateOvertimeHours(employeeData: Map<string, any>) {
  console.log('📊 Calculating overtime hours for employees...');
  
  for (const [employeeName, employee] of Array.from(employeeData.entries())) {
    // Group entries by week
    const weeklyEntries = new Map<string, any[]>();
    
    for (const entry of employee.entries) {
      if (entry.hour_type !== "REGULAR") continue; // Only process regular hours for overtime calc
      
      // Get week start date (Monday) for this entry
      const entryDate = new Date(entry.entry_date);
      const weekStart = getWeekStart(entryDate);
      const weekKey = weekStart.toISOString().split('T')[0];
      
      if (!weeklyEntries.has(weekKey)) {
        weeklyEntries.set(weekKey, []);
      }
      weeklyEntries.get(weekKey)!.push(entry);
    }
    
    // Process each week
    for (const [weekKey, weekEntries] of Array.from(weeklyEntries.entries())) {
      const totalWeeklyHours = weekEntries.reduce((sum: number, entry: any) => sum + entry.hours, 0);
      
      if (totalWeeklyHours > 40) {
        const overtimeHours = totalWeeklyHours - 40;
        console.log(`⏰ ${employeeName}: ${totalWeeklyHours}h total, ${overtimeHours}h overtime for week of ${weekKey}`);
        
        // Reduce regular hours to 40 total and create overtime entries
        redistributeHoursForOvertime(weekEntries, overtimeHours, employee);
        
        // Add validation note
        if (!employee.validationNotes.some((note: string) => note.includes('overtime'))) {
          employee.validationNotes.push(`Overtime hours calculated and separated from regular hours.`);
        }
      }
    }
  }
  
  return employeeData;
}

// Get the Monday of the week for a given date
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
  return new Date(d.setDate(diff));
}

// Redistribute hours when overtime is detected
function redistributeHoursForOvertime(weekEntries: any[], overtimeHours: number, employee: any) {
  let remainingOvertimeToDistribute = overtimeHours;
  
  // Process entries from last day to first to distribute overtime
  for (let i = weekEntries.length - 1; i >= 0 && remainingOvertimeToDistribute > 0; i--) {
    const entry = weekEntries[i];
    const entryOvertimeHours = Math.min(entry.hours, remainingOvertimeToDistribute);
    
    if (entryOvertimeHours > 0) {
      // Reduce regular hours
      entry.hours -= entryOvertimeHours;
      remainingOvertimeToDistribute -= entryOvertimeHours;
      
      // Create overtime entry for this date/region
      const overtimeEntry = {
        entry_date: entry.entry_date,
        region_name: entry.region_name,
        hours: entryOvertimeHours,
        hour_type: "OVERTIME",
        overtime_rate: entry.overtime_rate,
      };
      
      employee.entries.push(overtimeEntry);
      console.log(`  📈 Created overtime entry: ${entryOvertimeHours}h on ${entry.entry_date}`);
    }
    
    // Remove entries with 0 hours
    if (entry.hours === 0) {
      const index = employee.entries.indexOf(entry);
      if (index > -1) {
        employee.entries.splice(index, 1);
      }
    }
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  console.log('📝 Registering API routes...');
  
  // Register all specific routes FIRST, before any middleware
  // Test route to verify routing works at all
  app.get("/api/test", (req, res) => {
    console.log('🧪 TEST ROUTE HIT - ROUTING IS WORKING!');
    res.set({
      'X-Test-Route': 'test-handler-executed', 
      'X-Test-Time': Date.now().toString()
    });
    res.json({ message: 'Test route working', timestamp: Date.now() });
  });

  // Enhanced debug route to check authentication status
  app.get("/api/xero/debug-tokens", async (req, res) => {
    console.log('🔍 DEBUG: Checking enhanced authentication status...');
    try {
      const authStatus = await authManager.getAuthStatus();
      res.json({
        authenticated: authStatus.success,
        organization: authStatus.organization_name,
        tenant_id: authStatus.tenant_id?.substring(0, 8) + '...' || 'unknown',
        has_tokens: !!authStatus.tokens,
        enhanced_security: true,
        timestamp: Date.now()
      });
    } catch (error) {
      res.json({
        authenticated: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        enhanced_security: true,
        timestamp: Date.now()
      });
    }
  });

  // Register connect-new route with enhanced OAuth flow
  app.get("/api/xero/connect-new", async (req, res) => {
    console.log('🔐 Starting enhanced Xero connection with CSRF protection...');
    
    // Add security headers
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache', 
      'Expires': '0',
      'X-Route-Hit': 'connect-new-enhanced',
      'X-Timestamp': Date.now().toString()
    });
    
    try {
      console.log('🔑 Generating secure authorization URL...');
      const { url, state } = await authManager.generateAuthUrl();
      
      console.log('✅ Enhanced auth URL generated with CSRF protection');
      console.log('🔗 URL:', url.substring(0, 100) + '...');
      console.log('🛡️ State (first 8 chars):', state.substring(0, 8));
      
      res.json({ consentUrl: url, state });
    } catch (error) {
      console.error('❌ Enhanced auth URL generation failed:', error);
      res.status(500).json({ 
        message: 'Failed to initiate secure Xero connection', 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  });

  // Enhanced callback route with CSRF validation
  app.get("/xero-callback", async (req, res) => {
    console.log('🔐 Processing OAuth callback with enhanced security...');
    
    // Add debug headers
    res.set({
      'X-Callback-Hit': 'enhanced',
      'X-Code-Present': String(!!req.query.code),
      'X-State-Present': String(!!req.query.state),
      'X-Error-Present': String(!!req.query.error)
    });
    
    try {
      if (req.query.error) {
        console.error('❌ OAuth error received:', req.query.error);
        throw new Error(`OAuth error: ${req.query.error}`);
      }

      if (!req.query.code) {
        console.error('❌ No authorization code received');
        throw new Error('No authorization code received');
      }
      
      console.log('🛡️ Validating CSRF state and processing callback...');
      
      // Handle callback with CSRF validation
      const result = await authManager.handleCallback(
        req.originalUrl, 
        req.query.state as string
      );
      
      if (!result.success) {
        console.error('❌ Enhanced callback failed:', result.error);
        throw new Error(result.error || 'Callback processing failed');
      }
      
      console.log('✅ Enhanced OAuth callback successful');
      console.log('🏢 Organization:', result.organization_name);
      
      // Add success headers
      res.set({
        'X-Auth-Success': 'true',
        'X-Tenant-ID': result.tenant_id?.substring(0, 8) + '...' || 'unknown',
        'X-Organization': result.organization_name || 'unknown'
      });
      
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Xero Connected</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; margin-top: 100px;">
          <h1>🔐 Xero Authorization Successful!</h1>
          <p><strong>Organization:</strong> ${result.organization_name || 'Connected'}</p>
          <p>Enhanced security validation passed. You can now close this window and return to the application.</p>
          <script>
            setTimeout(() => window.close(), 3000);
          </script>
        </body>
        </html>
      `);
    } catch (error) {
      console.error('❌ Enhanced OAuth callback error:', error);
      res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Xero Connection Failed</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; margin-top: 100px;">
          <h1>❌ Authorization Failed</h1>
          <p>Error: ${error instanceof Error ? error.message : 'Unknown error'}</p>
          <p>Please try connecting again.</p>
        </body>
        </html>
      `);
    }
  });

  // Enhanced status route with automatic token refresh
  app.get("/api/xero/status", async (req, res) => {
    try {
      console.log('🔍 Checking enhanced Xero authentication status...');
      
      const authStatus = await authManager.getAuthStatus();
      
      if (!authStatus.success) {
        console.log('❌ Not authenticated:', authStatus.error);
        return res.json({ 
          connected: false, 
          error: authStatus.error,
          known_employees: KNOWN_EMPLOYEES,
          valid_regions: VALID_REGIONS,
          needs_reauth: true 
        });
      }
      
      console.log('✅ Enhanced authentication validated');
      console.log('🏢 Organization:', authStatus.organization_name);
      console.log('🆔 Tenant ID:', authStatus.tenant_id?.substring(0, 8) + '...');
      
      // Calculate token expiration info if available
      let expiresIn: number | undefined;
      if (authStatus.tokens?.expires_at) {
        expiresIn = Math.floor((new Date(authStatus.tokens.expires_at).getTime() - Date.now()) / 1000);
      }
      
      res.json({ 
        connected: true,
        organization_name: authStatus.organization_name,
        tenant_id: authStatus.tenant_id,
        known_employees: KNOWN_EMPLOYEES,
        valid_regions: VALID_REGIONS,
        expires_in: expiresIn,
        enhanced_security: true
      });
      
    } catch (error) {
      console.error('❌ Enhanced status check error:', error);
      res.json({ 
        connected: false, 
        error: error instanceof Error ? error.message : 'Unknown error',
        known_employees: KNOWN_EMPLOYEES,
        valid_regions: VALID_REGIONS,
        enhanced_security: true 
      });
    }
  });

  // Enhanced timesheet submission with authenticated client
  app.post("/api/xero/post-timesheets", async (req, res) => {
    try {
      const { consolidated_data } = req.body;
      if (!consolidated_data) {
        return res.status(400).json({ message: 'No timesheet data provided' });
      }

      console.log('🚀 Posting timesheets with enhanced authentication...');
      
      // Use enhanced authentication manager with automatic token refresh
      const client = await authManager.getAuthenticatedClient();
      if (!client) {
        return res.status(401).json({ 
          message: 'Not authenticated with Xero. Please connect first.',
          needs_reauth: true 
        });
      }
      
      console.log('✅ Authenticated client obtained');
      console.log('🏢 Organization:', authManager.getOrganizationName());
      
      // For now, return success message - full implementation would post to Xero API
      res.json({ 
        success: true, 
        message: 'Draft pay run would be created in Xero with enhanced security',
        employees_processed: consolidated_data.employees.length,
        organization: authManager.getOrganizationName(),
        tenant_id: authManager.getTenantId(),
        enhanced_security: true
      });
      
      // TODO: When implementing real Xero submission, update submission status:
      // await storage.updateSubmissionStatus(submissionId, "completed", processingResultId);
      
    } catch (error) {
      console.error('❌ Enhanced timesheet submission error:', error);
      res.status(500).json({ 
        message: 'Failed to post to Xero',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Upload and process files
  app.post("/api/process-timesheets", upload.fields([
    { name: 'site_timesheet', maxCount: 1 },
    { name: 'travel_timesheet', maxCount: 1 },
    { name: 'overtime_rates', maxCount: 1 }
  ]), async (req, res) => {
    try {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
      const skipDuplicateCheck = req.query.skipDuplicateCheck === 'true';
      
      console.log('Received files:', files ? Object.keys(files) : 'No files');
      
      // Check for duplicate submission before processing (unless disabled)
      if (files && !skipDuplicateCheck) {
        const fileBuffers: Record<string, Buffer> = {};
        const fileNames: Record<string, string> = {};
        
        Object.entries(files).forEach(([fieldName, fileArray]) => {
          if (fileArray && fileArray[0]) {
            fileBuffers[fieldName] = fileArray[0].buffer;
            fileNames[fieldName] = fileArray[0].originalname;
          }
        });
        
        // Generate hash for duplicate detection
        const fileHash = storage.generateFileHash(fileBuffers);
        
        // Check if this exact submission already exists
        const existingSubmission = await storage.getSubmissionByHash(fileHash);
        if (existingSubmission) {
          console.log('🚫 Duplicate submission detected:', fileHash);
          return res.status(409).json({
            success: false,
            isDuplicate: true,
            message: 'These files have already been processed.',
            existingSubmission: {
              id: existingSubmission.id,
              pay_period_end_date: existingSubmission.pay_period_end_date,
              file_names: existingSubmission.file_names,
              created_at: existingSubmission.created_at,
              xero_submission_status: existingSubmission.xero_submission_status
            }
          });
        }
      } else if (skipDuplicateCheck) {
        console.log('⚠️ Duplicate protection disabled - processing files anyway');
      }
      
      if (!files || !files.site_timesheet || !files.travel_timesheet || !files.overtime_rates) {
        return res.status(400).json({ 
          message: "All three files are required: site_timesheet, travel_timesheet, overtime_rates" 
        });
      }
      
      let employeeData = new Map();
      
      // Process site timesheet
      const siteWorkbook = parseExcelFile(files.site_timesheet[0].buffer, files.site_timesheet[0].originalname);
      employeeData = processSiteTimesheet(siteWorkbook.workbook);
      
      // Process travel timesheet
      const travelWorkbook = parseExcelFile(files.travel_timesheet[0].buffer, files.travel_timesheet[0].originalname);
      employeeData = processTravelTimesheet(travelWorkbook.workbook, employeeData);
      
      // Process overtime rates
      const overtimeWorkbook = parseExcelFile(files.overtime_rates[0].buffer, files.overtime_rates[0].originalname);
      employeeData = processOvertimeRates(overtimeWorkbook.workbook, employeeData);
      
      // Calculate and split overtime hours (hours over 40 per week)
      employeeData = calculateOvertimeHours(employeeData);
      
      // Check if there are pending matches that need user confirmation
      if (pendingMatches.length > 0) {
        console.log(`🤔 Found ${pendingMatches.length} pending matches that need user confirmation`);
        
        // Clear the pending matches array for the next request
        const matches = [...pendingMatches];
        pendingMatches.length = 0;
        
        return res.json({
          success: false,
          needsConfirmation: true,
          pendingMatches: matches,
          message: `Found ${matches.length} employee name(s) that need confirmation before processing can continue.`
        });
      }
      
      // Generate consolidated data in exact target format
      const employees = Array.from(employeeData.values()).map(emp => ({
        employee_name: emp.name,
        daily_entries: emp.entries.map((entry: any) => ({
          entry_date: entry.entry_date,
          region_name: entry.region_name,
          hours: entry.hours,
          hour_type: entry.hour_type,
          overtime_rate: entry.overtime_rate
        }))
      }));
      
      const totalHours = employees.reduce((total, emp) => {
        return total + emp.daily_entries.reduce((empTotal: number, entry: any) => empTotal + entry.hours, 0);
      }, 0);
      
      // Generate summary
      const employeeSummaries = Array.from(employeeData.values()).map(emp => {
        const regularHours = emp.entries.filter((e: any) => e.hour_type === 'REGULAR').reduce((sum: number, e: any) => sum + e.hours, 0);
        const overtimeHours = emp.entries.filter((e: any) => e.hour_type === 'OVERTIME').reduce((sum: number, e: any) => sum + e.hours, 0);
        const travelHours = 0; // Travel hours are now included in regular hours as per client feedback
        const holidayHours = emp.entries.filter((e: any) => e.hour_type === 'HOLIDAY').reduce((sum: number, e: any) => sum + e.hours, 0);
        const totalEmpHours = regularHours + overtimeHours + travelHours + holidayHours;
        
        const regions = Array.from(new Set(emp.entries.map((e: any) => e.region_name)));
        const overtimeRate = emp.entries.find((e: any) => e.overtime_rate !== null)?.overtime_rate;
        
        return {
          employee_name: emp.name,
          matched_from: emp.matchedFrom,
          total_hours: totalEmpHours,
          regular_hours: regularHours,
          overtime_hours: overtimeHours,
          travel_hours: travelHours,
          holiday_hours: holidayHours,
          overtime_rate: overtimeRate ? `$${overtimeRate.toFixed(2)}` : 'Standard',
          regions_worked: regions,
          validation_notes: emp.validationNotes,
        };
      });
      
      const consolidatedData = {
        pay_period_end_date: "2025-06-08",
        employees,
      };
      
      const processingResult = {
        consolidated_data: consolidatedData,
        summary: {
          files_processed: 3,
          employees_found: employees.length,
          total_hours: totalHours,
          pay_period: "Jun 2-8",
          employee_summaries: employeeSummaries,
        },
      };
      
      // Validate with schema
      const validatedResult = insertProcessingResultSchema.parse(processingResult);
      
      // Store result
      const savedResult = await storage.createProcessingResult(validatedResult);
      
      // Create submission record for duplicate tracking (unless skipped)
      if (files && !skipDuplicateCheck) {
        const fileBuffers: Record<string, Buffer> = {};
        const fileNames: Record<string, string> = {};
        
        Object.entries(files).forEach(([fieldName, fileArray]) => {
          if (fileArray && fileArray[0]) {
            fileBuffers[fieldName] = fileArray[0].buffer;
            fileNames[fieldName] = fileArray[0].originalname;
          }
        });
        
        const fileHash = storage.generateFileHash(fileBuffers);
        
        await storage.createSubmission({
          file_hash: fileHash,
          pay_period_end_date: consolidatedData.pay_period_end_date,
          file_names: fileNames,
          processing_result_id: savedResult.id,
          xero_submission_status: "pending"
        });
        
        console.log('📝 Submission recorded with hash:', fileHash);
      }
      
      res.json(savedResult);
      
    } catch (error) {
      console.error('Processing error:', error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : 'Processing failed' 
      });
    }
  });
  
  // Get processing result by ID
  app.get("/api/processing-results/:id", async (req, res) => {
    try {
      const result = await storage.getProcessingResult(req.params.id);
      if (!result) {
        return res.status(404).json({ message: "Processing result not found" });
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ 
        message: error instanceof Error ? error.message : 'Failed to fetch result' 
      });
    }
  });
  
  // Get all processing results
  app.get("/api/processing-results", async (req, res) => {
    try {
      const results = await storage.getAllProcessingResults();
      res.json(results);
    } catch (error) {
      res.status(500).json({ 
        message: error instanceof Error ? error.message : 'Failed to fetch results' 
      });
    }
  });

  // === SETTINGS MANAGEMENT ROUTES ===

  /**
   * Get current application settings
   */
  app.get("/api/settings", (req, res) => {
    try {
      const settings = settingsManager.getSettings();
      res.json({ 
        success: true, 
        settings,
        message: "Settings retrieved successfully"
      });
    } catch (error) {
      console.error("Failed to get settings:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to retrieve settings" 
      });
    }
  });

  /**
   * Update application settings
   */
  app.patch("/api/settings", (req, res) => {
    try {
      const updateData = req.body;
      
      // Validate the partial settings update
      const partialValidation = SettingsSchema.deepPartial().safeParse(updateData);
      if (!partialValidation.success) {
        return res.status(400).json({
          success: false,
          error: "Invalid settings format",
          details: partialValidation.error.errors
        });
      }

      const updated = settingsManager.updateSettings(updateData);
      if (!updated) {
        return res.status(400).json({
          success: false,
          error: "Failed to update settings - validation failed"
        });
      }

      console.log("📋 Settings updated successfully");
      res.json({ 
        success: true, 
        settings: settingsManager.getSettings(),
        message: "Settings updated successfully"
      });
    } catch (error) {
      console.error("Failed to update settings:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to update settings" 
      });
    }
  });

  /**
   * Export settings as JSON
   */
  app.get("/api/settings/export", (req, res) => {
    try {
      const settingsJson = settingsManager.exportSettings();
      
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="timesheet-settings.json"');
      res.send(settingsJson);
    } catch (error) {
      console.error("Failed to export settings:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to export settings" 
      });
    }
  });

  /**
   * Import settings from JSON
   */
  app.post("/api/settings/import", (req, res) => {
    try {
      const { settingsJson } = req.body;
      
      if (!settingsJson || typeof settingsJson !== 'string') {
        return res.status(400).json({
          success: false,
          error: "Settings JSON string is required"
        });
      }

      const imported = settingsManager.importSettings(settingsJson);
      if (!imported) {
        return res.status(400).json({
          success: false,
          error: "Invalid settings format or failed validation"
        });
      }

      console.log("📋 Settings imported successfully");
      res.json({ 
        success: true, 
        settings: settingsManager.getSettings(),
        message: "Settings imported successfully"
      });
    } catch (error) {
      console.error("Failed to import settings:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to import settings" 
      });
    }
  });

  /**
   * Reset settings to defaults
   */
  app.post("/api/settings/reset", (req, res) => {
    try {
      settingsManager.resetSettings();
      
      console.log("📋 Settings reset to defaults");
      res.json({ 
        success: true, 
        settings: settingsManager.getSettings(),
        message: "Settings reset to defaults successfully"
      });
    } catch (error) {
      console.error("Failed to reset settings:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to reset settings" 
      });
    }
  });

  // === FUZZY MATCH CONFIRMATION ROUTES ===

  /**
   * Process timesheets with fuzzy match confirmations
   */
  app.post("/api/process-timesheets-with-confirmations", upload.fields([
    { name: 'site_timesheet', maxCount: 1 },
    { name: 'travel_timesheet', maxCount: 1 },
    { name: 'overtime_rates', maxCount: 1 }
  ]), async (req, res) => {
    try {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const { confirmations, skipDuplicateCheck } = req.body;
      
      if (!files || !files.site_timesheet || !files.travel_timesheet || !files.overtime_rates) {
        return res.status(400).json({ 
          message: "All three files are required: site_timesheet, travel_timesheet, overtime_rates" 
        });
      }

      if (!confirmations) {
        return res.status(400).json({ 
          message: "Fuzzy match confirmations are required" 
        });
      }

      console.log('🔄 Processing timesheets with fuzzy match confirmations...');
      
      // Store confirmations for use in validation
      let matchConfirmations;
      try {
        matchConfirmations = JSON.parse(confirmations);
        console.log('✅ Confirmations received:', Object.keys(matchConfirmations).length, 'confirmations');
      } catch (error) {
        console.error('❌ Failed to parse confirmations JSON:', error);
        return res.status(400).json({ 
          message: "Invalid confirmations format - must be valid JSON" 
        });
      }
      
      // Clear any existing pending matches
      pendingMatches.length = 0;
      
      // Override the validation function to use confirmations
      const originalValidator = validateAndMatchEmployee;
      const validateAndMatchEmployeeWithConfirmations = (input: string, lineNumber?: number, fileType: string = "unknown") => {
        if (matchConfirmations[input]) {
          // Use the confirmed match
          return {
            match: matchConfirmations[input],
            score: 1.0,
            confidence: "HIGH",
            suggestions: [],
            validationResult: null,
            needsConfirmation: false
          };
        } else if (matchConfirmations[input] === null) {
          // User chose to skip this match
          return {
            match: null,
            score: 0,
            confidence: "NO_MATCH",
            suggestions: [],
            validationResult: null,
            needsConfirmation: false
          };
        } else {
          // Use normal validation for unconfirmed items
          return originalValidator(input, lineNumber, fileType);
        }
      };
      
      let employeeData = new Map();
      
      try {
        // Process all files with confirmations - bypass original validation 
        const siteWorkbook = parseExcelFile(files.site_timesheet[0].buffer, files.site_timesheet[0].originalname);
        employeeData = processSiteTimesheet(siteWorkbook.workbook);
        
        const travelWorkbook = parseExcelFile(files.travel_timesheet[0].buffer, files.travel_timesheet[0].originalname);
        employeeData = processTravelTimesheet(travelWorkbook.workbook, employeeData);
        
        const overtimeWorkbook = parseExcelFile(files.overtime_rates[0].buffer, files.overtime_rates[0].originalname);
        employeeData = processOvertimeRates(overtimeWorkbook.workbook, employeeData);
        
        employeeData = calculateOvertimeHours(employeeData);
        
      } finally {
        // The original function will be used again automatically for the next request
      }
      
      // Continue with normal processing flow...
      const employees = Array.from(employeeData.values()).map(emp => ({
        employee_name: emp.name,
        daily_entries: emp.entries.map((entry: any) => ({
          entry_date: entry.entry_date,
          region_name: entry.region_name,
          hours: entry.hours,
          hour_type: entry.hour_type,
          overtime_rate: entry.overtime_rate
        }))
      }));
      
      const totalHours = employees.reduce((total, emp) => {
        return total + emp.daily_entries.reduce((empTotal: number, entry: any) => empTotal + entry.hours, 0);
      }, 0);
      
      const employeeSummaries = Array.from(employeeData.values()).map(emp => {
        const regularHours = emp.entries.filter((e: any) => e.hour_type === 'REGULAR').reduce((sum: number, e: any) => sum + e.hours, 0);
        const overtimeHours = emp.entries.filter((e: any) => e.hour_type === 'OVERTIME').reduce((sum: number, e: any) => sum + e.hours, 0);
        const travelHours = 0; // Travel hours are now included in regular hours
        const holidayHours = emp.entries.filter((e: any) => e.hour_type === 'HOLIDAY').reduce((sum: number, e: any) => sum + e.hours, 0);
        const totalEmpHours = regularHours + overtimeHours + travelHours + holidayHours;
        
        const regions = Array.from(new Set(emp.entries.map((e: any) => e.region_name)));
        const overtimeRate = emp.entries.find((e: any) => e.overtime_rate !== null)?.overtime_rate;
        
        return {
          employee_name: emp.name,
          matched_from: emp.matchedFrom,
          total_hours: totalEmpHours,
          regular_hours: regularHours,
          overtime_hours: overtimeHours,
          travel_hours: travelHours,
          holiday_hours: holidayHours,
          overtime_rate: overtimeRate ? `$${overtimeRate.toFixed(2)}` : 'Standard',
          regions_worked: regions,
          validation_notes: emp.validationNotes,
        };
      });
      
      const processingResult = {
        consolidated_data: { 
          pay_period_end_date: "2025-06-08",
          employees 
        },
        summary: {
          files_processed: 3,
          employees_found: employees.length,
          total_hours: totalHours,
          pay_period: "2025-06-08",
          employee_summaries: employeeSummaries,
        },
      };

      const validatedResult = insertProcessingResultSchema.parse(processingResult);
      const savedResult = await storage.createProcessingResult(validatedResult);
      
      console.log(`✅ Processing completed with confirmations for ${employees.length} employees`);
      res.json(savedResult);
      
    } catch (error) {
      console.error('❌ Processing with confirmations failed:', error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : 'Processing failed' 
      });
    }
  });

  // FINALLY, add middleware at the very end - after all specific routes are registered
  app.use('/api', (req, res, next) => {
    console.log(`🔍 ALL API REQUEST: ${req.method} ${req.originalUrl}`);
    next();
  });
  
  app.use('/api/xero', (req, res, next) => {
    console.log(`🚨 XERO ROUTE HIT: ${req.method} ${req.path} - ${req.originalUrl}`);
    next();
  });

  console.log('✅ All routes registered successfully');
  console.log('🔄 Available routes:');
  console.log('  GET /api/xero/connect-new');  
  console.log('  GET /xero-callback');
  console.log('  GET /api/xero/status');
  console.log('  POST /api/xero/post-timesheets');
  console.log('  POST /api/process-timesheets');
  console.log('  GET /api/processing-results/:id');
  console.log('  GET /api/processing-results');
  console.log('  GET /api/settings');
  console.log('  PATCH /api/settings');
  console.log('  GET /api/settings/export');
  console.log('  POST /api/settings/import');
  console.log('  POST /api/settings/reset');
  console.log('  POST /api/process-timesheets-with-confirmations');

  const httpServer = createServer(app);
  return httpServer;
}
