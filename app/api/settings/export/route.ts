import { NextResponse } from 'next/server'
import { settingsManager } from '@server/settings-manager'

export async function GET() {
  try {
    const settingsJson = settingsManager.exportSettings()
    return new NextResponse(settingsJson, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="timesheet-settings.json"',
      }
    })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: 'Failed to export settings' }, { status: 500 })
  }
}


