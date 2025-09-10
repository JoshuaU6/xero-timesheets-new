import { NextRequest, NextResponse } from 'next/server'
import { settingsManager, SettingsSchema } from '@server/settings-manager'

export async function GET() {
  try {
    const settings = settingsManager.getSettings()
    return NextResponse.json({ success: true, settings, message: 'Settings retrieved successfully' })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: 'Failed to retrieve settings' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const updateData = await req.json()
    const partial = SettingsSchema.deepPartial().safeParse(updateData)
    if (!partial.success) {
      return NextResponse.json({ success: false, error: 'Invalid settings format', details: partial.error.errors }, { status: 400 })
    }
    const updated = settingsManager.updateSettings(updateData)
    if (!updated) {
      return NextResponse.json({ success: false, error: 'Failed to update settings - validation failed' }, { status: 400 })
    }
    return NextResponse.json({ success: true, settings: settingsManager.getSettings(), message: 'Settings updated successfully' })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: 'Failed to update settings' }, { status: 500 })
  }
}


