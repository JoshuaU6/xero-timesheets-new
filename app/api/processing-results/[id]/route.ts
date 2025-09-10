import { NextResponse } from 'next/server'
import { storage } from '@server/storage'

export async function GET(_: Request, { params }: { params: { id: string } }) {
  try {
    const result = await storage.getProcessingResult(params.id)
    if (!result) return NextResponse.json({ message: 'Processing result not found' }, { status: 404 })
    return NextResponse.json(result)
  } catch (error: any) {
    return NextResponse.json({ message: error?.message || 'Failed to fetch result' }, { status: 500 })
  }
}


