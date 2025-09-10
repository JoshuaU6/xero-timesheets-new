import { NextRequest, NextResponse } from 'next/server'
import { settingsManager } from '@server/settings-manager'

export async function POST(req: NextRequest) {
  try {
    const { settingsJson } = await req.json()
    if (!settingsJson || typeof settingsJson !== 'string') {
      return NextResponse.json({ success: false, error: 'Settings JSON string is required' }, { status: 400 })
    }
    const imported = settingsManager.importSettings(settingsJson)
    if (!imported) {
      return NextResponse.json({ success: false, error: 'Invalid settings format or failed validation' }, { status: 400 })
    }
    return NextResponse.json({ success: true, settings: settingsManager.getSettings(), message: 'Settings imported successfully' })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: 'Failed to import settings' }, { status: 500 })
  }
}


