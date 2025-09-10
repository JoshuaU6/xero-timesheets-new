import { NextResponse } from 'next/server'
import { settingsManager } from '@server/settings-manager'

export async function POST() {
  try {
    settingsManager.resetSettings()
    return NextResponse.json({ success: true, settings: settingsManager.getSettings(), message: 'Settings reset to defaults successfully' })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: 'Failed to reset settings' }, { status: 500 })
  }
}


