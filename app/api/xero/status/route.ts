import { NextResponse } from 'next/server'
import { authManager } from '@server/auth-manager'

const KNOWN_EMPLOYEES = [
  "Charlotte Danes",
  "Chelsea Serati",
  "Jack Allan",
  "Andrew Dwyer",
  "Pamela Beesly",
  "Dwight K Schrute",
]
const VALID_REGIONS = ["Eastside", "South", "North"]

export async function GET() {
  try {
    const authStatus = await authManager.getAuthStatus()
    if (!authStatus.success) {
      return NextResponse.json({ connected: false, error: authStatus.error, known_employees: KNOWN_EMPLOYEES, valid_regions: VALID_REGIONS, needs_reauth: true })
    }
    let expiresIn: number | undefined
    if (authStatus.tokens?.expires_at) {
      expiresIn = Math.floor((new Date(authStatus.tokens.expires_at).getTime() - Date.now()) / 1000)
    }

    // Attempt to fetch live employees and regions from Xero
    let xeroEmployees: string[] = KNOWN_EMPLOYEES
    let xeroRegions: string[] = VALID_REGIONS
    try {
      const client = await authManager.getAuthenticatedClient()
      if (client) {
        const tenantId = authManager.getTenantId()
        // Employees (Payroll UK)
        const empResp = await client.payrollUKApi.getEmployees(tenantId)
        if (Array.isArray(empResp.body?.employees)) {
          xeroEmployees = empResp.body.employees.map((e: any) => [e.firstName, e.middleNames, e.lastName].filter(Boolean).join(' ').trim()).filter(Boolean)
        }
        // Regions via Accounting Tracking Category named "Region"
        const trackResp = await client.accountingApi.getTrackingCategories(tenantId)
        const regionCat = trackResp.body?.trackingCategories?.find((c: any) => c.name?.toLowerCase() === 'region')
        if (regionCat?.options) {
          xeroRegions = regionCat.options.map((o: any) => o.name).filter(Boolean)
        }
      }
    } catch {}

    return NextResponse.json({ connected: true, organization_name: authStatus.organization_name, tenant_id: authStatus.tenant_id, known_employees: xeroEmployees, valid_regions: xeroRegions, expires_in: expiresIn, enhanced_security: true })
  } catch (error: any) {
    return NextResponse.json({ connected: false, error: error?.message || 'Unknown error', known_employees: KNOWN_EMPLOYEES, valid_regions: VALID_REGIONS, enhanced_security: true })
  }
}


