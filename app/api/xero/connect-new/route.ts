import { NextResponse } from 'next/server'
import { authManager } from '@server/auth-manager'

export async function GET() {
  try {
    const { url, state } = await authManager.generateAuthUrl()
    return NextResponse.json({ consentUrl: url, state })
  } catch (error: any) {
    return NextResponse.json({ message: 'Failed to initiate secure Xero connection', error: error?.message || 'Unknown error' }, { status: 500 })
  }
}


