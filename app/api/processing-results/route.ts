import { NextResponse } from 'next/server'
import { storage } from '@server/storage'

export async function GET() {
  try {
    const results = await storage.getAllProcessingResults()
    return NextResponse.json(results)
  } catch (error: any) {
    return NextResponse.json({ message: error?.message || 'Failed to fetch results' }, { status: 500 })
  }
}


