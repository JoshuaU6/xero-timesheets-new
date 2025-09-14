import { NextResponse } from 'next/server'
import { authManager } from '@server/auth-manager'

export async function POST() {
  try {
    await authManager.clearAuth()
    const res = NextResponse.json({ success: true })
    // Clear auth cookies
    res.cookies.set('sid', '', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 0 })
    res.cookies.set('xat', '', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 0 })
    return res
  } catch (e: any) {
    return NextResponse.json({ success: false, message: e?.message || 'Failed to disconnect' }, { status: 500 })
  }
}


