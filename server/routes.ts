import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertProcessingResultSchema } from "@shared/schema";
import multer from "multer";
import * as XLSX from "xlsx";
import { XeroClient } from "xero-node";

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

// Known validation data (as specified in requirements)
const KNOWN_EMPLOYEES = ["Charlotte Danes", "Chelsea Serati", "Jack Allan"];
const VALID_REGIONS = ["Eastside", "South", "North"];

// Initialize Xero client
const xero = new XeroClient({
  clientId: process.env.XERO_CLIENT_ID!,
  clientSecret: process.env.XERO_CLIENT_SECRET!,
  redirectUris: [process.env.XERO_REDIRECT_URI!],
  scopes: 'offline_access payroll.employees.read payroll.timesheets'.split(' ')
});

// Simple token storage (in production, use a database)
let xeroTokens: any = null;

// Fuzzy matching function
function fuzzyMatch(input: string, candidates: string[]): { match: string | null; score: number } {
  input = input.toLowerCase().trim();
  let bestMatch = null;
  let bestScore = 0;
  
  for (const candidate of candidates) {
    const candidateLower = candidate.toLowerCase();
    
    // Exact match
    if (input === candidateLower) {
      return { match: candidate, score: 1.0 };
    }
    
    // Check if input contains parts of candidate name
    const candidateParts = candidateLower.split(' ');
    let matchedParts = 0;
    
    for (const part of candidateParts) {
      if (input.includes(part) || part.includes(input)) {
        matchedParts++;
      }
    }
    
    const score = matchedParts / candidateParts.length;
    if (score > bestScore && score > 0.5) { // Minimum 50% match
      bestMatch = candidate;
      bestScore = score;
    }
  }
  
  return { match: bestMatch, score: bestScore };
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
      const fuzzyResult = fuzzyMatch(nameStr, KNOWN_EMPLOYEES);
      
      if (!fuzzyResult.match) continue;
      
      const employeeName = fuzzyResult.match;
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
          if (hours > 8) {
            // Split into regular and overtime
            employeeData.get(employeeName).entries.push({
              entry_date: entryDate.toISOString().split('T')[0],
              region_name: regionName,
              hours: 8,
              hour_type: "REGULAR",
              overtime_rate: null,
            });
            
            employeeData.get(employeeName).entries.push({
              entry_date: entryDate.toISOString().split('T')[0],
              region_name: regionName,
              hours: hours - 8,
              hour_type: "OVERTIME",
              overtime_rate: null,
            });
            continue;
          }
        }
        
        if (hours > 0) {
          employeeData.get(employeeName).entries.push({
            entry_date: entryDate.toISOString().split('T')[0],
            region_name: regionName,
            hours,
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
  
  // Process travel data
  for (let i = 1; i < data.length; i++) {
    const row = data[i] as any[];
    if (!row || row.length === 0) continue;
    
    const nameCell = row[0];
    const travelHours = parseFloat(String(row[1])) || 0;
    
    if (!nameCell || travelHours === 0) continue;
    
    const nameStr = String(nameCell).trim();
    const fuzzyResult = fuzzyMatch(nameStr, KNOWN_EMPLOYEES);
    
    if (!fuzzyResult.match) continue;
    
    const employeeName = fuzzyResult.match;
    if (!employeeData.has(employeeName)) {
      employeeData.set(employeeName, {
        name: employeeName,
        matchedFrom: nameStr,
        entries: [],
        validationNotes: [`Successfully matched "${nameStr}" from timesheet.`],
      });
    }
    
    // Distribute travel hours across working days (5 days)
    const workingDays = 5;
    const hoursPerDay = travelHours / workingDays;
    const baseDate = new Date('2025-06-02'); // Monday
    
    for (let dayIndex = 0; dayIndex < workingDays; dayIndex++) {
      const entryDate = new Date(baseDate);
      entryDate.setDate(baseDate.getDate() + dayIndex);
      
      employeeData.get(employeeName).entries.push({
        entry_date: entryDate.toISOString().split('T')[0],
        region_name: "Eastside", // Default region for travel
        hours: hoursPerDay,
        hour_type: "TRAVEL",
        overtime_rate: null,
      });
    }
  }
  
  return employeeData;
}

// Process overtime rates
function processOvertimeRates(workbook: XLSX.WorkBook, employeeData: Map<string, any>) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  
  // Find header row and column indices
  let nameColIndex = -1;
  let differentRateColIndex = -1;
  let hourlyRateColIndex = -1;
  
  for (let i = 0; i < data.length; i++) {
    const row = data[i] as any[];
    if (!row) continue;
    
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j]).toLowerCase();
      if (cell.includes('name')) nameColIndex = j;
      if (cell.includes('different rate')) differentRateColIndex = j;
      if (cell.includes('hourly rate')) hourlyRateColIndex = j;
    }
    
    if (nameColIndex !== -1 && differentRateColIndex !== -1 && hourlyRateColIndex !== -1) {
      // Process remaining rows
      for (let k = i + 1; k < data.length; k++) {
        const empRow = data[k] as any[];
        if (!empRow) continue;
        
        const nameCell = empRow[nameColIndex];
        const differentRate = String(empRow[differentRateColIndex]).toLowerCase();
        const hourlyRate = parseFloat(String(empRow[hourlyRateColIndex])) || null;
        
        if (!nameCell) continue;
        
        const nameStr = String(nameCell).trim();
        const fuzzyResult = fuzzyMatch(nameStr, KNOWN_EMPLOYEES);
        
        if (!fuzzyResult.match) continue;
        
        const employeeName = fuzzyResult.match;
        if (employeeData.has(employeeName)) {
          const employee = employeeData.get(employeeName);
          
          if (differentRate === 'yes' && hourlyRate) {
            // Apply overtime rate to all entries for this employee
            employee.entries.forEach((entry: any) => {
              entry.overtime_rate = hourlyRate;
            });
            
            employee.validationNotes.push(`Overtime rate applied: $${hourlyRate.toFixed(2)}.`);
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

export async function registerRoutes(app: Express): Promise<Server> {
  console.log('📝 Registering API routes...');
  
  // Debug ALL API requests to find what's happening
  app.use('/api', (req, res, next) => {
    console.log(`🔍 ALL API REQUEST: ${req.method} ${req.originalUrl}`);
    next();
  });
  
  // Add middleware to debug Xero API requests specifically
  app.use('/api/xero', (req, res, next) => {
    console.log(`🚨 XERO ROUTE HIT: ${req.method} ${req.path} - ${req.originalUrl}`);
    next();
  });
  
  // Xero OAuth routes
  app.get("/api/xero/connect", async (req, res) => {
    try {
      console.log('Building Xero consent URL...');
      console.log('Xero config:', {
        clientId: process.env.XERO_CLIENT_ID ? 'Present' : 'Missing',
        clientSecret: process.env.XERO_CLIENT_SECRET ? 'Present' : 'Missing',
        redirectUri: process.env.XERO_REDIRECT_URI
      });
      
      const consentUrl = await xero.buildConsentUrl();
      console.log('Consent URL generated (first 100 chars):', consentUrl.substring(0, 100) + '...');
      console.log('Expected callback URL should be:', process.env.XERO_REDIRECT_URI);
      res.json({ consentUrl });
    } catch (error) {
      console.error('Error building consent URL:', error);
      res.status(500).json({ message: 'Failed to initiate Xero connection', error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });


  app.get("/xero-callback", async (req, res) => {
    try {
      console.log('🎯 CALLBACK HIT! Processing Xero callback...');
      console.log('Full callback URL:', req.originalUrl);
      console.log('Query params:', req.query);
      
      await xero.apiCallback(req.originalUrl);
      xeroTokens = xero.readTokenSet();
      console.log('Xero tokens received and stored:', {
        hasAccessToken: !!xeroTokens?.access_token,
        hasRefreshToken: !!xeroTokens?.refresh_token,
        expiresIn: xeroTokens?.expires_in
      });
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Xero Connected</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; margin-top: 100px;">
          <h1>🔑 Xero Authorization Successful!</h1>
          <p>You can now close this window and return to the application.</p>
          <script>
            setTimeout(() => window.close(), 3000);
          </script>
        </body>
        </html>
      `);
    } catch (error) {
      console.error('OAuth callback error:', error);
      res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Xero Connection Failed</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; margin-top: 100px;">
          <h1>❌ Authorization Failed</h1>
          <p>Please try connecting again.</p>
        </body>
        </html>
      `);
    }
  });

  app.get("/api/xero/status", async (req, res) => {
    try {
      console.log('Checking Xero status...');
      console.log('Tokens available:', xeroTokens ? 'Yes' : 'No');
      
      if (!xeroTokens) {
        console.log('No tokens found');
        return res.json({ connected: false });
      }
      
      // Check if tokens are still valid
      console.log('Setting token set and testing connection...');
      xero.setTokenSet(xeroTokens);
      try {
        await xero.accountingApi.getOrganisations('');
        console.log('Xero API call successful - connected!');
        res.json({ connected: true });
      } catch (validationError) {
        console.error('Token validation failed:', validationError);
        // Tokens might be expired
        xeroTokens = null;
        res.json({ connected: false });
      }
    } catch (error) {
      console.error('Status check error:', error);
      res.json({ connected: false });
    }
  });

  app.post("/api/xero/post-timesheets", async (req, res) => {
    try {
      if (!xeroTokens) {
        return res.status(400).json({ message: 'Not connected to Xero. Please connect first.' });
      }

      const { consolidated_data } = req.body;
      if (!consolidated_data) {
        return res.status(400).json({ message: 'No timesheet data provided' });
      }

      xero.setTokenSet(xeroTokens);
      
      // For now, return success message - full implementation would post to Xero API
      res.json({ 
        success: true, 
        message: 'Draft pay run would be created in Xero',
        employees_processed: consolidated_data.employees.length
      });
      
    } catch (error) {
      console.error('Error posting to Xero:', error);
      res.status(500).json({ message: 'Failed to post to Xero' });
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
      
      console.log('Received files:', files ? Object.keys(files) : 'No files');
      console.log('Request content-type:', req.headers['content-type']);
      
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
      
      // Generate consolidated data
      const employees = Array.from(employeeData.values()).map(emp => ({
        employee_name: emp.name,
        daily_entries: emp.entries,
      }));
      
      const totalHours = employees.reduce((total, emp) => {
        return total + emp.daily_entries.reduce((empTotal: number, entry: any) => empTotal + entry.hours, 0);
      }, 0);
      
      // Generate summary
      const employeeSummaries = Array.from(employeeData.values()).map(emp => {
        const regularHours = emp.entries.filter((e: any) => e.hour_type === 'REGULAR').reduce((sum: number, e: any) => sum + e.hours, 0);
        const overtimeHours = emp.entries.filter((e: any) => e.hour_type === 'OVERTIME').reduce((sum: number, e: any) => sum + e.hours, 0);
        const travelHours = emp.entries.filter((e: any) => e.hour_type === 'TRAVEL').reduce((sum: number, e: any) => sum + e.hours, 0);
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

  console.log('✅ All routes registered successfully');
  console.log('🔄 Available routes:');
  console.log('  GET /api/xero/connect');  
  console.log('  GET /xero-callback');
  console.log('  GET /api/xero/status');
  console.log('  POST /api/xero/post-timesheets');
  console.log('  POST /api/process-timesheets');
  console.log('  GET /api/processing-results/:id');
  console.log('  GET /api/processing-results');

  const httpServer = createServer(app);
  return httpServer;
}
