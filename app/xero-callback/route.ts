import { NextRequest, NextResponse } from 'next/server'
import { authManager } from '@server/auth-manager'
import { cookies } from 'next/headers'
import crypto from 'crypto'

export async function GET(req: NextRequest) {
  try {
    const url = req.nextUrl
    if (url.searchParams.get('error')) {
      throw new Error(`OAuth error: ${url.searchParams.get('error')}`)
    }
    const code = url.searchParams.get('code')
    if (!code) {
      throw new Error('No authorization code received')
    }
    const state = url.searchParams.get('state') || undefined
    const result = await authManager.handleCallback(url.toString(), state)
    if (!result.success) {
      throw new Error(result.error || 'Callback processing failed')
    }
    // Create or read session id cookie
    const cookieStore = cookies()
    let sid = cookieStore.get('sid')?.value
    if (!sid) {
      sid = crypto.randomBytes(16).toString('hex')
    }

    // Persist tokens for this session (DB-backed if available)
    await authManager.saveTokensForSession(sid)

    const body = `<!DOCTYPE html><html><head><title>Xero Connected</title></head><body style="font-family: Arial, sans-serif; text-align: center; margin-top: 100px;"><h1>🔐 Xero Authorization Successful!</h1><p><strong>Organization:</strong> ${result.organization_name || 'Connected'}</p><p>Enhanced security validation passed. You can now close this window and return to the application.</p><script>setTimeout(() => window.close(), 3000);</script></body></html>`
    const res = new NextResponse(body, { headers: { 'Content-Type': 'text/html' } })
    // Set/refresh sid cookie on response
    res.cookies.set('sid', sid, { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 60 * 60 * 24 * 365 })
    return res
  } catch (error: any) {
    const body = `<!DOCTYPE html><html><head><title>Xero Connection Failed</title></head><body style="font-family: Arial, sans-serif; text-align: center; margin-top: 100px;"><h1>❌ Authorization Failed</h1><p>Error: ${error?.message || 'Unknown error'}</p><p>Please try connecting again.</p></body></html>`
    return new NextResponse(body, { status: 500, headers: { 'Content-Type': 'text/html' } })
  }
}


