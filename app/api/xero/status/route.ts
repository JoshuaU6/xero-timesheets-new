import { NextRequest, NextResponse } from 'next/server'
import { authManager } from '@server/auth-manager'
import { cookies } from 'next/headers'
import crypto from 'crypto'

const KNOWN_EMPLOYEES = [
  "Charlotte Danes",
  "Chelsea Serati",
  "Jack Allan",
  "Andrew Dwyer",
  "Pamela Beesly",
  "Dwight K Schrute",
]
const VALID_REGIONS = ["Eastside", "South", "North"]

export async function GET(req: NextRequest) {
  try {
    // Attempt to restore per-session tokens
    const sid = cookies().get('sid')?.value
    if (sid) {
      await authManager.restoreTokensForSession(sid)
    }
    // Try decrypting cookie token if present
    const xat = cookies().get('xat')?.value
    if (xat) {
      try {
        const buf = Buffer.from(xat, 'base64')
        const iv = buf.subarray(0, 12)
        const tag = buf.subarray(12, 28)
        const enc = buf.subarray(28)
        const secret = process.env.XERO_COOKIE_SECRET || process.env.XERO_CLIENT_SECRET || 'fallback-secret'
        const key = crypto.createHash('sha256').update(secret).digest()
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAuthTag(tag)
        const dec = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
        const payload = JSON.parse(dec)
        if (payload?.tokens) {
          authManager.hydrate(payload.tokens, payload.tenantId, payload.organizationName)
        }
      } catch {}
    }

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


