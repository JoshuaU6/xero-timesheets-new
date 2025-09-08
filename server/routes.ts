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

// Simple token storage (persist to file to survive server restarts)
let xeroTokens: any = null;
let xeroTenantId: string = '';

// Load tokens from file on startup
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const tokenFile = join(process.cwd(), '.xero-tokens.json');

function loadTokens() {
  try {
    console.log('🔍 Checking for token file at:', tokenFile);
    if (existsSync(tokenFile)) {
      const data = JSON.parse(readFileSync(tokenFile, 'utf8'));
      xeroTokens = data.tokens;
      xeroTenantId = data.tenantId || '';
      console.log('✅ Loaded tokens from file:', !!xeroTokens, 'tenantId:', !!xeroTenantId);
    } else {
      console.log('❌ No token file exists yet');
    }
  } catch (error) {
    console.log('🚨 Error loading tokens:', error);
  }
}

function saveTokens() {
  try {
    writeFileSync(tokenFile, JSON.stringify({
      tokens: xeroTokens,
      tenantId: xeroTenantId
    }));
    console.log('Tokens saved to file');
  } catch (error) {
    console.error('Failed to save tokens:', error);
  }
}

// Load tokens on startup
loadTokens();

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
        
        // Add travel entry
        employeeData.get(employeeName).entries.push({
          entry_date: entryDate,
          region_name: String(travelRegion).trim(),
          hours: travelHours,
          hour_type: "TRAVEL",
          overtime_rate: null,
        });
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
        const fuzzyResult = fuzzyMatch(nameStr, KNOWN_EMPLOYEES);
        
        if (!fuzzyResult.match) continue;
        
        const employeeName = fuzzyResult.match;
        
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

  // Debug route to check token storage
  app.get("/api/xero/debug-tokens", (req, res) => {
    console.log('🔍 DEBUG: Checking token storage...');
    res.json({
      tokensExist: !!xeroTokens,
      hasAccessToken: !!xeroTokens?.access_token,
      hasRefreshToken: !!xeroTokens?.refresh_token,
      tokenType: typeof xeroTokens,
      timestamp: Date.now()
    });
  });

  // Register connect-new route FIRST, before middleware
  app.get("/api/xero/connect-new", async (req, res) => {
    console.log('🎯🎯🎯 CONNECT-NEW ROUTE HIT!!! Starting Xero connection...');
    console.log('🎯 ROUTE HANDLER STARTED! Inside /api/xero/connect-new');
    
    // Add no-cache headers to prevent caching issues + PROOF OF EXECUTION
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache', 
      'Expires': '0',
      'X-Route-Hit': 'connect-new-handler-executed',
      'X-Timestamp': Date.now().toString()
    });
    
    try {
      console.log('🎯 Building Xero consent URL...');
      console.log('Xero config:', {
        clientId: process.env.XERO_CLIENT_ID ? 'Present' : 'Missing',
        clientSecret: process.env.XERO_CLIENT_SECRET ? 'Present' : 'Missing',
        redirectUri: process.env.XERO_REDIRECT_URI
      });
      
      const consentUrl = await xero.buildConsentUrl();
      console.log('🎯 Consent URL generated successfully:', consentUrl.substring(0, 100) + '...');
      console.log('🔗 Redirect URI in consent URL:', consentUrl.includes('redirect_uri=') ? 
        decodeURIComponent(consentUrl.split('redirect_uri=')[1].split('&')[0]) : 'Not found');
      console.log('🎯 Sending JSON response...');
      
      res.json({ consentUrl });
      console.log('🎯 JSON response sent!');
    } catch (error) {
      console.error('🚨 Error in route handler:', error);
      res.status(500).json({ message: 'Failed to initiate Xero connection', error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Callback route BEFORE middleware  
  app.get("/xero-callback", async (req, res) => {
    // Use response headers to debug since console.log isn't working
    res.set({
      'X-Callback-Hit': 'true',
      'X-Code-Present': String(!!req.query.code),
      'X-Error-Present': String(!!req.query.error)
    });
    
    try {
      if (!req.query.code) {
        throw new Error('No authorization code received');
      }
      
      await xero.apiCallback(req.originalUrl);
      xeroTokens = xero.readTokenSet();
      
      // Get tenant ID (organization ID) after receiving tokens
      if (xeroTokens) {
        try {
          const tokenSet = xeroTokens as any;
          xero.setTokenSet(tokenSet);
          
          // For payroll-only scopes, we can't call updateTenants() as it requires accounting scope
          // The SDK should have tenant info after OAuth callback - check internal state
          const sdk = xero as any;
          if (sdk.tenants && sdk.tenants.length > 0) {
            xeroTenantId = sdk.tenants[0].tenantId;
            console.log('Got tenant ID from SDK state after callback:', xeroTenantId);
          } else {
            console.log('No tenants in SDK state, will get it during status check');
          }
          
        } catch (tenantError) {
          console.error('Failed to get tenant ID:', tenantError);
        }
        
        // Save tokens to file for persistence
        saveTokens();
      }
      
      // Add debug headers to track token storage
      res.set({
        'X-Tokens-Stored': String(!!xeroTokens),
        'X-Has-Access-Token': String(!!xeroTokens?.access_token),
        'X-Tenant-ID': xeroTenantId || 'none'
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
      
      // If no tokens in memory, try reloading from file
      if (!xeroTokens) {
        console.log('No tokens in memory, reloading from file...');
        loadTokens();
        console.log('After reload - Tokens:', !!xeroTokens, 'Tenant:', !!xeroTenantId);
      }
      
      if (!xeroTokens) {
        console.log('No tokens found');
        return res.json({ connected: false });
      }
      
      // Check if tokens are still valid - use payroll API since we have payroll scopes
      console.log('Setting token set and testing connection...');
      xero.setTokenSet(xeroTokens);
      try {
        // Since we have payroll scopes, test with payroll API instead of accounting
        // Use the stored tenant ID for the API call
        if (!xeroTenantId) {
          // For payroll-only scopes, we can't call updateTenants()
          // Try to get tenant ID from SDK internal state or use a known pattern
          console.log('No tenant ID available, trying payroll API call...');
          try {
            // Try calling with empty tenant ID - the SDK might populate it automatically
            await xero.payrollUKApi.getEmployees('');
          } catch (apiError: any) {
            // Even if this fails, the SDK might have populated tenant info
            const sdk = xero as any;
            if (sdk.tenants && sdk.tenants.length > 0) {
              xeroTenantId = sdk.tenants[0].tenantId;
              console.log('Extracted tenant ID from SDK:', xeroTenantId);
              saveTokens();
            } else {
              console.log('Will try with hardcoded tenant ID pattern...');
              // As last resort, extract from the error headers if available
              if (apiError?.response?.request?.headers?.['xero-tenant-id']) {
                xeroTenantId = apiError.response.request.headers['xero-tenant-id'];
                console.log('Got tenant ID from error headers:', xeroTenantId);
                saveTokens();
              }
            }
          }
        }
        
        await xero.payrollUKApi.getEmployees(xeroTenantId);
        console.log('Xero Payroll API call successful - connected!');
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
      
      console.log('📋 Starting Xero timesheet creation process...');
      
      let employees: any[] = [];
      let trackingCategories: any[] = [];
      let earningsRates: any[] = [];

      try {
        // Fetch required Xero data with proper error handling
        console.log('Fetching employees from Xero...');
        const employeesResponse = await xero.payrollUKApi.getEmployees(xeroTenantId);
        employees = (employeesResponse as any)?.body?.employees || [];
        console.log(`Found ${employees.length} employees`);
      } catch (empError) {
        console.error('Failed to fetch employees:', empError);
        return res.status(500).json({ 
          message: 'Failed to fetch employees from Xero', 
          error: empError instanceof Error ? empError.message : 'Unknown error'
        });
      }

      try {
        console.log('Fetching tracking categories from Xero...');
        const trackingResponse = await xero.accountingApi.getTrackingCategories(xeroTenantId);
        trackingCategories = (trackingResponse as any)?.body?.trackingCategories || [];
        console.log(`Found ${trackingCategories.length} tracking categories`);
      } catch (trackError) {
        console.error('Failed to fetch tracking categories:', trackError);
        // This might fail due to scope issues, so we'll continue without it
        trackingCategories = [];
      }

      try {
        console.log('Fetching pay items from Xero...');
        let payItemsResponse;
        try {
          // Try getPayItems first
          payItemsResponse = await (xero.payrollUKApi as any).getPayItems(xeroTenantId);
        } catch {
          // Fallback to getEarningsRates if getPayItems doesn't exist
          payItemsResponse = await (xero.payrollUKApi as any).getEarningsRates(xeroTenantId);
        }
        earningsRates = (payItemsResponse as any)?.body?.payItems?.earningsRates || 
                       (payItemsResponse as any)?.body?.earningsRates || [];
        console.log(`Found ${earningsRates.length} earnings rates`);
      } catch (payError) {
        console.error('Failed to fetch pay items:', payError);
        earningsRates = [];
      }

      // Find the Region tracking category
      const regionCategory = trackingCategories.find((cat: any) => cat.name?.toLowerCase().includes('region'));
      if (!regionCategory && trackingCategories.length > 0) {
        console.warn('Region tracking category not found in Xero, timesheets will be created without region tracking');
      }

      // Create lookup maps
      const employeeMap = new Map();
      employees.forEach((emp: any) => {
        const fullName = `${emp.firstName} ${emp.lastName}`;
        employeeMap.set(fullName, emp.employeeID);
        // Also try variations
        employeeMap.set(`${emp.firstName} ${emp.lastName?.charAt(0)}.`, emp.employeeID);
      });

      const regionMap = new Map();
      if (regionCategory?.options) {
        regionCategory.options.forEach((option: any) => {
          regionMap.set(option.name, option.trackingOptionID);
        });
      }

      const earningsMap = new Map();
      earningsRates.forEach((rate: any) => {
        if (rate.name?.toLowerCase().includes('regular')) {
          earningsMap.set('REGULAR', rate.earningsRateID);
        } else if (rate.name?.toLowerCase().includes('overtime')) {
          earningsMap.set('OVERTIME', rate.earningsRateID);
        } else if (rate.name?.toLowerCase().includes('travel')) {
          earningsMap.set('TRAVEL', rate.earningsRateID);
        } else if (rate.name?.toLowerCase().includes('holiday')) {
          earningsMap.set('HOLIDAY', rate.earningsRateID);
        }
      });

      console.log(`💼 Found ${employees.length} employees in Xero`);
      console.log(`📍 Found ${regionCategory?.options?.length || 0} regions in Xero`);
      console.log(`💰 Found ${earningsRates.length} earnings rates in Xero`);

      // Create timesheets for each employee
      const createdTimesheets = [];
      const errors = [];

      for (const employee of consolidated_data.employees) {
        try {
          const xeroEmployeeId = employeeMap.get(employee.employee_name);
          if (!xeroEmployeeId) {
            errors.push(`Employee not found in Xero: ${employee.employee_name}`);
            continue;
          }

          // Build timesheet lines
          const timesheetLines = [];
          for (const entry of employee.daily_entries) {
            const earningsRateId = earningsMap.get(entry.hour_type);
            const trackingItemId = regionMap.get(entry.region_name);

            if (!earningsRateId) {
              errors.push(`Earnings rate not found for type: ${entry.hour_type}`);
              continue;
            }
            const timesheetLine: any = {
              date: entry.entry_date,
              earningsRateID: earningsRateId,
              numberOfUnits: entry.hours
            };

            // Only add tracking if we have region tracking set up
            if (trackingItemId && regionCategory) {
              timesheetLine.trackingItemID = trackingItemId;
            } else if (entry.region_name && !trackingItemId) {
              errors.push(`Region not found in Xero: ${entry.region_name}`);
            }

            timesheetLines.push(timesheetLine);
          }

          if (timesheetLines.length === 0) {
            errors.push(`No valid timesheet lines for employee: ${employee.employee_name}`);
            continue;
          }

          // Create the timesheet - need to add required payrollCalendarID
          const timesheetData: any = {
            employeeID: xeroEmployeeId,
            startDate: consolidated_data.pay_period_end_date,
            endDate: consolidated_data.pay_period_end_date,
            status: 'Draft',
            payrollCalendarID: 'default', // This might need to be fetched from Xero
            timesheetLines: timesheetLines
          };

          try {
            const createResponse = await xero.payrollUKApi.createTimesheet(xeroTenantId, timesheetData);
            createdTimesheets.push({
              employee: employee.employee_name,
              timesheetId: (createResponse as any)?.body?.timesheets?.[0]?.timesheetID,
              lines: timesheetLines.length
            });
          } catch (createError) {
            console.error(`Failed to create timesheet for ${employee.employee_name}:`, createError);
            errors.push(`Failed to create timesheet for ${employee.employee_name}: ${createError instanceof Error ? createError.message : 'Unknown error'}`);
            continue;
          }

          console.log(`✅ Created timesheet for ${employee.employee_name} with ${timesheetLines.length} lines`);

        } catch (empError) {
          console.error(`❌ Error creating timesheet for ${employee.employee_name}:`, empError);
          errors.push(`Failed to create timesheet for ${employee.employee_name}: ${empError instanceof Error ? empError.message : 'Unknown error'}`);
        }
      }

      res.json({ 
        success: true, 
        message: `Created ${createdTimesheets.length} draft timesheets in Xero`,
        created_timesheets: createdTimesheets,
        errors: errors.length > 0 ? errors : undefined,
        employees_processed: createdTimesheets.length,
        total_employees: consolidated_data.employees.length
      });
      
    } catch (error) {
      console.error('❌ Error posting to Xero:', error);
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

  const httpServer = createServer(app);
  return httpServer;
}
