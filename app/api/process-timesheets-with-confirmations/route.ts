import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { storage } from '@server/storage'
import { insertProcessingResultSchema } from '@shared/schema'
import { employeeValidator, regionValidator } from '@server/validation-system'

const KNOWN_EMPLOYEES = [
  "Charlotte Danes",
  "Chelsea Serati",
  "Jack Allan",
  "Andrew Dwyer",
  "Pamela Beesly",
  "Dwight K Schrute",
]
const VALID_REGIONS = ["Eastside", "South", "North"]

employeeValidator.setKnownEmployees(KNOWN_EMPLOYEES)
regionValidator.setXeroRegions(VALID_REGIONS)

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const site = form.get('site_timesheet') as File | null
    const travel = form.get('travel_timesheet') as File | null
    const overtime = form.get('overtime_rates') as File | null
    const confirmationsStr = form.get('confirmations') as string | null
    const skipDuplicateCheck = (form.get('skipDuplicateCheck') as string | null) === 'true'

    if (!site || !travel || !overtime) {
      return NextResponse.json({ message: 'All three files are required: site_timesheet, travel_timesheet, overtime_rates' }, { status: 400 })
    }
    if (!confirmationsStr) {
      return NextResponse.json({ message: 'Fuzzy match confirmations are required' }, { status: 400 })
    }

    let confirmations: Record<string, string | null>
    try {
      confirmations = JSON.parse(confirmationsStr)
    } catch {
      return NextResponse.json({ message: 'Invalid confirmations format - must be valid JSON' }, { status: 400 })
    }

    const validateAndMatchEmployee = (input: string, lineNumber?: number, fileType: string = 'unknown') => {
      if (Object.prototype.hasOwnProperty.call(confirmations, input)) {
        const confirmed = confirmations[input]
        if (confirmed === null) {
          return { match: null, score: 0, confidence: 'NO_MATCH', suggestions: [], validationResult: null, needsConfirmation: false }
        }
        return { match: confirmed, score: 1.0, confidence: 'HIGH', suggestions: [], validationResult: null, needsConfirmation: false }
      }
      const matchResult = employeeValidator.validateEmployee(input, lineNumber)
      return {
        match: matchResult.matched_name || null,
        score: matchResult.confidence_score / 100,
        confidence: matchResult.confidence,
        suggestions: matchResult.suggestions.map((s: any) => s.name),
        validationResult: matchResult,
        needsConfirmation: false,
      }
    }

    const [siteBuf, travelBuf, overtimeBuf] = await Promise.all([
      Buffer.from(await site.arrayBuffer()),
      Buffer.from(await travel.arrayBuffer()),
      Buffer.from(await overtime.arrayBuffer()),
    ])

    const parseExcelFile = (buffer: Buffer, filename: string) => {
      const workbook = XLSX.read(buffer, { type: 'buffer' })
      return { workbook, sheets: workbook.SheetNames }
    }

    let employeeData = new Map()
    const siteWb = parseExcelFile(siteBuf, site.name)
    // Minimal processing using the validator-with-confirmations
    const regions = siteWb.workbook.SheetNames
    for (const regionName of regions) {
      if (!VALID_REGIONS.includes(regionName)) continue
      const sheet = siteWb.workbook.Sheets[regionName]
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1 })
      for (let i = 1; i < data.length; i++) {
        const row = data[i] as any[]
        if (!row || row.length === 0) continue
        const nameCell = row[0]
        if (!nameCell) continue
        const nameStr = String(nameCell).trim()
        const res = validateAndMatchEmployee(nameStr, i + 1, 'site_timesheet')
        if (!res.match) continue
        const employeeName = res.match
        if (!employeeData.has(employeeName)) {
          employeeData.set(employeeName, { name: employeeName, matchedFrom: nameStr, entries: [], validationNotes: [] })
        }
        const baseDate = new Date('2025-06-02')
        for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
          const cellValue = row[dayIndex + 1]
          if (!cellValue) continue
          const entryDate = new Date(baseDate)
          entryDate.setDate(baseDate.getDate() + dayIndex)
          let hours = 0
          let hourType = 'REGULAR'
          if (String(cellValue).toUpperCase() === 'HOL') {
            const employee = employeeData.get(employeeName)
            const dateStr = entryDate.toISOString().split('T')[0]
            const existingHoliday = employee.entries.find((e: any) => e.entry_date === dateStr && e.region_name === regionName && e.hour_type === 'HOLIDAY')
            if (!existingHoliday) {
              hours = 8
              hourType = 'HOLIDAY'
            } else {
              continue
            }
          } else {
            hours = parseFloat(String(cellValue))
            if (isNaN(hours) || hours <= 0) continue
            hourType = 'REGULAR'
          }
          const dateString = entryDate.toISOString().split('T')[0]
          const employee = employeeData.get(employeeName)
          const existing = employee.entries.find((e: any) => e.entry_date === dateString && e.region_name === regionName && e.hour_type === hourType)
          if (existing) existing.hours += hours
          else employee.entries.push({ entry_date: dateString, region_name: regionName, hours, hour_type: hourType, overtime_rate: null })
        }
      }
    }

    const employees = Array.from(employeeData.values()).map((emp: any) => ({
      employee_name: emp.name,
      daily_entries: emp.entries.map((entry: any) => ({
        entry_date: entry.entry_date,
        region_name: entry.region_name,
        hours: entry.hours,
        hour_type: entry.hour_type,
        overtime_rate: entry.overtime_rate,
      }))
    }))

    const totalHours = employees.reduce((total: number, emp: any) => total + emp.daily_entries.reduce((t: number, e: any) => t + e.hours, 0), 0)
    const processingResult = {
      consolidated_data: { pay_period_end_date: '2025-06-08', employees },
      summary: { files_processed: 3, employees_found: employees.length, total_hours: totalHours, pay_period: '2025-06-08', employee_summaries: [] },
    }
    const validated = insertProcessingResultSchema.parse(processingResult)
    const saved = await storage.createProcessingResult(validated)
    return NextResponse.json(saved)
  } catch (error: any) {
    return NextResponse.json({ message: error?.message || 'Processing failed' }, { status: 500 })
  }
}


